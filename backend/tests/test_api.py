from io import BytesIO
from zipfile import ZipFile

import pytest

from backend.app.core import security
from backend.app.core.database import SessionLocal
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview.models import Interview, User

from . import support


def test_health_and_six_dimensions(client, headers):
    support.forget_service_status()
    health = client.get("/api/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok" and "人工复核" in body["message"]
    # 测试环境使用模拟的文本和语音服务；人岗匹配没有配置评分模型时如实显示不可用。
    assert body["text_models"]["mode"] == "mock" and body["text_models"]["asr"] == "mock"
    assert body["matching_models"]["mode"] == "unavailable" and body["matching_models"]["note"]
    assert "key" not in body["matching_models"] and "url" not in body["matching_models"]
    dimensions = client.get("/api/dimensions", headers=headers()).json()
    assert len(dimensions) == 6
    assert sum(item["weight"] for item in dimensions) == 100
    assert all(set(item["rubric"]) == {"0", "1", "2", "3", "4", "5"} for item in dimensions)
    assert client.get("/api/dimensions", headers=headers("candidate", "candidate")).status_code == 200
    assert client.get("/api/dimensions").status_code == 401


def test_candidate_password_login_and_profile(client, headers, created):
    # 工作人员账号不能从应聘者入口登录；不存在的账号和错误密码给出同样的提示。
    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 403
    assert client.post("/api/auth/login", json={"username": "no-such-candidate", "password": "wrong"}).status_code == 401
    person = support.create_candidate(client, created, support.seed_batch()["id"], "登录测试候选人")
    credentials = person["credentials"]
    denied = client.post("/api/auth/login", json={"username": credentials["username"], "password": "Wrong-Pass-1!"})
    assert denied.status_code == 401
    login = client.post("/api/auth/login", json={"username": credentials["username"], "password": credentials["password"]})
    assert login.status_code == 200
    session = login.json()
    assert session["role"] == "candidate" and session["candidate_id"] == person["id"]
    assert session["permissions"] == ["interview:use"]
    candidate_headers = support.bearer(session["access_token"])
    before = client.get("/api/interviews/me", headers=candidate_headers).json()
    assert before["candidate"] == {"code": person["code"], "name": "登录测试候选人"}
    assert before["needs_profile"] is True and before["entry_mode"] == "account"
    assert client.put("/api/interviews/me/profile", headers=candidate_headers, json={"phone": "13800000000"}).status_code == 422
    updated = client.put("/api/interviews/me/profile", headers=candidate_headers, json={
        "phone": "13800000000", "email": "candidate@example.com", "education": "本科", "major": "制造工程", "years": "应届生",
    })
    assert updated.status_code == 200
    after = client.get("/api/interviews/me", headers=candidate_headers).json()
    assert after["profile_complete"] is True and after["needs_profile"] is False


def test_role_permissions_are_enforced(client, headers):
    # 审计日志由系统管理员和HR管理员查看。
    for role in ("interviewer", "report_reviewer", "question_reviewer", "business_user", "candidate"):
        assert client.get("/api/audits", headers=headers(role, role)).status_code == 403
    assert client.get("/api/audits", headers=headers("hr_admin", "hr")).status_code == 200
    assert client.get("/api/audits", headers=headers()).status_code == 200
    assert client.get("/api/audits").status_code == 401
    assert client.get("/api/audits", headers=headers("visitor", "someone")).status_code == 401
    assert client.get("/api/candidates", headers=headers("candidate", "candidate")).status_code == 403
    assert client.get("/api/candidates", headers=headers("question_reviewer", "question_reviewer")).status_code == 403


def test_candidate_cannot_operate_another_interview(client, headers):
    candidate = headers("candidate", "candidate")
    other = support.seed_candidate_id("CAND-2026-002")
    # Candidate API ownership is checked independently from the role permission.
    with SessionLocal() as db:
        interview_id = db.query(Interview).filter(Interview.candidate_id == other).first().id
    response = client.post(f"/api/interviews/{interview_id}/consent", headers=candidate,
                           json={"consented": True, "notice_version": intelligence.current_notice()[0]})
    assert response.status_code == 403
    assert client.post(f"/api/interviews/{interview_id}/submit", headers=candidate).status_code in {403, 409}
    assert client.get("/api/interviews/me", headers=candidate).json()["candidate"]["code"] == "CAND-2026-001"


def test_hr_can_create_candidate_and_interview_record(client, headers, created):
    hr = headers("hr_admin", "hr")
    batch = support.seed_batch()
    response = client.post("/api/candidates", headers=hr, json={
        "code": "CAND-TEST-005", "name": "测试候选人五", "batch_id": batch["id"], "profile": {"education": "本科"},
    })
    assert response.status_code == 200
    person = response.json()
    created.candidates.append(person["id"])
    assert person["interview_status"] == "consent_pending" and person["report_status"] == "not_generated"
    # 登录凭据只在建立时返回一次：账号是候选人编号，密码随机生成且满足强度要求。
    credentials = person["credentials"]
    assert credentials["username"] == "CAND-TEST-005" and credentials["candidate_id"] == person["id"]
    assert security.password_problems(credentials["password"], credentials["username"]) == []
    rows = client.get("/api/candidates", headers=hr).json()
    row = next(item for item in rows if item["code"] == "CAND-TEST-005")
    assert row["batch_id"] == batch["id"] and row["profile"] == {"education": "本科"}
    assert row["interview_status"] == "consent_pending"
    assert row["login_username"] == "CAND-TEST-005" and row["has_login"] is True and row["login_locked"] is False
    assert "credentials" not in row and "initial_password" not in row and "password" not in row
    assert credentials["password"] not in client.get("/api/candidates", headers=hr).text
    with SessionLocal() as db:
        user = db.query(User).filter_by(username="CAND-TEST-005").one()
        assert user.initial_password == "" and user.candidate_id == person["id"]
        assert user.password_hash and credentials["password"] not in user.password_hash
        assert security.verify_password(credentials["password"], user.password_hash)
    duplicate = client.post("/api/candidates", headers=hr, json={"code": "CAND-TEST-005", "name": "重复编号", "batch_id": batch["id"]})
    assert duplicate.status_code == 409
    assert client.post("/api/candidates", headers=headers("interviewer", "interviewer"),
                       json={"name": "越权新增", "batch_id": batch["id"]}).status_code == 403
    assert client.post("/api/candidates", headers=hr, json={"name": "批次不存在", "batch_id": 999999}).status_code == 404


def test_candidate_resume_upload_goes_to_person_library_and_download(client, headers, created):
    hr = headers("hr_admin", "hr")
    batch = support.create_batch(client, created, "RESUME-BATCH", "简历上传测试批次", recruitment_type="校园招聘")
    support.publish_questions(client, batch["id"])
    row = support.create_candidate(client, created, batch["id"], "简历测试候选人")
    assert row["resume"]["uploaded"] is False
    resume = support.resume_text("简历测试候选人").encode("utf-8")
    uploaded = client.post(f"/api/candidates/{row['id']}/resume", headers=hr,
                           files={"file": ("candidate-resume.txt", resume, "text/plain")})
    assert uploaded.status_code == 200
    # 简历进入人员库在后台解析，接口返回可轮询的处理记录。
    assert uploaded.json()["kind"] == "candidate_resume" and uploaded.json()["status"] in ("running", "completed")
    assert set(uploaded.json()) == {"id", "kind", "label", "status", "progress", "result", "error"}
    assert client.get(f"/api/library/operations/{uploaded.json()['id']}", headers=headers("hr_admin", "other-hr")).status_code == 404
    operation = support.wait_operation(client, uploaded.json(), hr)
    assert operation["status"] == "completed" and operation["result"]["status"] == "completed"
    person_id = operation["result"]["library_person_id"]
    listed = next(item for item in client.get(f"/api/candidates?batch_id={batch['id']}", headers=hr).json() if item["id"] == row["id"])
    assert listed["library_person_id"] == person_id
    assert listed["resume"]["uploaded"] is True and listed["resume"]["source"] == "library"
    assert listed["resume"]["original_name"] == "candidate-resume.txt" and listed["resume"]["ocr_status"] == "completed"
    assert "人力资源管理专业" in listed["resume"]["text_preview"] and "13812345678" not in listed["resume"]["text_preview"]
    downloaded = client.get(f"/api/candidates/{row['id']}/resume", headers=hr)
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"].startswith("text/plain")
    assert downloaded.content == resume
    # 面试批次直接上传的简历归入人员库的同名批次，分类跟随招聘类型。
    person = client.get(f"/api/library/persons/{person_id}", headers=hr).json()
    library_batch = client.get(f"/api/library/person-batches/{person['batch_id']}", headers=hr).json()
    assert library_batch["category"] == "校招" and "简历上传测试批次" in library_batch["name"]
    assert [item["candidate_id"] for item in person["interviews"]] == [row["id"]]
    for name, content in (("candidate-resume.png", b"not a resume"), ("candidate-resume.pdf", b"%PDF-1.7\n%%EOF\n"),
                          ("candidate-resume.txt", b"")):
        rejected = client.post(f"/api/candidates/{row['id']}/resume", headers=hr, files={"file": (name, content, "application/octet-stream")})
        assert rejected.status_code == 422, name
    assert client.post(f"/api/candidates/{row['id']}/resume", headers=headers("interviewer", "interviewer"),
                       files={"file": ("candidate-resume.txt", resume, "text/plain")}).status_code == 403
    assert client.post("/api/candidates/999999/resume", headers=hr,
                       files={"file": ("candidate-resume.txt", resume, "text/plain")}).status_code == 404
    unchanged = next(item for item in client.get(f"/api/candidates?batch_id={batch['id']}", headers=hr).json() if item["id"] == row["id"])
    assert unchanged["library_person_id"] == person_id


def test_configurable_question_count_review_submission_and_one_character_candidate_code(client, headers, created):
    hr = headers("hr_admin", "hr")
    reviewer = headers("question_reviewer", "question_reviewer")
    batch = client.post("/api/batches", headers=hr, json={
        "code": "2026-COUNT-1", "name": "可配置题量测试批次", "recruitment_type": "社会招聘", "job_id": support.seed_batch()["job_id"],
    })
    assert batch.status_code == 200
    batch_id = batch.json()["id"]
    created.batches.append(batch_id)
    assert batch.json()["mode"] == "ai_interview" and batch.json()["status"] == "draft"
    assert client.post("/api/candidates", headers=hr, json={"name": "尚无题目", "batch_id": batch_id}).status_code == 409

    generated = client.post(f"/api/batches/{batch_id}/questions/generate", headers=hr, json={"count": 8})
    assert generated.status_code == 200
    assert generated.json()["count"] == 8
    version = generated.json()["version"]
    rows = [row for row in client.get(f"/api/questions?batch_id={batch_id}", headers=hr).json() if row["version"] == version]
    assert len(rows) == 8
    assert {row["status"] for row in rows} == {"draft"}

    manual = client.post(f"/api/batches/{batch_id}/questions/manual", headers=hr, json={
        "dimension": "沟通表达", "content": "请手动说明一次你澄清信息并达成共识的经历。", "time_limit": 120,
    })
    assert manual.status_code == 200
    assert manual.json()["sequence"] == 9
    manual_id = manual.json()["id"]
    edited = client.put(f"/api/questions/{manual_id}", headers=hr, json={
        "content": "请手动说明一次你澄清复杂信息并达成共识的经历。", "time_limit": 100, "change_reason": "补充复杂场景",
    })
    assert edited.status_code == 200
    removed = client.delete(f"/api/questions/{manual_id}", headers=hr)
    assert removed.status_code == 200
    assert removed.json()["count"] == 8

    submitted = client.post(f"/api/batches/{batch_id}/questions/{version}/submit-review", headers=hr)
    assert submitted.status_code == 200
    assert submitted.json()["count"] == 8
    rows = [row for row in client.get(f"/api/questions?batch_id={batch_id}", headers=reviewer).json() if row["version"] == version]
    assert len(rows) == 8
    assert {row["status"] for row in rows} == {"pending_review"}
    assert next(item for item in client.get("/api/batches", headers=hr).json() if item["id"] == batch_id)["status"] == "reviewing"

    for row in rows:
        approved = client.post(f"/api/questions/{row['id']}/review", headers=reviewer,
                               json={"approved": True, "comment": "内容合规，同意发布"})
        assert approved.status_code == 200
    assert next(item for item in client.get("/api/batches", headers=hr).json() if item["id"] == batch_id)["status"] == "approved"
    assert client.post(f"/api/batches/{batch_id}/questions/{version}/publish", headers=reviewer).status_code == 200

    candidate = client.post("/api/candidates", headers=hr, json={"code": "1", "name": "一号候选人", "batch_id": batch_id, "profile": {}})
    assert candidate.status_code == 200
    assert candidate.json()["code"] == "1" and candidate.json()["credentials"]["username"] == "1"
    interview = client.get("/api/interviews/me", headers=headers("candidate", "1")).json()
    assert len(interview["questions"]) == 8 and interview["question_version"] == version


def test_same_batch_job_uses_exact_question_snapshot(client, headers):
    batch = support.seed_batch()
    rows = client.get(f"/api/questions?batch_id={batch['id']}", headers=headers()).json()
    published = [row for row in rows if row["status"] == "published"]
    assert len(published) == 6
    assert len({row["version"] for row in published}) == 1
    interview = client.get("/api/interviews/me", headers=headers("candidate", "candidate")).json()
    assert [q["content"] for q in interview["questions"]] == [q["content"] for q in sorted(published, key=lambda x: x["sequence"])]


def test_sensitive_content_is_blocked_and_logged(client, headers):
    samples = {
        "年龄歧视": "你的年龄是多少",
        "性别歧视": "这个岗位是否应该男性优先",
        "地域歧视": "你是哪里人",
        "民族和宗教": "请说明你的宗教信仰",
        "婚育和家庭隐私": "请说明你的婚姻和生育计划",
        "健康隐私": "请提供个人病史",
        "侮辱性内容": "你怎么这么蠢",
        "与岗位无关的私人信息": "请提供家庭住址",
    }
    for reason, content in samples.items():
        result = client.post(
            "/api/filter/check",
            headers=headers("question_reviewer", "question_reviewer"),
            json={"content": content, "source_type": "dynamic_followup", "interview_id": 1},
        )
        assert result.status_code == 200
        assert result.json()["allowed"] is False
        assert result.json()["reason"] == reason
    allowed = client.post("/api/filter/check", headers=headers("question_reviewer", "question_reviewer"),
                          json={"content": "请说明你如何处理质量异常。"})
    assert allowed.json() == {"allowed": True, "reason": "通过", "content": "请说明你如何处理质量异常。"}
    blocks = client.get("/api/sensitive-blocks", headers=headers()).json()
    assert set(samples).issubset({item["reason"] for item in blocks})
    assert client.get("/api/sensitive-blocks", headers=headers("interviewer", "interviewer")).status_code == 403


def test_full_candidate_flow_followup_once_and_report(client, headers, created):
    person = support.create_candidate(client, created, support.seed_batch()["id"], "全流程候选人")
    h = headers("candidate", person["code"])
    interview = client.get("/api/interviews/me", headers=h).json()
    interview_id = interview["id"]
    assert client.post(f"/api/interviews/{interview_id}/reset", headers=h).status_code == 409
    assert client.post(f"/api/interviews/{interview_id}/start", headers=h).status_code == 409
    # 个人信息、合规告知、设备检测依次完成后才能开始。
    assert client.post(f"/api/interviews/{interview_id}/consent", headers=h, json={"consented": True}).status_code == 409
    assert client.put("/api/interviews/me/profile", headers=h, json=support.PROFILE).status_code == 200
    assert client.post(f"/api/interviews/{interview_id}/mic-check", headers=h, json=support.MIC).status_code == 409
    assert client.post(f"/api/interviews/{interview_id}/consent", headers=h, json={"consented": True}).status_code == 200
    no_voice = client.post(f"/api/interviews/{interview_id}/mic-check", headers=h,
                           json={"passed": True, "peak_rms": 0.001, "speech_frames": 0, "duration_ms": 3200})
    assert no_voice.status_code == 422
    extra_words = client.post(f"/api/interviews/{interview_id}/mic-check", headers=h, json={
        "passed": True, "peak_rms": 0.08, "speech_frames": 12, "duration_ms": 3200,
        "speech_text": "请进行麦克风测试一二三，谢谢",
    })
    assert extra_words.status_code == 422
    assert client.post(f"/api/interviews/{interview_id}/mic-check", headers=h, json={
        "passed": True, "peak_rms": 0.08, "speech_frames": 12, "duration_ms": 3200,
        "speech_text": "麦克风测试一二三",
    }).status_code == 200
    assert client.post(f"/api/interviews/{interview_id}/start", headers=h).status_code == 200
    assert client.post(f"/api/interviews/{interview_id}/submit", headers=h).status_code == 409
    for index, question in enumerate(interview["questions"]):
        answer = client.post(
            f"/api/interviews/{interview_id}/answers",
            headers=h,
            json={"question_id": question["id"], "transcript": f"第{index + 1}题回答：我先核对事实和操作记录，再说明判断依据、采取的行动和结果。", "generate_followup": True},
        )
        assert answer.status_code == 200
        payload = answer.json()
        assert payload["followup"]
        assert payload["current_question"] == index + 1
        if index == 0:
            audio = client.post(
                f"/api/interviews/{interview_id}/audio/{question['id']}",
                headers=h,
                json={"data_url": "data:audio/webm;base64,AAAA"},
            )
            assert audio.status_code == 200
            assert audio.json()["bytes"] == 3
        duplicate = client.post(
            f"/api/interviews/{interview_id}/answers",
            headers=h,
            json={"question_id": question["id"], "transcript": payload["transcript"], "generate_followup": True},
        ).json()
        assert duplicate["followup"] == payload["followup"]
        followup_response = client.post(
            f"/api/interviews/{interview_id}/answers/{payload['answer_id']}/followup",
            headers=h,
            json={"transcript": "我补充说明了当时的判断标准和核验结果。", "audio_data_url": "data:audio/webm;base64,AAAA", "timed_out": False},
        )
        assert followup_response.status_code == 200
        assert followup_response.json()["audio_saved"].endswith("-followup.webm")
        assert followup_response.json()["current_question"] == index + 2
    complete = client.post(f"/api/interviews/{interview_id}/submit", headers=h)
    assert complete.status_code == 200
    # 测试环境同步生成报告；提交后直接进入人工复核。
    assert complete.json()["status"] == "pending_review"
    report = client.get(f"/api/reports/{complete.json()['report_id']}", headers=headers("report_reviewer", "report_reviewer")).json()
    assert report["candidate"]["code"] == person["code"] and report["current_version"] == 1
    assert [version["version_type"] for version in report["versions"]] == ["ai_original"]
    records = report["current_content"]["qa_records"]
    assert len(records) == 6 and all(item["followup"] and item["followup_answer"] for item in records)
    assert len(report["current_content"]["evaluations"]) == 6 and report["current_content"]["decision"] is None
    finished = client.get("/api/interviews/me", headers=h).json()
    assert finished["status"] == "completed" and finished["current_question"] == 7
    listed = next(item for item in client.get("/api/candidates", headers=headers("hr_admin", "hr")).json() if item["id"] == person["id"])
    assert listed["interview_status"] == "completed" and listed["report_status"] == "pending_review"
    # 面试提交后不再需要登录凭据。
    assert client.post(f"/api/candidates/{person['id']}/password", headers=headers("hr_admin", "hr")).status_code == 409


def test_report_versions_and_export_gate(client, headers, created):
    reviewer = headers("report_reviewer", "report_reviewer")
    record = support.create_completed_candidate(created, "REPORT-GATE-001", "报告复核测试")
    assert client.get("/api/jobs", headers=reviewer).status_code == 200
    reports = client.get(f"/api/reports?job_id={record['job_id']}", headers=reviewer).json()
    assert reports and all(item["job"]["id"] == record["job_id"] for item in reports)
    assert client.get("/api/reports?job_id=9999", headers=reviewer).json() == []
    assert client.get("/api/reports?batch_id=9999", headers=reviewer).json() == []
    pending = next(item for item in reports if item["id"] == record["report_id"])
    assert pending["status"] == "pending_review" and pending["generation_error"] == ""
    blocked = client.get(f"/api/reports/{pending['id']}/export", headers=reviewer)
    assert blocked.status_code == 409
    content = pending["current_content"]
    content["summary"] += " 人工复核补充。"
    edited = client.put(
        f"/api/reports/{pending['id']}", headers=reviewer,
        json={"content": content, "reason": "补充人工核实说明"},
    ).json()
    assert any(v["version_type"] == "ai_original" for v in edited["versions"])
    assert any(v["version_type"] == "human_modified" for v in edited["versions"])
    assert edited["current_version"] == 2 and edited["current_content"]["summary"].endswith("人工复核补充。")
    returned = client.post(f"/api/reports/{pending['id']}/return", headers=reviewer, json={"reason": "退回补充依据"})
    assert returned.json() == {"ok": True, "status": "returned"}
    assert client.get(f"/api/matching/interview-results/{pending['candidate']['id']}", headers=reviewer).status_code == 409
    confirmed = client.post(f"/api/reports/{pending['id']}/confirm", headers=reviewer, json={"reason": "已核对原始回答"})
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "confirmed"
    # 候选人没有关联人员库，面试结论不写入人员库，只返回说明。
    assert confirmed.json()["library_sync"] and "已同步" not in confirmed.json()["library_sync"]
    exported = client.get(f"/api/reports/{pending['id']}/export", headers=reviewer)
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    with ZipFile(BytesIO(exported.content)) as archive:
        assert "word/document.xml" in archive.namelist()
        document_xml = archive.read("word/document.xml").decode("utf-8")
        assert "候选人编号" in document_xml
        assert "六维评价" in document_xml
        assert "REPORT-GATE-001" in document_xml and "人工复核补充。" in document_xml
    hr_exported = client.get(f"/api/reports/{pending['id']}/export", headers=headers("hr_admin", "hr"))
    assert hr_exported.status_code == 200
    # 用人部门可以查看报告，但不能复核或导出。
    business = headers("business_user", "business")
    assert client.get(f"/api/reports/{pending['id']}", headers=business).status_code == 200
    assert client.get(f"/api/reports/{pending['id']}/export", headers=business).status_code == 403
    assert client.post(f"/api/reports/{pending['id']}/confirm", headers=business, json={"reason": "越权确认"}).status_code == 403
    matching = client.get(f"/api/matching/interview-results/{pending['candidate']['id']}", headers=reviewer)
    assert matching.status_code == 200
    assert matching.json()["decision"] is None
    assert matching.json()["candidate_code"] == "REPORT-GATE-001" and matching.json()["report_version"] == 2
    assert matching.json()["library_person_id"] is None and len(matching.json()["dimensions"]) == 6
    assert client.get("/api/matching/interview-results/999999", headers=reviewer).status_code == 404
    assert client.get("/api/reports/999999", headers=reviewer).status_code == 404


def test_seeded_jobs_and_pilot_batch_are_available_read_only(client, headers):
    hr = headers("hr_admin", "hr")
    jobs = client.get("/api/jobs", headers=hr).json()
    hr_jobs = [item for item in jobs if item["code"].startswith("JOB-HR-")]
    assert [item["code"] for item in hr_jobs] == ["JOB-HR-001", "JOB-HR-002"]
    personnel = next(item for item in hr_jobs if item["code"] == "JOB-HR-002")
    assert personnel["audit_status"] == "approved" and personnel["library_job_id"] is None
    assert len(personnel["competency_model"]) == 6
    assert all(item["behavior"] and set(item["levels"]) == {"0", "1", "2", "3", "4", "5"} for item in personnel["competency_model"])
    batches = client.get("/api/batches", headers=hr).json()
    pilot = next(item for item in batches if item["code"] == "2026-HR-01")
    assert pilot["job_id"] == personnel["id"] and pilot["mode"] == "ai_interview" and pilot["accepts_candidates"] is True
    questions = client.get(f"/api/questions?batch_id={pilot['id']}", headers=hr).json()
    published = [item for item in questions if item["version"] == 1 and item["status"] == "published"]
    assert len(published) == 6
    # 人力资源试点批次使用本岗位的题目，不与制造岗位批次混用。
    from backend.app.interview.mock_engine import HR_QUESTIONS
    assert [(item["dimension"], item["content"]) for item in sorted(published, key=lambda q: q["sequence"])] == HR_QUESTIONS
    # 面试侧的岗位只读：岗位资料在岗位库维护。
    for method, path in (("post", "/api/jobs"), ("put", f"/api/jobs/{personnel['id']}"), ("delete", f"/api/jobs/{personnel['id']}"),
                         ("post", f"/api/jobs/{personnel['id']}/scoring-advice")):
        response = getattr(client, method)(path, headers=hr, **({} if method == "delete" else {"json": {}}))
        assert response.status_code in {404, 405}, path
    assert client.get("/api/jobs", headers=hr).json() == jobs


@pytest.fixture
def linked_listening(client, headers, created):
    """一名第一阶段报告已确认、系统内已同意采集的虚构候选人，由面试官旁听到综合报告生成。"""
    def run(code, name):
        interviewer = headers("interviewer", "interviewer")
        record = support.create_completed_candidate(created, code, name, report_status="confirmed")
        url = f"/api/listening/{record['candidate_id']}"
        state = client.get(url, headers=interviewer).json()
        assert state["mode"] == "linked" and state["status"] == "ready" and state["asr_mode"] == "mock"
        assert state["stage_one"]["report_id"] == record["report_id"] and state["prior_consent_valid"] is True
        # 候选人已在系统内同意采集时，面试官确认告知即可开始。
        assert client.post(url + "/start", headers=interviewer).status_code == 409
        assert client.post(url + "/start", headers=interviewer, json={"consented": True}).status_code == 200
        capture = support.add_capture(f"capture-{code}", record["candidate_id"], "我先对照检查表复核记录，再请班组长确认处理结果。")
        assert client.post(url + "/speaker", headers=interviewer, json={"capture_id": capture, "speaker": "candidate"}).status_code == 200
        latest = client.post(url + "/suggest", headers=interviewer).json()
        assert len(latest["suggestions"]) == 1
        return record, url, latest
    return run


def test_comparison_and_listening_flow(client, headers, created, linked_listening, monkeypatch):
    interviewer = headers("interviewer", "interviewer")
    batch = support.seed_batch()
    comparison = client.get(f"/api/comparison?batch_id={batch['id']}", headers=interviewer).json()
    codes = {item["candidate"]["code"] for item in comparison["items"]}
    assert {"CAND-2026-002", "CAND-2026-003", "CAND-2026-004"} <= codes and "CAND-2026-001" not in codes
    assert all(set(item["scores"]) and "hard_indicators" in item and "stage_two" in item for item in comparison["items"])
    assert all(item["hard_indicators"]["counted_in_score"] is False for item in comparison["items"])
    assert comparison["notice"] and comparison["default_limit"] == 0
    # 默认选中该批次全部候选人；配置了上限时取匹配度最高的若干人。
    assert sorted(comparison["default_selected"]) == sorted(item["candidate"]["id"] for item in comparison["items"])
    monkeypatch.setenv("TALENTFLOW_COMPARISON_DEFAULT_LIMIT", "2")
    limited = client.get(f"/api/comparison?batch_id={batch['id']}", headers=interviewer).json()
    ranked = sorted(limited["items"], key=lambda item: item["match_score"], reverse=True)
    assert limited["default_limit"] == 2 and len(limited["default_selected"]) == 2
    assert {item["match_score"] for item in limited["items"] if item["candidate"]["id"] in limited["default_selected"]} \
        == {item["match_score"] for item in ranked[:2]}
    assert len(limited["items"]) == len(comparison["items"])
    monkeypatch.delenv("TALENTFLOW_COMPARISON_DEFAULT_LIMIT")
    selected_ids = [item["candidate"]["id"] for item in comparison["items"][:2]]
    selected = client.get(
        f"/api/comparison?job_id={batch['job_id']}&candidate_ids={selected_ids[0]},{selected_ids[1]}",
        headers=interviewer,
    ).json()
    assert [item["candidate"]["id"] for item in selected["items"]] == selected_ids
    assert client.get("/api/comparison?candidate_ids=abc", headers=interviewer).status_code == 422
    # 导出必须指定批次或岗位，且只包含已人工确认的报告。
    assert client.get("/api/comparison/export", headers=interviewer).status_code == 404
    pending_only = support.seed_candidate_id("CAND-2026-004")
    assert client.get(f"/api/comparison/export?batch_id={batch['id']}&candidate_ids={pending_only}", headers=interviewer).status_code == 409
    for query in (f"job_id={batch['job_id']}", f"batch_id={batch['id']}"):
        comparison_export = client.get(f"/api/comparison/export?{query}", headers=interviewer)
        assert comparison_export.status_code == 200
        assert comparison_export.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        with ZipFile(BytesIO(comparison_export.content)) as archive:
            assert "word/document.xml" in archive.namelist()
            comparison_xml = archive.read("word/document.xml").decode("utf-8")
            assert "候选人对比报告" in comparison_xml
            assert 'w:orient="landscape"' in comparison_xml
            assert "CAND-2026-002" in comparison_xml and "CAND-2026-004" not in comparison_xml

    record, url, latest = linked_listening("LISTEN-FLOW-001", "旁听流程测试")
    assert latest["suggestions"][0]["report_id"] == record["report_id"]
    # 模拟推进旁听的接口已经移除，只能依据真实采集的转写生成建议。
    assert client.post(url + "/next", headers=interviewer).status_code in {404, 405}
    action = client.post(
        url + "/suggestions", headers=interviewer,
        json={"suggestion_id": 1, "action": "edited", "edited_text": "请具体说明当时采用的质量标准。"},
    )
    assert action.status_code == 200
    blocked = client.post(url + "/suggestions", headers=interviewer,
                          json={"suggestion_id": 1, "action": "edited", "edited_text": "请说明你的婚姻状况。"})
    assert blocked.status_code == 422
    final = client.post(url + "/finish", headers=interviewer).json()
    assert final["decision"] is None
    assert final["adopted_questions"] == ["请具体说明当时采用的质量标准。"]
    assert final["mode"] == "linked"
    assert isinstance(final["stage_one"], dict)
    assert final["stage_one_summary"]
    assert len(final["stage_one_evaluations"]) == 6
    assert final["stage_two_evidence"]
    assert final["findings"]
    compared = client.get(f"/api/comparison?candidate_ids={record['candidate_id']}", headers=interviewer).json()["items"]
    assert compared[0]["report_id"] == record["report_id"]
    assert compared[0]["stage_two"] == {"status": "pending_review", "evidence_count": 1,
                                        "findings": [{"dimension": final["findings"][0]["dimension"], "status": "新增证据待复核"}]}


def test_comprehensive_report_review_and_export(client, headers, created, linked_listening):
    interviewer = headers("interviewer", "interviewer")
    record, url, _ = linked_listening("LISTEN-FLOW-002", "综合报告测试")
    candidate_id = record["candidate_id"]
    reviewer = headers("report_reviewer", "report_reviewer")
    assert client.get(f"/api/listening/{candidate_id}/report", headers=reviewer).status_code == 404
    assert client.post(url + "/finish", headers=interviewer).status_code == 200

    report = client.get(f"/api/listening/{candidate_id}/report", headers=reviewer)
    assert report.status_code == 200
    assert report.json()["status"] == "pending_review" and report.json()["current_version"] == 1
    payload = report.json()["current_content"]
    payload["stage_two_summary"] += " 人工核对补充。"
    assert client.put(f"/api/listening/{candidate_id}/report", headers=interviewer,
                      json={"content": payload, "reason": "越权修改"}).status_code == 403
    edited = client.put(
        f"/api/listening/{candidate_id}/report", headers=reviewer,
        json={"content": payload, "reason": "核对旁听记录后补充"},
    )
    assert edited.status_code == 200
    assert any(v["version_type"] == "human_edit" for v in edited.json()["versions"])
    assert edited.json()["current_version"] == 2
    assert client.get(f"/api/listening/{candidate_id}/report/export", headers=reviewer).status_code == 409
    assert client.post(f"/api/listening/{candidate_id}/report/return", headers=reviewer, json={"reason": "补充依据"}).json()["status"] == "returned"
    assert client.post(f"/api/listening/{candidate_id}/report/confirm", headers=reviewer, json={"reason": "已核对两阶段证据"}).status_code == 200
    assert client.put(f"/api/listening/{candidate_id}/report", headers=reviewer,
                      json={"content": payload, "reason": "确认后再修改"}).status_code == 409
    exported = client.get(f"/api/listening/{candidate_id}/report/export", headers=reviewer)
    assert exported.status_code == 200
    with ZipFile(BytesIO(exported.content)) as archive:
        comprehensive_xml = archive.read("word/document.xml").decode("utf-8")
        assert "TalentFlowAI面试两阶段综合报告" in comprehensive_xml
        assert "第一阶段AI面试总结" in comprehensive_xml
        assert "第二阶段AI旁听纪要" in comprehensive_xml
        assert "两阶段综合分析" in comprehensive_xml
        assert "人工核对补充。" in comprehensive_xml
    overview = client.get(f"/api/comprehensive-reports?job_id={record['job_id']}", headers=reviewer)
    assert overview.status_code == 200
    item = next(row for row in overview.json()["items"] if row["candidate"]["id"] == candidate_id)
    assert item["status"] == "confirmed" and item["mode"] == "linked"
    assert item["stage_one"]["report_id"] == record["report_id"]
    assert item["stage_one"]["scores"]
    assert item["stage_two"]["evidence_count"] > 0
    assert item["stage_two"]["finding_statuses"]
    assert item["content"]["stage_one_summary"]
    assert item["content"]["stage_two_summary"]
    assert item["hard_indicators"]["available"] is False
    assert client.get("/api/comprehensive-reports?job_id=9999", headers=reviewer).json()["items"] == []
