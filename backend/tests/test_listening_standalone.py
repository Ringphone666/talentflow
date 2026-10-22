"""不做第一阶段AI面试、直接进行人工面试旁听：依据简历和岗位要求准备提问、现场告知同意、生成综合报告。"""
from types import SimpleNamespace

import pytest

from backend.app.core.database import SessionLocal
from backend.app.interview import common, standards
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview.models import Interview, ListeningSession, User

from . import support

HR = support.staff("hr_admin", "hr")
INTERVIEWER = support.staff("interviewer", "interviewer")
REVIEWER = support.staff("report_reviewer", "report_reviewer")
ANSWER = "我负责过三年的招聘工作，曾独立完成校园招聘计划的编制和执行。"


@pytest.fixture
def standalone(client, created):
    """仅人工面试旁听的批次和一名候选人。"""
    batch = support.create_batch(client, created, "LISTEN-ONLY-1", "仅旁听测试批次", mode="listening_only",
                                 recruitment_type="内部竞聘")
    person = support.create_candidate(client, created, batch["id"], "旁听候选人", create_login=True)
    return SimpleNamespace(batch=batch, person=person, id=person["id"], url=f"/api/listening/{person['id']}")


def start(client, target, **body):
    return client.post(target.url + "/start", headers=INTERVIEWER, json=body)


def answered(client, target, capture_id="standalone-capture", transcript=ANSWER):
    assert start(client, target, consented=True, candidate_confirmed=True).status_code == 200
    support.add_capture(capture_id, target.id, transcript)
    assert client.post(target.url + "/speaker", headers=INTERVIEWER,
                       json={"capture_id": capture_id, "speaker": "candidate"}).status_code == 200
    return capture_id


def test_listening_only_candidate_has_no_interview_record_or_login(client, standalone):
    batch, person = standalone.batch, standalone.person
    assert batch["mode"] == "listening_only" and batch["status"] == "active" and batch["accepts_candidates"] is True
    assert person["code"] == "LISTEN-ONLY-1-001" and person["batch_mode"] == "listening_only"
    # 即使要求生成登录凭据，仅旁听的候选人也不建立账号和面试记录。
    assert person["credentials"] is None and person["has_login"] is False and person["login_username"] == ""
    assert person["interview_status"] == "not_required" and person["listening_status"] == "not_started"
    with SessionLocal() as db:
        assert db.query(Interview).filter_by(candidate_id=person["id"]).count() == 0
        assert db.query(User).filter_by(candidate_id=person["id"]).count() == 0
    assert client.post(f"/api/candidates/{person['id']}/password", headers=HR).status_code == 409
    assert client.post("/api/auth/login", json={"username": person["code"], "password": "Any-Pass-1!"}).status_code == 401
    assert client.get("/api/reports", headers=REVIEWER, params={"batch_id": batch["id"]}).json() == []
    # 已有候选人的批次不能改成另一种面试方式。
    changed = client.put(f"/api/batches/{batch['id']}", headers=HR, json={
        "code": batch["code"], "name": batch["name"], "recruitment_type": batch["recruitment_type"],
        "job_id": batch["job_id"], "mode": "ai_interview"})
    assert changed.status_code == 409


