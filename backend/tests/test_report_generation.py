"""第一阶段面试报告的后台生成：提交后立即返回，生成失败保留回答并可重新生成。"""
import pytest
from fastapi import HTTPException

from backend.app.core.database import SessionLocal
from backend.app.interview import report_builder
from backend.app.interview.models import Interview, Report, ReportVersion

from . import support

REVIEWER = support.staff("report_reviewer", "report_reviewer")


@pytest.fixture
def answered(client, created):
    """一名已答完全部主体题、尚未提交的候选人。"""
    person = support.create_candidate(client, created, support.seed_batch()["id"], "报告生成测试")
    h = support.candidate(person["code"])
    interview = support.prepare_interview(client, h)
    support.answer_all(client, h, interview)
    return person, h, interview["id"]


def failing(error):
    def build(*args, **kwargs):
        raise error
    return build


def report_row(report_id):
    with SessionLocal() as db:
        report = db.get(Report, report_id)
        versions = db.query(ReportVersion).filter_by(report_id=report_id).order_by(ReportVersion.version).all()
        return report.status, report.current_version, report.generation_error, [(v.version, v.version_type) for v in versions]


def test_submit_returns_at_once_and_report_enters_review(client, answered):
    person, h, interview_id = answered
    mark = support.audit_mark(client)
    answers = support.stored_answers(interview_id)
    submitted = client.post(f"/api/interviews/{interview_id}/submit", headers=h)
    assert submitted.status_code == 200
    body = submitted.json()
    assert body["ok"] is True and body["status"] == "pending_review" and "人工复核" in body["message"]
    report = client.get(f"/api/reports/{body['report_id']}", headers=REVIEWER).json()
    assert report["status"] == "pending_review" and report["generation_error"] == ""
    assert report["current_version"] == 1 and report["match_score"] == report["current_content"]["match_analysis"]["score"]
    assert [(v["version"], v["version_type"], v["editor"]) for v in report["versions"]] == [(1, "ai_original", "AI面试智能体")]
    content = report["current_content"]
    assert [item["transcript"] for item in content["qa_records"]] == [row[3] for row in answers]
    assert len(content["evaluations"]) == 6 and content["decision"] is None
    assert content["job_context"]["code"] == "JOB-2026-001"
    assert content["hard_indicators"]["available"] is False and content["hard_indicators"]["counted_in_score"] is False
    assert support.stored_answers(interview_id) == answers
    audits = support.audits_since(client, mark)
    assert [(item["action"], item["target_id"], item["actor"]) for item in reversed(audits)] == [
        ("interview_submitted", str(interview_id), person["code"]), ("ai_report_generated", str(body["report_id"]), person["code"])]
    # 已提交的面试不能再次提交。
    assert client.post(f"/api/interviews/{interview_id}/submit", headers=h).status_code == 409
    assert report_row(body["report_id"])[3] == [(1, "ai_original")]


def test_incomplete_interview_cannot_be_submitted(client, created):
    person = support.create_candidate(client, created, support.seed_batch()["id"], "未答完候选人")
    h = support.candidate(person["code"])
    interview = support.prepare_interview(client, h)
    question = interview["questions"][0]
    assert client.post(f"/api/interviews/{interview['id']}/answers", headers=h, json={
        "question_id": question["id"], "transcript": support.answer_text(1), "generate_followup": False}).status_code == 200
    assert client.post(f"/api/interviews/{interview['id']}/submit", headers=h).status_code == 409
    assert support.my_interview(client, h)["status"] == "in_progress"
    with SessionLocal() as db:
        assert db.query(Report).filter_by(interview_id=interview["id"]).count() == 0


