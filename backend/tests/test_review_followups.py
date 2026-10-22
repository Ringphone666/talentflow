"""评审后联调中补充的行为：查看不留痕、关闭现场入口、硬性条件来源、对比导出、结论同步等。"""
import json

import pytest
from fastapi import HTTPException

from backend.app.core.database import SessionLocal
from backend.app.interview.models import ListeningSession, Question, SpeechCapture
from backend.app.matching.views import failure_reason

from . import support

HR = support.staff("hr_admin", "hr")
INTERVIEWER = support.staff("interviewer", "interviewer")
REVIEWER = support.staff("report_reviewer", "report_reviewer")


def listening_only_candidate(client, created, code="FOLLOW-LISTEN"):
    batch = support.create_batch(client, created, code, mode="listening_only")
    candidate = support.create_candidate(client, created, batch["id"], "联调旁听候选人")
    return batch, candidate


def test_viewing_the_listening_page_leaves_no_record_and_does_not_block_deletion(client, created):
    batch, candidate = listening_only_candidate(client, created, "FOLLOW-VIEW")
    state = client.get(f"/api/listening/{candidate['id']}", headers=INTERVIEWER).json()
    assert state["id"] is None and state["status"] == "ready" and state["mode"] == "standalone"
    assert state["prepared_questions"] == [] and state["comprehensive_report"] is None
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=candidate["id"]).count() == 0
    assert client.delete(f"/api/candidates/{candidate['id']}", headers=HR).status_code == 200


def test_prepared_questions_alone_do_not_block_deletion_but_a_started_session_does(client, created):
    batch, first = listening_only_candidate(client, created, "FOLLOW-DRAFT")
    assert client.post(f"/api/listening/{first['id']}/prepare", headers=INTERVIEWER).status_code == 200
    # 只准备了提问建议：候选人可以删除，草稿随之清除。
    assert client.delete(f"/api/candidates/{first['id']}", headers=HR).status_code == 200
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=first["id"]).count() == 0

    second = support.create_candidate(client, created, batch["id"], "已开始旁听的候选人")
    started = client.post(f"/api/listening/{second['id']}/start", headers=INTERVIEWER,
                          json={"consented": True, "candidate_confirmed": True})
    assert started.status_code == 200
    assert client.get(f"/api/listening/{second['id']}", headers=INTERVIEWER).json()["consent_record"]["method_code"] == "onsite_attested"
    refused = client.delete(f"/api/candidates/{second['id']}", headers=HR)
    assert refused.status_code == 409


def test_finishing_before_starting_is_refused_without_creating_anything(client, created):
    _, candidate = listening_only_candidate(client, created, "FOLLOW-FINISH")
    assert client.post(f"/api/listening/{candidate['id']}/finish", headers=INTERVIEWER).status_code == 409
    assert client.post(f"/api/listening/{candidate['id']}/suggest", headers=INTERVIEWER).status_code == 409
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=candidate["id"]).count() == 0


def test_findings_that_cannot_be_located_are_dropped_instead_of_failing(client, created, monkeypatch):
    from backend.app.interview import listening_intelligence as intelligence

    _, candidate = listening_only_candidate(client, created, "FOLLOW-DROP")
    cid = candidate["id"]
    assert client.post(f"/api/listening/{cid}/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    with SessionLocal() as db:
        db.add(SpeechCapture(id="follow-drop", owner="interviewer", role="interviewer", kind="listening", target_id=cid,
                             status="completed", transcript="请介绍一次招聘项目。我负责了销售团队扩招，三个月招聘了十五人。"))
        db.commit()
    assert client.post(f"/api/listening/{cid}/capture", headers=INTERVIEWER, json={"capture_id": "follow-drop"}).status_code == 200
    # 真实采集时，录音在取得凭据时就被记为“混合对话”（没有区分发言人）。
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=cid).one()
        context = intelligence.context(db, session)
        context.speakers = json.dumps({"follow-drop": {"speaker": "dialogue", "actor": "interviewer", "time": 0}})
        db.commit()
    monkeypatch.setattr(intelligence.text_models, "enabled", lambda: True)

    def reply(model, task, data, schema, **kwargs):
        # 第一条引用存在但没有说明回答归属；第二条引用是编造的。校正请求也返回同样的内容。
        return intelligence.CombinedReport(findings=[
            intelligence.CombinedFinding(dimension="岗位专业能力", capture_id="follow-drop", answer_excerpt="三个月招聘了十五人",
                                         analysis="说明了招聘规模", status="新增证据待复核"),
            intelligence.CombinedFinding(dimension="沟通表达", capture_id="follow-drop", answer_excerpt="原文中没有的话",
                                         analysis="无法核对", status="新增证据待复核"),
        ])

    monkeypatch.setattr(intelligence.text_models, "request_json", reply)
    finished = client.post(f"/api/listening/{cid}/finish", headers=INTERVIEWER)
    assert finished.status_code == 200, finished.text
    report = finished.json()
    assert [item["dimension"] for item in report["findings"]] == ["岗位专业能力"]
    assert report["discarded_findings"] == 1
    kept = report["findings"][0]
    assert kept["speaker_inferred"] is True and kept["evidence_sufficient"] is False and "核对录音" in kept["speaker_basis"]
    with SessionLocal() as db:
        db.query(SpeechCapture).filter_by(id="follow-drop").delete()
        db.commit()