def test_candidate_list_and_state_work_without_first_stage(client, standalone):
    for role in ("hr_admin", "business_user", "question_reviewer", "candidate"):
        assert client.get("/api/listening/candidates", headers=support.staff(role, role)).status_code == 403
        assert client.get(standalone.url, headers=support.staff(role, role)).status_code == 403
    people = client.get("/api/listening/candidates", headers=INTERVIEWER, params={"batch_id": standalone.batch["id"]}).json()
    assert len(people) == 1 and people[0].items() >= {
        "id": standalone.id, "code": "LISTEN-ONLY-1-001", "name": "旁听候选人", "batch_id": standalone.batch["id"],
        "batch_name": "仅旁听测试批次", "job_name": standalone.batch["job_name"], "library_person_id": None,
        "interview_status": "not_required", "stage_one": None, "resume_status": "not_requested",
        "listening_status": "ready", "comprehensive_status": "not_generated"}.items()
    everyone = client.get("/api/listening/candidates", headers=REVIEWER).json()
    seeded = next(item for item in everyone if item["code"] == "CAND-2026-002")
    assert seeded["stage_one"]["status"] == "confirmed" and seeded["interview_status"] == "completed"
    assert next(item for item in everyone if item["code"] == "CAND-2026-001")["stage_one"] is None
    assert client.get("/api/listening/candidates?batch_id=0", headers=INTERVIEWER).status_code == 422
    # 查看候选人列表不建立旁听记录。
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=standalone.id).count() == 0

    state = client.get(standalone.url, headers=INTERVIEWER).json()
    assert state["mode"] == "standalone" and state["stage_one"] is None and state["status"] == "ready"
    assert state["candidate"] == {"id": standalone.id, "code": "LISTEN-ONLY-1-001", "name": "旁听候选人", "library_person_id": None}
    assert state["batch"] == {"id": standalone.batch["id"], "code": "LISTEN-ONLY-1", "name": "仅旁听测试批次", "mode": "listening_only"}
    assert state["job"]["name"] == standalone.batch["job_name"] and state["job"]["duties"] and state["job"]["requirements"]
    assert state["hard_indicators"]["available"] is False and state["hard_indicators"]["reason"]
    assert state["prepared_questions"] == [] and state["suggestions"] == [] and state["transcript"] == [] and state["captures"] == []
    assert state["consent_record"] == {} and state["prior_consent_valid"] is False
    assert state["comprehensive_report"] is None and state["comprehensive_report_meta"]["status"] == "not_generated"
    assert state["notice_version"] == intelligence.current_notice()[0] and state["notice_text"]
    assert client.get("/api/listening/999999", headers=INTERVIEWER).status_code == 404


def test_questions_can_be_prepared_before_speech_service_is_configured(client, standalone, monkeypatch):
    monkeypatch.setattr(common, "TEST_RUNTIME", False)
    state = client.get(standalone.url, headers=INTERVIEWER)
    assert state.status_code == 200 and state.json()["asr_mode"] == "unavailable" and state.json()["status"] == "ready"
    # 只是查看不建立旁听记录，候选人仍然可以调整或删除。
    assert state.json()["id"] is None
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=standalone.id).count() == 0
    prepared = client.post(standalone.url + "/prepare", headers=INTERVIEWER)
    assert prepared.status_code == 200 and len(prepared.json()["prepared_questions"]) == 4
    created_id = client.get(standalone.url, headers=INTERVIEWER).json()["id"]
    assert created_id is not None
    # 没有语音服务时不能开始旁听，也不提供任何模拟转写。
    assert start(client, standalone, consented=True, candidate_confirmed=True).status_code == 503
    assert client.get(standalone.url, headers=INTERVIEWER).json()["status"] == "ready"
    monkeypatch.undo()
    # 语音服务配置好以后继续使用同一条旁听记录，已准备的提问保留。
    ready = client.get(standalone.url, headers=INTERVIEWER).json()
    assert ready["asr_mode"] == "mock" and ready["id"] == created_id
    assert ready["prepared_questions"] == prepared.json()["prepared_questions"]
    assert start(client, standalone, consented=True, candidate_confirmed=True).status_code == 200
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=standalone.id).count() == 1