def test_failed_generation_keeps_answers_and_can_be_retried(client, answered, monkeypatch):
    person, h, interview_id = answered
    mark = support.audit_mark(client)
    answers = support.stored_answers(interview_id)
    monkeypatch.setattr(report_builder, "build_report", failing(RuntimeError("连接 https://model.example.invalid 失败，密钥 sk-secret")))
    submitted = client.post(f"/api/interviews/{interview_id}/submit", headers=h)
    # 候选人一侧照常完成提交，不因报告生成失败而受影响。
    assert submitted.status_code == 200 and submitted.json()["status"] == "generation_failed"
    report_id = submitted.json()["report_id"]
    finished = support.my_interview(client, h)
    assert finished["status"] == "completed" and finished["completed_at"] and len(finished["answers"]) == 6
    assert support.stored_answers(interview_id) == answers

    failed = client.get(f"/api/reports/{report_id}", headers=REVIEWER).json()
    assert failed["status"] == "generation_failed" and failed["current_version"] == 0
    assert failed["versions"] == [] and failed["current_content"] == {} and failed["match_score"] == 0
    # 失败原因只说明类型，不暴露地址、密钥等内部信息。
    assert failed["generation_error"] and "RuntimeError" in failed["generation_error"]
    assert "sk-secret" not in failed["generation_error"] and "192.0.2.8" not in failed["generation_error"]
    listed = client.get(f"/api/reports?batch_id={support.seed_batch()['id']}", headers=REVIEWER).json()
    assert next(item for item in listed if item["id"] == report_id)["status"] == "generation_failed"
    row = next(item for item in client.get("/api/candidates", headers=support.staff("hr_admin", "hr")).json() if item["id"] == person["id"])
    assert row["interview_status"] == "completed" and row["report_status"] == "generation_failed"

    rejected = [
        client.put(f"/api/reports/{report_id}", headers=REVIEWER, json={"content": {"summary": "人工填写"}, "reason": "尝试修改"}),
        client.post(f"/api/reports/{report_id}/confirm", headers=REVIEWER, json={"reason": "尝试确认"}),
        client.post(f"/api/reports/{report_id}/return", headers=REVIEWER, json={"reason": "尝试退回"}),
        client.post(f"/api/reports/{report_id}/regenerate", headers=REVIEWER, json={"expected_version": 1}),
        client.get(f"/api/reports/{report_id}/export", headers=REVIEWER),
        client.get(f"/api/matching/interview-results/{person['id']}", headers=REVIEWER),
    ]
    assert [response.status_code for response in rejected] == [409] * 6
    assert report_row(report_id) == ("generation_failed", 0, failed["generation_error"], [])
    compared = client.get(f"/api/comparison?candidate_ids={person['id']}", headers=REVIEWER).json()
    assert compared["items"] == [] and compared["default_selected"] == []

    # 重新生成需要报告修改权限；模型仍不可用时保持失败状态。
    for role in ("hr_admin", "interviewer", "business_user", "candidate"):
        assert client.post(f"/api/reports/{report_id}/retry-generation", headers=support.staff(role, role)).status_code == 403
    still = client.post(f"/api/reports/{report_id}/retry-generation", headers=REVIEWER)
    assert still.status_code == 200 and still.json()["status"] == "generation_failed" and still.json()["versions"] == []
    monkeypatch.undo()
    retried = client.post(f"/api/reports/{report_id}/retry-generation", headers=REVIEWER)
    assert retried.status_code == 200
    report = retried.json()
    assert report["status"] == "pending_review" and report["generation_error"] == "" and report["current_version"] == 1
    assert [(v["version"], v["version_type"]) for v in report["versions"]] == [(1, "ai_original")]
    assert [item["transcript"] for item in report["current_content"]["qa_records"]] == [row[3] for row in answers]
    assert support.stored_answers(interview_id) == answers
    assert client.post(f"/api/reports/{report_id}/retry-generation", headers=REVIEWER).status_code == 409
    assert client.post("/api/reports/999999/retry-generation", headers=REVIEWER).status_code == 404

    actions = [item["action"] for item in reversed(support.audits_since(client, mark))
               if item["target_type"] == "report" and item["target_id"] == str(report_id)]
    assert actions == ["ai_report_generation_failed", "ai_report_generation_retried", "ai_report_generation_failed",
                       "ai_report_generation_retried", "ai_report_generated"]
    # 生成成功后照常复核、确认、导出。
    assert client.post(f"/api/reports/{report_id}/confirm", headers=REVIEWER, json={"reason": "已核对原始回答"}).status_code == 200
    assert client.get(f"/api/reports/{report_id}/export", headers=REVIEWER).status_code == 200