def test_closing_an_onsite_entry_ends_sessions_started_through_it(client, created):
    batch = support.create_batch(client, created, "FOLLOW-ONSITE")
    support.publish_questions(client, batch["id"], count=2)
    candidate = support.create_candidate(client, created, batch["id"], "现场候选人")
    entry = client.post(f"/api/batches/{batch['id']}/onsite-entries", headers=HR,
                        json={"consent_attested": True, "hours": 1}).json()
    bearer = {"Authorization": f"Bearer {entry['entry_token']}"}
    session = client.post("/api/onsite/sessions", headers=bearer, json={"candidate_id": candidate["id"]}).json()
    candidate_bearer = {"Authorization": f"Bearer {session['access_token']}"}
    assert client.get("/api/interviews/me", headers=candidate_bearer).status_code == 200
    assert client.delete(f"/api/onsite-entries/{entry['id']}", headers=HR).status_code == 200
    closed = client.get("/api/interviews/me", headers=candidate_bearer)
    assert closed.status_code == 401 and "现场入口已关闭" in closed.json()["detail"]


def test_published_questions_cannot_be_reviewed_again(client, created):
    batch = support.create_batch(client, created, "FOLLOW-QUESTION")
    support.publish_questions(client, batch["id"], count=2)
    with SessionLocal() as db:
        question = db.query(Question).filter_by(batch_id=batch["id"], status="published").first()
        question_id = question.id
    refused = client.post(f"/api/questions/{question_id}/review", headers=support.staff("question_reviewer", "reviewer"),
                          json={"approved": False, "comment": "想退回已发布的题目"})
    assert refused.status_code == 409
    with SessionLocal() as db:
        assert db.get(Question, question_id).status == "published"


def test_failure_reasons_hide_exception_names_and_server_paths():
    assert failure_reason("FileNotFoundError: 脱敏材料不存在：C:\\data\\redacted\\a.txt") == "脱敏材料不存在：（文件路径）"
    assert failure_reason("AI分析未完成：服务未返回有效结果") == "AI分析未完成：服务未返回有效结果"
    assert failure_reason("岗位甲：AI分析未完成：超时；JOB-1：TimeoutError: timed out") == "岗位甲：AI分析未完成：超时；JOB-1：timed out"
    assert failure_reason("") == "处理未完成，请重试"


