import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from backend.app.core.database import SessionLocal
from backend.app.interview.models import Answer, Candidate, Interview, Question, Report, ReportVersion, User

from .support import purge_candidates


PROFILE = {"phone": "13800000000", "email": "flow@example.com", "education": "本科", "major": "食品科学", "years": "应届生"}
MIC = {"passed": True, "peak_rms": 0.08, "speech_frames": 12, "duration_ms": 3200, "speech_text": "麦克风测试一二三"}


@pytest.fixture
def interview_record(client):
    candidate_ids = []

    def create(status="ready"):
        with SessionLocal() as db:
            question = db.query(Question).filter_by(sequence=1, status="published").order_by(Question.id).first()
            username = "flow-" + uuid4().hex[:16]
            candidate = Candidate(code=username, name="流程测试", batch_id=question.batch_id,
                                  job_id=question.job_id, profile_json=json.dumps(PROFILE))
            db.add(candidate)
            db.flush()
            candidate_ids.append(candidate.id)
            stamp = datetime.now(timezone.utc)
            interview = Interview(candidate_id=candidate.id, batch_id=question.batch_id,
                                  job_id=question.job_id, question_version=question.version,
                                  status=status, consented=True, mic_checked=True,
                                  current_question=7 if status == "completed" else 1,
                                  started_at=stamp if status in ("in_progress", "completed") else None,
                                  completed_at=stamp if status == "completed" else None)
            db.add(interview)
            db.add(User(username=username, display_name="流程测试", role="candidate", candidate_id=candidate.id))
            db.flush()
            answer_id = None
            if status in ("in_progress", "completed"):
                answer = Answer(interview_id=interview.id, question_id=question.id, answer_code=username,
                                transcript="原始主体回答", followup_text="原始追问", followup_answer="原始追问回答")
                db.add(answer)
                db.flush()
                answer_id = answer.id
            if status == "completed":
                report = Report(interview_id=interview.id, candidate_id=candidate.id)
                db.add(report)
                db.flush()
                db.add(ReportVersion(report_id=report.id, version=1, version_type="ai_original",
                                     content='{"summary":"原始报告"}', editor="测试"))
            db.commit()
            return interview.id, question.id, answer_id, {"X-User-Role": "candidate", "X-User-Name": username}
    yield create
    # 这些记录直接写入测试库，用完即清理，不留在报告、对比等列表里。
    purge_candidates(candidate_ids)


def frozen_records(interview_id):
    with SessionLocal() as db:
        interview = db.get(Interview, interview_id)
        answers = db.query(Answer).filter_by(interview_id=interview_id).order_by(Answer.id).all()
        report = db.query(Report).filter_by(interview_id=interview_id).first()
        versions = db.query(ReportVersion).filter_by(report_id=report.id).all() if report else []
        return (
            interview.status, interview.started_at, interview.completed_at, interview.current_question,
            interview.candidate.profile_json,
            [(a.id, a.transcript, a.followup_answer, a.recording_path) for a in answers],
            [(v.id, v.content, v.version) for v in versions],
        )


@pytest.mark.parametrize("status", ["in_progress", "completed"])
def test_started_interview_cannot_reset_or_return_to_preparation(client, interview_record, status):
    iid, _, _, h = interview_record(status)
    before = frozen_records(iid)
    for path, body in [("reset", None), ("start", None), ("mic-check", MIC), ("mic-check", {"passed": False})]:
        response = client.post(f"/api/interviews/{iid}/{path}", headers=h, json=body)
        assert response.status_code == 409, response.text
    response = client.put("/api/interviews/me/profile", headers=h, json={**PROFILE, "major": "新专业"})
    assert response.status_code == 409
    assert frozen_records(iid) == before