def test_model_service_message_is_kept_as_failure_reason(client, answered, monkeypatch):
    _, h, interview_id = answered
    monkeypatch.setattr(report_builder, "build_report", failing(HTTPException(502, "AI服务返回异常，请稍后重试")))
    submitted = client.post(f"/api/interviews/{interview_id}/submit", headers=h).json()
    assert submitted["status"] == "generation_failed"
    assert report_row(submitted["report_id"])[2] == "AI服务返回异常，请稍后重试"
    monkeypatch.setattr(report_builder, "build_report", failing(ValueError("回答" * 400)))
    retried = client.post(f"/api/reports/{submitted['report_id']}/retry-generation", headers=REVIEWER).json()
    assert retried["status"] == "generation_failed" and len(retried["generation_error"]) == 500


def test_report_is_locked_while_generating(client, answered, monkeypatch):
    """正式环境报告在后台线程生成；生成期间报告处于“生成中”，不能修改、确认或导出。"""
    person, h, interview_id = answered
    scheduled = []
    monkeypatch.setattr(report_builder, "is_test_runtime", lambda: False)
    monkeypatch.setattr(report_builder.background, "run_later", scheduled.append)
    submitted = client.post(f"/api/interviews/{interview_id}/submit", headers=h)
    assert submitted.status_code == 200 and submitted.json()["status"] == "generating"
    report_id = submitted.json()["report_id"]
    assert len(scheduled) == 1
    assert report_row(report_id) == ("generating", 0, "", [])
    assert support.my_interview(client, h)["status"] == "completed"
    rejected = [
        client.put(f"/api/reports/{report_id}", headers=REVIEWER, json={"content": {"summary": "人工填写"}, "reason": "尝试修改"}),
        client.post(f"/api/reports/{report_id}/confirm", headers=REVIEWER, json={"reason": "尝试确认"}),
        client.post(f"/api/reports/{report_id}/return", headers=REVIEWER, json={"reason": "尝试退回"}),
        client.post(f"/api/reports/{report_id}/regenerate", headers=REVIEWER, json={"expected_version": 1}),
        client.post(f"/api/reports/{report_id}/retry-generation", headers=REVIEWER),
        client.get(f"/api/reports/{report_id}/export", headers=REVIEWER),
    ]
    assert [response.status_code for response in rejected] == [409] * 6
    assert client.get(f"/api/comparison?candidate_ids={person['id']}", headers=REVIEWER).json()["items"] == []
    state = client.get(f"/api/listening/{person['id']}", headers=support.staff("interviewer", "interviewer")).json()
    assert state["stage_one"] is None and state["mode"] == "standalone"
    # 后台处理完成后进入人工复核。
    scheduled.pop()()
    assert report_row(report_id) == ("pending_review", 1, "", [(1, "ai_original")])
    assert client.post(f"/api/reports/{report_id}/confirm", headers=REVIEWER, json={"reason": "已核对原始回答"}).status_code == 200


def test_generation_for_a_removed_interview_is_ignored(client):
    # 后台开始处理时面试记录已不存在（例如候选人被清理），不应报错或留下半成品。
    before = None
    with SessionLocal() as db:
        before = db.query(Report).count()
    report_builder.generate_report(999999, {"role": "candidate", "user": "nobody"})
    with SessionLocal() as db:
        assert db.query(Report).count() == before
        assert db.get(Interview, 999999) is None


def test_workbench_counts_failed_and_pending_reports(client, answered, monkeypatch):
    _, h, interview_id = answered
    admin = support.staff()
    before = client.get("/api/overview", headers=admin).json()["interview"]
    monkeypatch.setattr(report_builder, "build_report", failing(RuntimeError("模型不可用")))
    report_id = client.post(f"/api/interviews/{interview_id}/submit", headers=h).json()["report_id"]
    failed = client.get("/api/overview", headers=REVIEWER).json()
    assert failed["interview"]["reports_failed"] == before["reports_failed"] + 1
    assert failed["interview"]["reports_pending"] == before["reports_pending"]
    assert failed["interview"]["completed"] == before["completed"] + 1
    assert any(item["count"] == failed["interview"]["reports_failed"] and "生成失败" in item["title"] for item in failed["todo"])
    # 面试官不能重新生成报告，待办里不出现这一项。
    interviewer = client.get("/api/overview", headers=support.staff("interviewer", "interviewer")).json()
    assert interviewer["interview"]["reports_failed"] == failed["interview"]["reports_failed"]
    assert not any("生成失败" in item["title"] for item in interviewer["todo"])
    monkeypatch.undo()
    assert client.post(f"/api/reports/{report_id}/retry-generation", headers=REVIEWER).status_code == 200
    after = client.get("/api/overview", headers=REVIEWER).json()["interview"]
    assert after["reports_failed"] == before["reports_failed"]
    assert after["reports_pending"] == before["reports_pending"] + 1