def test_prepared_questions_can_be_reviewed_before_listening_starts(client, standalone):
    assert client.post(standalone.url + "/prepare", headers=HR).status_code == 403
    mark = support.audit_mark(client)
    questions = client.post(standalone.url + "/prepare", headers=INTERVIEWER).json()["prepared_questions"]
    assert [item["id"] for item in questions] == [1, 2, 3, 4]
    assert len({item["dimension"] for item in questions}) == 4 and len({item["text"] for item in questions}) == 4
    assert all(item["status"] == "pending" and item["reason"] and item["resume_excerpt"] == "" for item in questions)
    assert [item["action"] for item in support.audits_since(client, mark)] == ["listening_questions_prepared"]

    def act(**body):
        return client.post(standalone.url + "/suggestions", headers=INTERVIEWER, json={"source": "prepared", **body})

    assert act(suggestion_id=1, action="adopted").status_code == 200
    assert act(suggestion_id=2, action="ignored").status_code == 200
    edited = act(suggestion_id=3, action="edited", edited_text=" 请说明你如何向不同部门解释同一项人事政策。 ")
    assert edited.status_code == 200
    rows = {item["id"]: item for item in edited.json()["prepared_questions"]}
    assert rows[1]["status"] == "adopted" and rows[2]["status"] == "ignored" and rows[4]["status"] == "pending"
    # 修改后的提问按修改后的文字采用。
    assert rows[3]["status"] == "adopted" and rows[3]["edited"] is True
    assert rows[3]["text"] == "请说明你如何向不同部门解释同一项人事政策。"
    assert act(suggestion_id=4, action="edited", edited_text="请说明你的婚姻和生育计划。").status_code == 422
    assert act(suggestion_id=4, action="edited", edited_text="  ").status_code == 422
    assert act(suggestion_id=9, action="adopted").status_code == 404
    assert act(suggestion_id=4, action="postponed").status_code == 422
    assert client.post(standalone.url + "/suggestions", headers=INTERVIEWER,
                       json={"source": "imported", "suggestion_id": 4, "action": "adopted"}).status_code == 422
    # 现场补充提问只在旁听进行中处理。
    assert client.post(standalone.url + "/suggestions", headers=INTERVIEWER,
                       json={"suggestion_id": 1, "action": "adopted"}).status_code == 409
    saved = client.get(standalone.url, headers=INTERVIEWER).json()["prepared_questions"]
    assert {item["id"]: item["status"] for item in saved} == {1: "adopted", 2: "ignored", 3: "adopted", 4: "pending"}
    blocks = client.get("/api/sensitive-blocks", headers=HR).json()
    assert blocks[0]["source_type"] == "listening_edited_suggestion" and "婚姻" in blocks[0]["content"]


def test_listening_needs_consent_recorded_by_the_interviewer(client, standalone):
    mark = support.audit_mark(client)
    # 候选人没有在系统内同意过采集：必须由面试官确认已当面告知并取得同意。
    refused = [start(client, standalone), start(client, standalone, consented=False, candidate_confirmed=True),
               start(client, standalone, candidate_confirmed=True), start(client, standalone, consented=True),
               start(client, standalone, consented=True, candidate_confirmed=False)]
    assert [response.status_code for response in refused] == [409] * 5
    state = client.get(standalone.url, headers=INTERVIEWER).json()
    assert state["status"] == "ready" and state["consent_record"] == {}
    assert client.post(standalone.url + "/suggest", headers=INTERVIEWER).status_code == 409
    assert client.post(standalone.url + "/finish", headers=INTERVIEWER).status_code == 409
    assert support.audits_since(client, mark) == []
    for role in ("hr_admin", "business_user", "candidate"):
        assert client.post(standalone.url + "/start", headers=support.staff(role, role),
                           json={"consented": True, "candidate_confirmed": True}).status_code == 403

    started = start(client, standalone, consented=True, candidate_confirmed=True)
    assert started.status_code == 200 and started.json() == {"ok": True, "mode": "standalone"}
    state = client.get(standalone.url, headers=INTERVIEWER).json()
    record = state["consent_record"]
    assert state["status"] == "running" and state["mode"] == "standalone" and state["stage_one"] is None
    assert record["method"] == "面试官现场告知并取得同意" == intelligence.ONSITE_METHOD
    assert record["accepted"] is True and record["recorded_by"] == "interviewer" and record["interview_id"] is None
    assert record["candidate_id"] == standalone.id and record["candidate_code"] == "LISTEN-ONLY-1-001"
    assert record["notice_version"] == intelligence.current_notice()[0] and record["notice_text"] == intelligence.current_notice()[1]
    assert record["audio"] is True and record["video"] is False and record["confirmed_at"]
    assert state["prior_consent_valid"] is False
    audits = support.audits_since(client, mark)
    assert [item["action"] for item in reversed(audits)] == ["listening_consent_attested", "listening_started"]
    assert all(item["actor"] == "interviewer" and item["target_id"] == str(standalone.id) for item in audits)
    # 继续旁听不重复登记同意，也不改写已有记录。
    assert start(client, standalone, consented=True).status_code == 200
    assert client.get(standalone.url, headers=INTERVIEWER).json()["consent_record"] == record
    assert len(support.audits_since(client, mark)) == 2