@pytest.mark.parametrize("status", ["in_progress", "completed"])
def test_consent_changes_never_reopen_interview(client, interview_record, status):
    iid, _, _, h = interview_record(status)
    before = frozen_records(iid)
    notice = client.get("/api/interviews/me", headers=h).json()["available_consent_version"]
    for accepted in [False, True]:
        response = client.post(f"/api/interviews/{iid}/consent", headers=h,
                               json={"consented": accepted, "notice_version": notice})
        assert response.status_code == 200
        assert response.json()["status"] == status
        assert client.post(f"/api/interviews/{iid}/mic-check", headers=h, json=MIC).status_code == 409
        assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
    assert frozen_records(iid) == before


def test_completed_answers_and_report_cannot_be_overwritten(client, interview_record):
    iid, qid, aid, h = interview_record("completed")
    before = frozen_records(iid)
    for path, body in [
        ("answers", {"question_id": qid, "transcript": "再次回答"}),
        (f"answers/{aid}/followup", {"transcript": "再次追问"}),
        (f"audio/{qid}", {"data_url": "data:audio/webm;base64,AAAA"}),
        ("submit", None),
    ]:
        assert client.post(f"/api/interviews/{iid}/{path}", headers=h, json=body).status_code == 409
    assert frozen_records(iid) == before


def test_preparation_can_edit_and_recheck_then_start_only_once(client, interview_record):
    iid, _, _, h = interview_record()
    assert client.put("/api/interviews/me/profile", headers=h, json={**PROFILE, "major": "制造工程"}).status_code == 200
    assert client.post(f"/api/interviews/{iid}/consent", headers=h, json={"consented": False}).status_code == 200
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
    assert client.post(f"/api/interviews/{iid}/consent", headers=h, json={"consented": True}).status_code == 200
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
    assert client.post(f"/api/interviews/{iid}/mic-check", headers=h, json=MIC).status_code == 200
    assert client.post(f"/api/interviews/{iid}/mic-check", headers=h, json={"passed": False}).status_code == 200
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
    assert client.post(f"/api/interviews/{iid}/mic-check", headers=h, json=MIC).status_code == 200
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 200
    started = frozen_records(iid)
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
    assert frozen_records(iid) == started
    assert client.get("/api/interviews/me", headers=h).json()["status"] == "in_progress"


def test_missing_profile_cannot_skip_preparation_and_does_not_reopen_completed(client, interview_record):
    for status in ["ready", "completed"]:
        iid, _, _, h = interview_record(status)
        with SessionLocal() as db:
            db.get(Interview, iid).candidate.profile_json = "{}"
            db.commit()
        state = client.get("/api/interviews/me", headers=h).json()
        assert state["status"] == status
        assert state["needs_profile"] is (status == "ready")
        assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 409
        assert client.post(f"/api/interviews/{iid}/mic-check", headers=h, json=MIC).status_code == 409
        if status == "ready":
            # 账号登录的候选人须先填写个人信息，才能确认合规告知。
            notice = state["available_consent_version"]
            assert client.post(f"/api/interviews/{iid}/consent", headers=h,
                               json={"consented": True, "notice_version": notice}).status_code == 409
            assert client.get("/api/interviews/me", headers=h).json()["status"] == "ready"


def test_legacy_reset_preserves_ownership_check(client, interview_record):
    iid, _, _, _ = interview_record("completed")
    _, _, _, other = interview_record()
    assert client.post(f"/api/interviews/{iid}/reset", headers=other).status_code == 403


def test_reset_is_rejected_even_before_the_interview_starts(client, interview_record):
    # 重置接口只为旧客户端保留：任何阶段都不删除面试记录，也不改变准备进度。
    iid, _, _, h = interview_record()
    before = frozen_records(iid)
    assert client.post(f"/api/interviews/{iid}/reset", headers=h).status_code == 409
    assert frozen_records(iid) == before
    assert client.post("/api/interviews/999999/reset", headers=h).status_code == 404
    staff = {"X-User-Role": "hr_admin", "X-User-Name": "hr"}
    assert client.post(f"/api/interviews/{iid}/reset", headers=staff).status_code == 403
    assert client.post(f"/api/interviews/{iid}/start", headers=h).status_code == 200