def test_confirmed_conclusion_is_synced_to_the_person_library(client, created):
    hr = support.staff("hr_admin", "hr")
    people = support.create_person_batch(client, created, "报告同步测试人员批次")
    person = support.import_persons(client, people["id"], [("同步人员.txt", support.resume_text("同步人员").encode("utf-8"))])["imported"][0]
    batch = support.create_batch(client, created, "SYNC-B1", "报告同步测试批次")
    support.publish_questions(client, batch["id"], count=6)
    imported = client.post("/api/candidates/import", headers=hr, json={"batch_id": batch["id"], "person_ids": [person["id"]]}).json()
    created.candidates.append(imported["candidates"][0]["id"])
    h = support.candidate(imported["credentials"][0]["username"])
    interview = support.prepare_interview(client, h)
    support.answer_all(client, h, interview)
    report_id = client.post(f"/api/interviews/{interview['id']}/submit", headers=h).json()["report_id"]
    report = client.get(f"/api/reports/{report_id}", headers=REVIEWER).json()
    assert report["candidate"]["library_person_id"] == person["id"]
    # 硬指标来自人员库档案，单独呈现，不计入六维评分。
    indicators = report["current_content"]["hard_indicators"]
    assert indicators["available"] is True and indicators["counted_in_score"] is False
    assert {item["key"]: item["value"] for item in indicators["facts"]}["education"] == "本科，人力资源管理专业"
    assert report["current_content"]["resume_context"]["source"] == "人员库"
    before = client.get(f"/api/library/persons/{person['id']}", headers=hr).json()
    assert {item["key"]: item["value"] for item in before["profile"]["fields"]}["interview_evaluation"] == ""

    # 未确认的报告不进入人员库。
    assert client.post(f"/api/reports/{report_id}/return", headers=REVIEWER, json={"reason": "补充依据"}).status_code == 200
    assert client.get(f"/api/library/persons/{person['id']}", headers=hr).json()["material_version"] == 0
    mark, core_mark = support.audit_mark(client), support.audit_mark(client, "matching")
    confirmed = client.post(f"/api/reports/{report_id}/confirm", headers=REVIEWER, json={"reason": "已核对原始回答"})
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "confirmed"
    assert "已同步" in confirmed.json()["library_sync"]
    after = client.get(f"/api/library/persons/{person['id']}", headers=hr).json()
    fields = {item["key"]: item for item in after["profile"]["fields"]}
    evaluation = fields["interview_evaluation"]["value"]
    assert "AI面试" in evaluation and "报告同步测试批次" in evaluation and f"{report['match_score']:g}%" in evaluation
    assert all(item["dimension"] in evaluation for item in report["current_content"]["evaluations"])
    assert "4/5" in evaluation and report["current_content"]["summary"] in evaluation
    # 同步进来的面试结论需要在人员库中再核对确认；简历里原有的内容不变。
    assert after["material_version"] == 1 and after["confirmed"] is False
    assert fields["education"]["value"] == "本科，人力资源管理专业" and fields["interview_evaluation"]["source_file"] == "人工核实记录"
    assert [item["candidate_id"] for item in after["interviews"]] == [imported["candidates"][0]["id"]]
    assert after["interviews"][0]["report_status"] == "confirmed" and after["interviews"][0]["match_score"] == report["match_score"]
    audits = support.audits_since(client, mark)
    assert [item["action"] for item in reversed(audits)] == ["human_report_confirmed", "interview_result_synced"]
    assert "已同步" in audits[0]["detail"]
    core = support.audits_since(client, core_mark, source="matching")
    assert [(item["action"], item["target_id"], item["actor"]) for item in core] == [("修改人员资料", person["id"], "report_reviewer")]
    result = client.get(f"/api/matching/interview-results/{imported['candidates'][0]['id']}", headers=REVIEWER).json()
    assert result["library_person_id"] == person["id"] and result["review_status"] == "confirmed"