def test_standalone_flow_produces_a_comprehensive_report(client, standalone):
    prepared = client.post(standalone.url + "/prepare", headers=INTERVIEWER).json()["prepared_questions"]
    assert client.post(standalone.url + "/suggestions", headers=INTERVIEWER,
                       json={"source": "prepared", "suggestion_id": 2, "action": "adopted"}).status_code == 200
    assert start(client, standalone, consented=True, candidate_confirmed=True).status_code == 200
    support.add_capture("standalone-question", standalone.id, "请介绍一下你做过的招聘工作。")
    support.add_capture("standalone-answer", standalone.id, ANSWER)
    support.add_capture("standalone-unlabelled", standalone.id, "这一段没有标注发言人。")
    support.add_capture("standalone-other", standalone.id, "其他面试官采集的录音。", owner="another-interviewer")

    def label(capture_id, speaker, headers=INTERVIEWER):
        return client.post(standalone.url + "/speaker", headers=headers, json={"capture_id": capture_id, "speaker": speaker})

    assert label("standalone-question", "interviewer").status_code == 200
    # 只有面试官的提问时不推断候选人回答，也不能生成综合报告。
    skipped = client.post(standalone.url + "/suggest", headers=INTERVIEWER).json()
    assert skipped["suggestions"] == [] and skipped["skipped"]
    assert client.post(standalone.url + "/finish", headers=INTERVIEWER).status_code == 409
    assert label("standalone-answer", "unknown").status_code == 200
    assert client.post(standalone.url + "/finish", headers=INTERVIEWER).status_code == 409
    assert label("standalone-other", "candidate").status_code == 403
    assert label("standalone-missing", "candidate").status_code == 403
    assert label("standalone-answer", "candidate", headers=HR).status_code == 403
    assert label("standalone-answer", "candidate").status_code == 200

    suggestions = client.post(standalone.url + "/suggest", headers=INTERVIEWER).json()["suggestions"]
    assert len(suggestions) == 1
    suggestion = suggestions[0]
    assert suggestion["capture_id"] == "standalone-answer" and suggestion["answer_excerpt"] in ANSWER
    assert suggestion["stage_one_excerpt"] == "" and suggestion["report_id"] is None and suggestion["report_version"] is None
    assert suggestion["status"] == "pending" and suggestion["speaker_inferred"] is False and suggestion["provisional"] is False
    assert client.post(standalone.url + "/suggest", headers=INTERVIEWER).json()["skipped"] == "没有新增回答证据"
    assert client.post(standalone.url + "/suggestions", headers=INTERVIEWER, json={
        "source": "followup", "suggestion_id": 1, "action": "edited", "edited_text": "请说明校园招聘计划的编制依据。"}).status_code == 200

    finished = client.post(standalone.url + "/finish", headers=INTERVIEWER)
    assert finished.status_code == 200
    report = finished.json()
    assert report["mode"] == "standalone" and report["stage_one"] is None and report["status"] == "pending_review"
    assert report["decision"] is None and "人工复核" in report["disclaimer"]
    assert report["stage_one_evaluations"] == [] and report["stage_one_qa_records"] == [] and report["stage_one_match_analysis"] == {}
    assert "未进行第一阶段" in report["stage_one_summary"]
    # 未标注发言人的录音和其他人采集的录音不进入证据。
    assert [(item["id"], item["speaker"]) for item in report["stage_two_evidence"]] == [
        ("standalone-question", "interviewer"), ("standalone-answer", "candidate")]
    assert "2 段" in report["stage_two_summary"] and "1 段" in report["stage_two_summary"]
    assert len(report["findings"]) == 1
    finding = report["findings"][0]
    assert finding["capture_id"] == "standalone-answer" and finding["answer_excerpt"] in ANSWER
    assert finding["stage_one_excerpt"] == "" and finding["human_review_required"] is True and finding["evidence_sufficient"] is True
    assert finding["dimension"] in [item[0] for item in standards.DIMENSIONS] and finding["status"] == "新增证据待复核"
    assert report["adopted_questions"] == ["请说明校园招聘计划的编制依据。", prepared[1]["text"]]
    assert report["job_context"]["name"] == standalone.batch["job_name"]
    assert any("没有第一阶段评分" in risk for risk in report["risks"])

    # 结束后的记录不能被覆盖。
    assert client.post(standalone.url + "/finish", headers=INTERVIEWER).json() == report
    assert start(client, standalone, consented=True, candidate_confirmed=True).status_code == 409
    assert client.post(standalone.url + "/prepare", headers=INTERVIEWER).status_code == 409
    assert client.post(standalone.url + "/suggest", headers=INTERVIEWER).status_code == 409
    assert client.post(standalone.url + "/suggestions", headers=INTERVIEWER,
                       json={"source": "prepared", "suggestion_id": 1, "action": "adopted"}).status_code == 409
    state = client.get(standalone.url, headers=INTERVIEWER).json()
    assert state["status"] == "completed" and state["comprehensive_report"] == report
    assert state["comprehensive_report_meta"]["status"] == "pending_review"
    assert [item["id"] for item in state["captures"]] == ["standalone-question", "standalone-answer", "standalone-unlabelled"]
    listed = client.get("/api/listening/candidates", headers=INTERVIEWER, params={"batch_id": standalone.batch["id"]}).json()
    assert listed[0]["listening_status"] == "completed" and listed[0]["comprehensive_status"] == "pending_review"
    row = client.get("/api/candidates", headers=HR, params={"batch_id": standalone.batch["id"]}).json()[0]
    assert row["listening_status"] == "completed" and row["report_status"] == "not_generated"
    assert client.delete(f"/api/candidates/{standalone.id}", headers=HR).status_code == 409