def test_service_status_reports_missing_keys_instead_of_enabled(monkeypatch):
    from backend.app.interview import common, text_models

    # 正式环境、服务已启用，但没有配置密钥（全新安装时的默认情况）。
    monkeypatch.setenv("TALENTFLOW_RUNTIME_PROFILE", "production")
    monkeypatch.setenv("TALENTFLOW_TEXT_MODE", "live")
    monkeypatch.setenv("TALENTFLOW_ASR_MODE", "doubao")
    monkeypatch.setattr(common, "TEST_RUNTIME", False)
    for name in ("TALENTFLOW_LLM_API_KEY", "TALENTFLOW_MATCH_LLM_API_KEY", "TALENTFLOW_MODEL_API_KEY", "DOUBAO_ASR_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    status = text_models.status()
    assert (status["mode"], status["asr"], status["retrieval"]["mode"]) == ("unavailable", "unavailable", "unavailable")
    # 页面上显示不可用；已有旁听记录仍按配置的转写方式查找，不因密钥暂时缺失而看不到。
    assert common.asr_available_mode() == "unavailable" and common.asr_runtime_mode() == "doubao"
    for provider, name in (("talentflow", "TALENTFLOW_LLM_API_KEY"), ("doubao", "DOUBAO_ASR_API_KEY")):
        with pytest.raises(HTTPException) as error:
            text_models.get_key(provider)
        assert error.value.status_code == 503 and name in error.value.detail and "未配置" in error.value.detail

    monkeypatch.setenv("TALENTFLOW_LLM_API_KEY", "synthetic-test")
    monkeypatch.setenv("DOUBAO_ASR_API_KEY", "synthetic-test")
    status = text_models.status()
    assert (status["mode"], status["asr"], status["retrieval"]["mode"]) == ("live", "doubao", "live")
    assert common.asr_available_mode() == "doubao" and text_models.get_key() == "synthetic-test"


def test_candidates_cannot_start_while_speech_transcription_is_unavailable(client, created, monkeypatch):
    from backend.app.interview import common

    batch = support.create_batch(client, created, "FOLLOW-NOASR")
    support.publish_questions(client, batch["id"], count=2)
    person = support.create_candidate(client, created, batch["id"], "无语音服务候选人")
    h = support.candidate(person["code"])
    interview = support.my_interview(client, h)
    assert client.put("/api/interviews/me/profile", headers=h, json=support.PROFILE).status_code == 200
    assert client.post(f"/api/interviews/{interview['id']}/consent", headers=h,
                       json={"consented": True, "notice_version": interview["available_consent_version"]}).status_code == 200

    # 正式环境启用了语音转写，但没有配置密钥：录音转不成文字，不让候选人开始。
    monkeypatch.setattr(common, "TEST_RUNTIME", False)
    monkeypatch.setenv("TALENTFLOW_ASR_MODE", "doubao")
    monkeypatch.delenv("DOUBAO_ASR_API_KEY", raising=False)
    assert support.my_interview(client, h)["asr_mode"] == "unavailable"
    refused = client.post(f"/api/interviews/{interview['id']}/mic-check", headers=h, json=support.MIC)
    assert refused.status_code == 503 and "语音转写服务尚未配置" in refused.json()["detail"]
    assert client.post(f"/api/interviews/{interview['id']}/start", headers=h).status_code == 503
    ticket = client.post("/api/speech/tickets", headers=h,
                         json={"kind": "mic_check", "target_id": interview["id"], "consented": True})
    assert ticket.status_code == 503 and "DOUBAO_ASR_API_KEY" in ticket.json()["detail"]
    assert support.my_interview(client, h)["status"] == "mic_check"

    # 配置密钥后可以继续。
    monkeypatch.setenv("DOUBAO_ASR_API_KEY", "synthetic-test")
    assert support.my_interview(client, h)["asr_mode"] == "doubao"
    assert client.post(f"/api/interviews/{interview['id']}/mic-check", headers=h, json=support.MIC).status_code == 200
    assert support.my_interview(client, h)["status"] == "ready"


def test_audit_details_use_page_wording_instead_of_internal_field_names():
    from backend.app.system.audits import summarize

    call = {"model": "chat-x", "status": "调用成功", "reason": "已校验", "embedding": {"model": "e", "status": "ok", "dimensions": 8}}
    assert summarize("", json.dumps(call)) == "模型：chat-x；状态：调用成功；说明：已校验；向量检索：模型 e，状态 ok，向量维度 8"
    material = {"education": {"label": "教育经历", "value": "某大学 本科", "status": "人工已确认", "evidence": "", "source_file": "a.pdf", "location": "第1页"},
                "skills": {"label": "专业技能", "value": "", "status": ""}}
    assert summarize("", json.dumps(material)) == "教育经历：某大学 本科（人工已确认）"
    job = {"id": "JOB-1", "name": "岗位甲", "dimensions": [{"name": "专业能力", "weight": 60}], "is_active": True}
    assert summarize("", json.dumps(job)) == "岗位名称：岗位甲；能力标签：专业能力"
    assert summarize("", "不是JSON的旧记录") == "不是JSON的旧记录"


def test_comparison_lists_people_without_reports_and_exports_confirmed_listening_reports(client, created):
    batch, candidate = listening_only_candidate(client, created, "FOLLOW-COMPARE")
    waiting = support.create_candidate(client, created, batch["id"], "尚无报告的候选人")
    cid = candidate["id"]
    assert client.post(f"/api/listening/{cid}/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    with SessionLocal() as db:
        db.add(SpeechCapture(id="follow-compare", owner="interviewer", role="interviewer", kind="listening", target_id=cid,
                             status="completed", transcript="我负责了销售团队扩招，三个月招聘了十五人。"))
        db.commit()
    assert client.post(f"/api/listening/{cid}/capture", headers=INTERVIEWER, json={"capture_id": "follow-compare"}).status_code == 200
    assert client.post(f"/api/listening/{cid}/speaker", headers=INTERVIEWER,
                       json={"capture_id": "follow-compare", "speaker": "candidate"}).status_code == 200
    assert client.post(f"/api/listening/{cid}/finish", headers=INTERVIEWER).status_code == 200

    compared = client.get(f"/api/comparison?batch_id={batch['id']}", headers=REVIEWER).json()
    assert [item["candidate"]["id"] for item in compared["items"]] == [cid]
    assert compared["default_selected"] == [cid]
    assert [(item["id"], item["report_status"]) for item in compared["without_report"]] == [(waiting["id"], "not_generated")]
    # 综合报告确认前不能导出；确认后可以导出，没有AI面试评分的候选人如实显示。
    assert client.get(f"/api/comparison/export?batch_id={batch['id']}", headers=REVIEWER).status_code == 409
    confirmed = client.post(f"/api/listening/{cid}/report/confirm", headers=REVIEWER, json={"reason": "已核对录音"}).json()
    assert confirmed["status"] == "confirmed" and "library_sync" in confirmed
    exported = client.get(f"/api/comparison/export?batch_id={batch['id']}", headers=REVIEWER)
    assert exported.status_code == 200
    text = support.document_xml(exported.content)
    assert "联调旁听候选人" in text and "没有六维评分" in text and "None%" not in text
    assert "硬指标" in text and "尚无报告的候选人" not in text
    listed = client.get(f"/api/comprehensive-reports?batch_id={batch['id']}", headers=REVIEWER).json()
    assert listed["items"][0]["updated_at"]
    with SessionLocal() as db:
        db.query(SpeechCapture).filter_by(id="follow-compare").delete()
        db.commit()