def test_comprehensive_report_can_be_reviewed_compared_and_exported(client, standalone):
    answered(client, standalone)
    assert client.get(standalone.url + "/report", headers=REVIEWER).status_code == 404
    assert client.get(f"/api/comparison?batch_id={standalone.batch['id']}", headers=REVIEWER).json()["items"] == []
    assert client.post(standalone.url + "/finish", headers=INTERVIEWER).status_code == 200

    report = client.get(standalone.url + "/report", headers=REVIEWER).json()
    assert report["status"] == "pending_review" and report["current_version"] == 1 and report["candidate_id"] == standalone.id
    assert [(v["version"], v["version_type"], v["editor"]) for v in report["versions"]] == [(1, "ai_original", "AI面试智能体")]
    assert report["current_content"]["mode"] == "standalone"
    assert client.get(standalone.url + "/report", headers=support.staff("question_reviewer", "question_reviewer")).status_code == 403

    # 只有综合报告的候选人同样进入候选人对比，第一阶段的内容如实为空。
    comparison = client.get(f"/api/comparison?batch_id={standalone.batch['id']}", headers=REVIEWER).json()
    assert comparison["default_selected"] == [standalone.id] and len(comparison["items"]) == 1
    item = comparison["items"][0]
    assert item["report_id"] is None and item["status"] == "not_generated" and item["match_score"] is None
    assert item["scores"] == {} and item["risks"] == [] and item["candidate"]["code"] == "LISTEN-ONLY-1-001"
    assert item["hard_indicators"]["available"] is False
    assert item["stage_two"]["status"] == "pending_review" and item["stage_two"]["evidence_count"] == 1
    assert item["stage_two"]["findings"] == [{"dimension": report["current_content"]["findings"][0]["dimension"], "status": "新增证据待复核"}]
    # 没有已确认的第一阶段报告时，对比结果不能导出。
    assert client.get(f"/api/comparison/export?batch_id={standalone.batch['id']}", headers=REVIEWER).status_code == 409

    content = dict(report["current_content"], stage_two_summary=report["current_content"]["stage_two_summary"] + " 考官补充：表达清楚。")
    for role in ("interviewer", "hr_admin", "business_user"):
        assert client.put(standalone.url + "/report", headers=support.staff(role, role),
                          json={"content": content, "reason": "越权修改"}).status_code == 403
    assert client.put(standalone.url + "/report", headers=REVIEWER, json={"content": content, "reason": "改"}).status_code == 422
    edited = client.put(standalone.url + "/report", headers=REVIEWER, json={"content": content, "reason": "补充现场评价"})
    assert edited.status_code == 200 and edited.json()["current_version"] == 2 and edited.json()["status"] == "pending_review"
    assert [(v["version"], v["version_type"]) for v in edited.json()["versions"]] == [(1, "ai_original"), (2, "human_edit")]
    assert edited.json()["versions"][0]["content"] == report["current_content"]
    assert edited.json()["current_content"]["stage_two_summary"].endswith("考官补充：表达清楚。")
    assert client.get(standalone.url + "/report/export", headers=REVIEWER).status_code == 409
    assert client.post(standalone.url + "/report/return", headers=REVIEWER, json={"reason": "请补充依据"}).json() == {"ok": True, "status": "returned"}
    assert client.get(standalone.url + "/report/export", headers=REVIEWER).status_code == 409
    assert client.post(standalone.url + "/report/confirm", headers=INTERVIEWER, json={"reason": "越权确认"}).status_code == 403
    # 确认后尝试把结论写入人员库；这名候选人没有关联人员库，如实说明未同步。
    assert client.post(standalone.url + "/report/confirm", headers=REVIEWER, json={"reason": "已核对录音和转写"}).json() == {
        "ok": True, "status": "confirmed", "library_sync": "候选人未关联人员库，面试结论未同步"}
    assert client.put(standalone.url + "/report", headers=REVIEWER, json={"content": content, "reason": "确认后修改"}).status_code == 409

    assert client.get(standalone.url + "/report/export", headers=support.staff("business_user", "business")).status_code == 403
    exported = client.get(standalone.url + "/report/export", headers=REVIEWER)
    assert exported.status_code == 200 and exported.headers["content-type"] == support.DOCX
    assert f"comprehensive-report-{standalone.id}-v2.docx" in exported.headers["content-disposition"]
    text = support.document_xml(exported.content)
    assert "TalentFlow人工面试AI旁听综合报告" in text and "TalentFlowAI面试两阶段综合报告" not in text
    assert "旁听候选人" in text and "LISTEN-ONLY-1-001" in text and "仅旁听测试批次" in text
    assert ANSWER in text and "考官补充：表达清楚。" in text and "已人工确认" not in text and "报告状态" not in text
    # 候选人没有做第一阶段AI面试：章节名称不写“第一阶段”“两阶段”。
    for heading in ("分析依据", "人工面试旁听纪要", "综合分析", "人工面试转写", "候选人回答原文"):
        assert heading in text, heading
    for absent in ("第一阶段AI面试总结", "第二阶段AI旁听纪要", "两阶段综合分析", "第二阶段转写", "第二阶段证据"):
        assert absent not in text, absent

    listed = client.get(f"/api/comprehensive-reports?batch_id={standalone.batch['id']}", headers=REVIEWER).json()
    assert listed["notice"] and len(listed["items"]) == 1
    entry = listed["items"][0]
    assert entry["mode"] == "standalone" and entry["status"] == "confirmed" and entry["current_version"] == 2
    assert entry["stage_one"]["report_id"] is None and entry["stage_one"]["scores"] == {} and entry["stage_one"]["match_score"] is None
    assert entry["stage_two"]["evidence_count"] == 1 and entry["stage_two"]["finding_statuses"]
    assert entry["batch"]["code"] == "LISTEN-ONLY-1" and entry["candidate"]["id"] == standalone.id
    assert client.get("/api/comprehensive-reports", headers=INTERVIEWER).status_code == 200
    assert client.get("/api/comprehensive-reports", headers=support.staff("question_reviewer", "question_reviewer")).status_code == 403
    confirmed = client.get(f"/api/comparison?batch_id={standalone.batch['id']}", headers=REVIEWER).json()["items"][0]
    assert confirmed["stage_two"]["status"] == "confirmed" and confirmed["report_id"] is None


@pytest.fixture
def with_resume(client, created, standalone):
    """候选人关联了人员库中的简历。"""
    batch = support.create_person_batch(client, created, "旁听简历批次", "内聘")
    resume = support.resume_text("简历旁听人", phone="13812345678")
    person = support.import_persons(client, batch["id"], [("简历旁听人.txt", resume.encode("utf-8"))])["imported"][0]
    linked = support.create_candidate(client, created, standalone.batch["id"], "简历旁听人", library_person_id=person["id"])
    return SimpleNamespace(batch=standalone.batch, person=linked, id=linked["id"], url=f"/api/listening/{linked['id']}",
                           library_person_id=person["id"])


def test_resume_and_job_are_the_basis_when_there_is_no_first_stage(client, with_resume, monkeypatch):
    state = client.get(with_resume.url, headers=INTERVIEWER).json()
    resume = state["resume_context"]
    assert state["mode"] == "standalone" and state["candidate"]["library_person_id"] == with_resume.library_person_id
    assert resume["status"] == "ready" and resume["source"] == "人员库"
    assert "三年招聘与人员调配工作" in resume["text"]
    # 简历交给模型前隐去姓名和联系方式。
    assert "简历旁听人" not in resume["text"] and "13812345678" not in resume["text"]
    indicators = state["hard_indicators"]
    assert indicators["available"] is True and indicators["counted_in_score"] is False
    assert {item["key"]: item["value"] for item in indicators["facts"]}["education"] == "本科，人力资源管理专业"
    listed = client.get("/api/listening/candidates", headers=INTERVIEWER, params={"batch_id": with_resume.batch["id"]}).json()
    assert next(item for item in listed if item["id"] == with_resume.id)["resume_status"] == "ready"

    calls = []

    def reply(model, task, data, schema, **kwargs):
        calls.append((task, data, schema))
        if schema is intelligence.PreparedQuestions:
            return schema(questions=[
                {"text": "请介绍你独立负责的一次招聘项目。", "dimension": "岗位专业能力", "reason": "核实招聘经历",
                 "resume_excerpt": "三年招聘与人员调配工作", "job_excerpt": state["job"]["duties"][:12]},
                {"text": "你如何安排校园招聘的时间计划？", "dimension": "逻辑思维", "reason": "核实项目经历",
                 "resume_excerpt": "五年招聘管理经验", "job_excerpt": "岗位资料里没有的内容"},
                {"text": "请说明你的年龄和婚育情况。", "dimension": "职业稳定性", "reason": "不应出现的问题"},
            ])
        if schema is intelligence.SuggestionBatch:
            return schema(suggestions=[{"text": "校园招聘计划的依据是什么？", "reason": "核实简历中的项目", "dimension": "岗位专业能力",
                                        "capture_id": "resume-answer", "answer_excerpt": "曾独立完成校园招聘计划的编制和执行",
                                        "resume_excerpt": "校园招聘项目"}])
        return schema(findings=[{"dimension": "岗位专业能力", "capture_id": "resume-answer",
                                 "answer_excerpt": "我负责过三年的招聘工作", "analysis": "回答与简历中的招聘经历一致。",
                                 "status": "新增证据待复核", "resume_excerpt": "三年招聘与人员调配工作"}])

    monkeypatch.setattr(intelligence.text_models, "enabled", lambda: True)
    monkeypatch.setattr(intelligence.text_models, "request_json", reply)
    prepared = client.post(with_resume.url + "/prepare", headers=INTERVIEWER)
    assert prepared.status_code == 200
    questions = prepared.json()["prepared_questions"]
    task, data, _ = calls[0]
    assert data["resume"]["text"] == resume["text"] and data["job"]["name"] == state["job"]["name"]
    assert data["first_stage"] is None and len(data["dimensions"]) == 6 and "不得编造" in task
    # 定位不到的引用被丢弃、问题保留；涉及个人隐私的问题被拦截。
    assert [item["text"] for item in questions] == ["请介绍你独立负责的一次招聘项目。", "你如何安排校园招聘的时间计划？"]
    assert questions[0]["resume_excerpt"] == "三年招聘与人员调配工作" and questions[0]["job_excerpt"] == state["job"]["duties"][:12]
    assert questions[1]["resume_excerpt"] == "" and questions[1]["job_excerpt"] == ""
    assert client.get("/api/sensitive-blocks", headers=HR).json()[0]["source_type"] == "listening_prepared_question"

    assert start(client, with_resume, consented=True, candidate_confirmed=True).status_code == 200
    support.add_capture("resume-answer", with_resume.id, ANSWER)
    client.post(with_resume.url + "/speaker", headers=INTERVIEWER, json={"capture_id": "resume-answer", "speaker": "candidate"})
    suggestion = client.post(with_resume.url + "/suggest", headers=INTERVIEWER).json()["suggestions"][0]
    task, data, _ = calls[1]
    assert "first_stage_report" not in data and len(data["dimensions"]) == 6
    assert data["resume"]["text"] == resume["text"] and data["job"]["name"] == state["job"]["name"]
    assert data["citation_options"]["stage_one"] == [] and "没有第一阶段" in task
    assert suggestion["resume_excerpt"] == "校园招聘项目" and suggestion["stage_one_excerpt"] == ""
    report = client.post(with_resume.url + "/finish", headers=INTERVIEWER).json()
    assert report["mode"] == "standalone" and report["generation_mode"] == "文本模型分析"
    assert report["findings"][0]["resume_excerpt"] == "三年招聘与人员调配工作"
    assert report["resume_context"]["text"] == resume["text"]
    assert len(calls) == 3


def test_model_may_not_invent_first_stage_or_resume_quotes(client, with_resume, monkeypatch):
    answered(client, with_resume, "resume-answer")
    replies = [{"stage_one_excerpt": "第一阶段回答给出了可定位的行动"}, {"resume_excerpt": "十年海外招聘经验"}]

    def reply(model, task, data, schema, **kwargs):
        extra = replies[0]
        return schema(suggestions=[{"text": "请补充招聘计划的依据。", "reason": "核实", "dimension": "岗位专业能力",
                                    "capture_id": "resume-answer", "answer_excerpt": "我负责过三年的招聘工作", **extra}])

    monkeypatch.setattr(intelligence.text_models, "enabled", lambda: True)
    monkeypatch.setattr(intelligence.text_models, "request_json", reply)
    for _ in range(2):
        assert client.post(with_resume.url + "/suggest", headers=INTERVIEWER).status_code == 502
        assert client.get(with_resume.url, headers=INTERVIEWER).json()["suggestions"] == []
        replies.pop(0)


def test_fixed_analysis_is_only_available_in_test_runtime(client, standalone, monkeypatch):
    from fastapi import HTTPException
    answered(client, standalone)
    monkeypatch.setenv("TALENTFLOW_RUNTIME_PROFILE", "production")
    actor = {"user": "interviewer", "role": "interviewer"}
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=standalone.id).one()
        with pytest.raises(HTTPException) as prepared:
            intelligence.prepare_questions(db, session, actor)
        assert prepared.value.status_code == 503
        for finish in (False, True):
            with pytest.raises(HTTPException) as refused:
                intelligence.generate(db, session, actor, finish=finish)
            assert refused.value.status_code == 503
