"""线下集中面试的现场入口：开启、查看、关闭，候选人免登录进入，以及入口凭证的使用范围。"""
from datetime import timedelta

import pytest

from backend.app.core import security
from backend.app.core.database import SessionLocal
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview.common import now
from backend.app.interview.models import Interview, OnsiteEntry

from . import support

HR = support.staff("hr_admin", "hr")


@pytest.fixture
def onsite_batch(client, created):
    """一个已发布题目的批次和两名尚未开始面试的候选人。"""
    batch = support.create_batch(client, created, "ONSITE-B1", "线下集中面试测试批次")
    support.publish_questions(client, batch["id"], count=3)
    first = support.create_candidate(client, created, batch["id"], "现场候选人甲", create_login=False)
    second = support.create_candidate(client, created, batch["id"], "现场候选人乙")
    return batch, first, second


def open_entry(client, batch_id, **body):
    response = client.post(f"/api/batches/{batch_id}/onsite-entries", headers=HR, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def start_session(client, entry, candidate_id):
    response = client.post("/api/onsite/sessions", headers=support.bearer(entry["entry_token"]), json={"candidate_id": candidate_id})
    assert response.status_code == 200, response.text
    return response.json()


def interview_of(candidate_id):
    with SessionLocal() as db:
        item = db.query(Interview).filter_by(candidate_id=candidate_id).one()
        return {name: getattr(item, name) for name in (
            "id", "status", "consented", "consent_version", "consent_method", "consent_recorded_by", "entry_mode",
            "consented_at", "mic_checked")}


def test_entry_can_be_created_listed_and_revoked_by_staff_who_manage_onsite(client, onsite_batch):
    batch, _, _ = onsite_batch
    mark = support.audit_mark(client)
    for role in ("interviewer", "report_reviewer", "question_reviewer", "business_user", "candidate"):
        denied = client.post(f"/api/batches/{batch['id']}/onsite-entries", headers=support.staff(role, role), json={})
        assert denied.status_code == 403, role
        assert client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=support.staff(role, role)).status_code == 403
    assert client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=HR).json() == []

    entry = open_entry(client, batch["id"], consent_attested=True, hours=2)
    assert entry["batch_id"] == batch["id"] and entry["created_by"] == "hr" and entry["active"] is True
    assert entry["consent_attested"] is True and entry["revoked_at"] is None
    assert entry["notice_version"] == intelligence.current_notice()[0]
    claims = security.verify(entry["entry_token"])
    assert claims["role"] == "onsite" and claims["source"] == "onsite_entry" and claims["batch_id"] == batch["id"]
    assert claims["exp"] == entry["token_expires_at"]
    assert 0 <= 2 * 3600 - (claims["exp"] - int(now().timestamp())) <= 10
    default = open_entry(client, batch["id"])
    assert default["consent_attested"] is False
    assert 0 <= 8 * 3600 - (default["token_expires_at"] - int(now().timestamp())) <= 10

    # 入口凭证只在开启时返回一次，列表中不再出现。
    listed = client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=support.staff()).json()
    assert [item["id"] for item in listed] == [default["id"], entry["id"]]
    assert all("entry_token" not in item and "token_id" not in item for item in listed)
    assert entry["entry_token"] not in client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=HR).text

    assert client.delete(f"/api/onsite-entries/{entry['id']}", headers=support.staff("interviewer", "interviewer")).status_code == 403
    revoked = client.delete(f"/api/onsite-entries/{entry['id']}", headers=HR)
    assert revoked.status_code == 200 and revoked.json()["active"] is False and revoked.json()["revoked_at"]
    again = client.delete(f"/api/onsite-entries/{entry['id']}", headers=HR)
    assert again.status_code == 200 and again.json()["revoked_at"] == revoked.json()["revoked_at"]
    assert client.delete("/api/onsite-entries/999999", headers=HR).status_code == 404
    states = {item["id"]: item["active"] for item in client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=HR).json()}
    assert states == {entry["id"]: False, default["id"]: True}
    actions = [item["action"] for item in support.audits_since(client, mark) if item["target_id"] == str(batch["id"])]
    assert sorted(actions) == ["onsite_entry_created", "onsite_entry_created", "onsite_entry_revoked"]


def test_entry_is_only_for_active_ai_interview_batches(client, created):
    assert client.post("/api/batches/999999/onsite-entries", headers=HR, json={}).status_code == 404
    draft = support.create_batch(client, created, "ONSITE-DRAFT", "尚未发布题目的批次")
    assert client.post(f"/api/batches/{draft['id']}/onsite-entries", headers=HR, json={}).status_code == 409
    listening_only = support.create_batch(client, created, "ONSITE-LISTEN", "仅旁听批次", mode="listening_only")
    assert client.post(f"/api/batches/{listening_only['id']}/onsite-entries", headers=HR, json={}).status_code == 409
    support.publish_questions(client, draft["id"], count=3)
    for hours in (0, 73, -1, "一天"):
        assert client.post(f"/api/batches/{draft['id']}/onsite-entries", headers=HR, json={"hours": hours}).status_code == 422
    assert client.post(f"/api/batches/{draft['id']}/onsite-entries", headers=HR, json={"hours": 72}).status_code == 200


def test_candidate_list_shows_only_name_code_and_status(client, onsite_batch, created):
    batch, first, second = onsite_batch
    with SessionLocal() as db:
        db.query(Interview).filter_by(candidate_id=second["id"]).update({"status": "completed", "completed_at": now()})
        db.commit()
    other = support.create_candidate(client, created, support.seed_batch()["id"], "其他批次候选人")
    entry = open_entry(client, batch["id"], consent_attested=True)
    response = client.get("/api/onsite/candidates", headers=support.bearer(entry["entry_token"]))
    assert response.status_code == 200
    body = response.json()
    assert body["batch"] == {"id": batch["id"], "name": batch["name"], "job_name": batch["job_name"]}
    assert body["consent_attested"] is True and body["expires_at"]
    assert body["candidates"] == [
        {"id": first["id"], "code": first["code"], "name": "现场候选人甲", "status": "waiting"},
        {"id": second["id"], "code": second["code"], "name": "现场候选人乙", "status": "completed"},
    ]
    assert other["code"] not in response.text
    # 只能为本批次、尚未提交面试的候选人开始面试。
    token = support.bearer(entry["entry_token"])
    assert client.post("/api/onsite/sessions", headers=token, json={"candidate_id": other["id"]}).status_code == 404
    assert client.post("/api/onsite/sessions", headers=token, json={"candidate_id": 999999}).status_code == 404
    assert client.post("/api/onsite/sessions", headers=token, json={"candidate_id": second["id"]}).status_code == 409
    assert client.post("/api/onsite/sessions", headers=token, json={}).status_code == 422
    assert interview_of(other["id"])["entry_mode"] == "account"


def test_attested_consent_skips_profile_and_notice(client, onsite_batch):
    batch, first, _ = onsite_batch
    mark = support.audit_mark(client)
    before = interview_of(first["id"])
    assert (before["status"], before["consented"], before["entry_mode"]) == ("consent_pending", False, "account")
    entry = open_entry(client, batch["id"], consent_attested=True, hours=1)
    session = start_session(client, entry, first["id"])
    assert session["role"] == "candidate" and session["entry_mode"] == "onsite" and session["candidate_id"] == first["id"]
    assert session["username"] == first["code"] and session["permissions"] == ["interview:use"]
    claims = security.verify(session["access_token"])
    assert claims["candidate_id"] == first["id"] and claims["role"] == "candidate" and claims["source"] == "onsite"
    assert claims["sub"] == first["code"] and claims["exp"] == session["expires_at"]
    assert 0 <= 4 * 3600 - (claims["exp"] - int(now().timestamp())) <= 10

    saved = interview_of(first["id"])
    assert saved["status"] == "mic_check" and saved["consented"] is True and saved["consented_at"] is not None
    assert saved["consent_method"] == "offline_attested" and saved["consent_recorded_by"] == "hr"
    assert saved["consent_version"] == intelligence.current_notice()[0] and saved["entry_mode"] == "onsite"

    # 没有登录账号的候选人凭现场会话直接进入设备检测：不填个人信息，也不再确认合规须知。
    h = support.bearer(session["access_token"])
    me = client.get("/api/interviews/me", headers=h).json()
    assert me["id"] == saved["id"] and me["candidate"] == {"code": first["code"], "name": "现场候选人甲"}
    assert me["entry_mode"] == "onsite" and me["consent_method"] == "offline_attested" and me["status"] == "mic_check"
    assert me["needs_profile"] is False and me["profile_complete"] is False and me["needs_consent"] is False
    support.start_after_consent(client, h, me["id"])
    interview = support.my_interview(client, h)
    assert interview["status"] == "in_progress" and len(interview["questions"]) == 3
    support.answer_all(client, h, interview)
    submitted = client.post(f"/api/interviews/{me['id']}/submit", headers=h)
    assert submitted.status_code == 200 and submitted.json()["status"] == "pending_review"
    row = next(item for item in client.get(f"/api/candidates?batch_id={batch['id']}", headers=HR).json() if item["id"] == first["id"])
    assert row["interview_status"] == "completed" and row["entry_mode"] == "onsite" and row["has_login"] is False
    assert row["profile"] == {}
    audits = support.audits_since(client, mark, keyword=first["code"])
    actions = {item["action"]: item for item in audits}
    assert {"onsite_session_started", "candidate_consented", "interview_started", "interview_submitted"} <= set(actions)
    # 同意记录写明是哪位工作人员在现场确认的。
    assert "hr" in actions["candidate_consented"]["detail"] and "现场" in actions["candidate_consented"]["detail"]
    assert actions["onsite_session_started"]["actor"] == first["code"]
    # 面试提交后不能再从现场入口重新进入。
    assert client.post("/api/onsite/sessions", headers=support.bearer(entry["entry_token"]),
                       json={"candidate_id": first["id"]}).status_code == 409


def test_without_attested_consent_candidate_still_confirms_the_notice(client, onsite_batch):
    batch, first, _ = onsite_batch
    entry = open_entry(client, batch["id"], consent_attested=False)
    session = start_session(client, entry, first["id"])
    saved = interview_of(first["id"])
    assert saved["status"] == "consent_pending" and saved["consented"] is False and saved["entry_mode"] == "onsite"
    assert saved["consent_method"] == "online" and saved["consent_recorded_by"] == ""
    h = support.bearer(session["access_token"])
    me = client.get("/api/interviews/me", headers=h).json()
    assert me["needs_profile"] is False and me["consented"] is False and me["status"] == "consent_pending"
    assert me["consent_text"] and me["available_consent_version"] == intelligence.current_notice()[0]
    assert client.post(f"/api/interviews/{me['id']}/mic-check", headers=h, json=support.MIC).status_code == 409
    assert client.post(f"/api/interviews/{me['id']}/start", headers=h).status_code == 409
    declined = client.post(f"/api/interviews/{me['id']}/consent", headers=h, json={"consented": False})
    assert declined.json() == {"ok": True, "status": "consent_declined"}
    assert client.post(f"/api/interviews/{me['id']}/mic-check", headers=h, json=support.MIC).status_code == 409
    # 现场入口的候选人不需要先填写个人信息就可以确认合规须知。
    accepted = client.post(f"/api/interviews/{me['id']}/consent", headers=h,
                           json={"consented": True, "notice_version": me["available_consent_version"]})
    assert accepted.json() == {"ok": True, "status": "mic_check"}
    saved = interview_of(first["id"])
    assert saved["consent_method"] == "online" and saved["consent_recorded_by"] == first["code"]
    assert saved["consent_version"] == intelligence.current_notice()[0]
    support.start_after_consent(client, h, me["id"])
    assert support.my_interview(client, h)["status"] == "in_progress"


def test_reentering_does_not_change_an_interview_in_progress(client, onsite_batch):
    batch, first, _ = onsite_batch
    attested = open_entry(client, batch["id"], consent_attested=True)
    h = support.bearer(start_session(client, attested, first["id"])["access_token"])
    support.start_after_consent(client, h, interview_of(first["id"])["id"])
    started = interview_of(first["id"])
    assert started["status"] == "in_progress"
    # 设备刷新或换一个入口重新选择本人：继续原来的面试，同意记录和进度不变。
    plain = open_entry(client, batch["id"], consent_attested=False)
    again = support.bearer(start_session(client, plain, first["id"])["access_token"])
    assert interview_of(first["id"]) == started
    assert support.my_interview(client, again)["status"] == "in_progress"


def test_onsite_session_is_limited_to_the_selected_candidate(client, onsite_batch):
    batch, first, second = onsite_batch
    entry = open_entry(client, batch["id"], consent_attested=True)
    h = support.bearer(start_session(client, entry, first["id"])["access_token"])
    other = interview_of(second["id"])
    assert client.post(f"/api/interviews/{other['id']}/consent", headers=h, json={"consented": True}).status_code == 403
    assert client.post(f"/api/interviews/{other['id']}/mic-check", headers=h, json=support.MIC).status_code == 403
    assert client.post(f"/api/interviews/{other['id']}/start", headers=h).status_code == 403
    assert interview_of(second["id"]) == other
    for path in ("/api/candidates", "/api/batches", "/api/reports", "/api/overview", f"/api/batches/{batch['id']}/onsite-entries"):
        assert client.get(path, headers=h).status_code == 403, path
    # 候选人会话不能当作现场入口使用。
    assert client.get("/api/onsite/candidates", headers=h).status_code == 401
    assert client.post("/api/onsite/sessions", headers=h, json={"candidate_id": second["id"]}).status_code == 401


def test_entry_token_is_rejected_by_ordinary_endpoints(client, onsite_batch):
    batch, first, _ = onsite_batch
    entry = open_entry(client, batch["id"], consent_attested=True)
    token = support.bearer(entry["entry_token"])
    interview = interview_of(first["id"])
    requests = [
        ("get", "/api/interviews/me", None), ("get", "/api/candidates", None), ("get", "/api/batches", None),
        ("get", "/api/jobs", None), ("get", "/api/reports", None), ("get", "/api/overview", None), ("get", "/api/audits", None),
        ("get", "/api/auth/session", None), ("get", "/api/library/jobs", None), ("get", "/api/matching/tasks", None),
        ("get", f"/api/batches/{batch['id']}/onsite-entries", None), ("get", "/api/config/consent-notice", None),
        ("post", f"/api/batches/{batch['id']}/onsite-entries", {}), ("post", f"/api/interviews/{interview['id']}/consent", {"consented": True}),
        ("post", f"/api/interviews/{interview['id']}/start", None), ("post", "/api/candidates", {"name": "越权", "batch_id": batch["id"]}),
        ("delete", f"/api/onsite-entries/{entry['id']}", None),
    ]
    for method, path, body in requests:
        response = client.request(method, path, headers=token, json=body)
        assert response.status_code == 403, (method, path, response.text)
    assert interview_of(first["id"]) == interview
    assert client.get("/api/onsite/candidates", headers=token).status_code == 200


def test_onsite_endpoints_require_a_valid_entry_token(client, onsite_batch, monkeypatch):
    batch, first, _ = onsite_batch
    entry = open_entry(client, batch["id"], consent_attested=True)
    candidate_login, _ = security.issue("candidate", "candidate")
    admin_entry = client.post("/api/auth/admin-entry").json()["access_token"]
    forged, _ = security.issue("onsite-entry:1", "onsite", source="password", entry="unknown", batch_id=batch["id"])
    unknown_entry, _ = security.issue("onsite-entry:1", "onsite", source="onsite_entry", entry="unknown", batch_id=batch["id"])
    expired_token, _ = security.issue(f"onsite-entry:{entry['id']}", "onsite", source="onsite_entry", ttl=-5,
                                      entry=security.verify(entry["entry_token"])["entry"], batch_id=batch["id"])
    invalid = [None, {}, HR, support.staff(), {"Authorization": entry["entry_token"]}, support.bearer("not-a-token"),
               support.bearer(entry["entry_token"][:-3] + "abc"), support.bearer(candidate_login), support.bearer(admin_entry),
               support.bearer(forged), support.bearer(unknown_entry), support.bearer(expired_token)]
    for headers in invalid:
        assert client.get("/api/onsite/candidates", headers=headers).status_code == 401, headers
        assert client.post("/api/onsite/sessions", headers=headers, json={"candidate_id": first["id"]}).status_code == 401, headers
    assert interview_of(first["id"])["entry_mode"] == "account"
    # 入口凭证由签名保护：更换签名密钥后，已发放的凭证全部失效。
    monkeypatch.setenv("TALENTFLOW_SESSION_SECRET", "rotated-signing-secret-for-onsite-entry-test")
    assert client.get("/api/onsite/candidates", headers=support.bearer(entry["entry_token"])).status_code == 401
    monkeypatch.delenv("TALENTFLOW_SESSION_SECRET")
    assert client.get("/api/onsite/candidates", headers=support.bearer(entry["entry_token"])).status_code == 200


def test_revoked_or_expired_entry_stops_working(client, onsite_batch):
    batch, first, second = onsite_batch
    revoked, expiring = open_entry(client, batch["id"], consent_attested=True), open_entry(client, batch["id"], hours=1)
    assert client.delete(f"/api/onsite-entries/{revoked['id']}", headers=HR).status_code == 200
    with SessionLocal() as db:
        db.get(OnsiteEntry, expiring["id"]).expires_at = now() - timedelta(seconds=1)
        db.commit()
    for entry in (revoked, expiring):
        token = support.bearer(entry["entry_token"])
        closed = client.get("/api/onsite/candidates", headers=token)
        assert closed.status_code == 401 and "重新开启" in closed.json()["detail"]
        assert client.post("/api/onsite/sessions", headers=token, json={"candidate_id": first["id"]}).status_code == 401
    assert interview_of(first["id"])["entry_mode"] == "account" and interview_of(first["id"])["consented"] is False
    listed = {item["id"]: item["active"] for item in client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=HR).json()}
    assert listed == {revoked["id"]: False, expiring["id"]: False}
    # 重新开启一个入口即可继续；已关闭的入口不受影响。
    fresh = open_entry(client, batch["id"], consent_attested=True)
    assert start_session(client, fresh, second["id"])["candidate_id"] == second["id"]
    assert client.get("/api/onsite/candidates", headers=support.bearer(revoked["entry_token"])).status_code == 401


def test_staff_reopen_their_open_entry_instead_of_creating_a_new_one_each_time(client, onsite_batch):
    """管理端的“现场面试”按钮：同一个人、同一批次、同样的告知方式，沿用已开启的入口。"""
    batch, first, second = onsite_batch
    mark = support.audit_mark(client)
    opened = open_entry(client, batch["id"], consent_attested=True, reuse=True)
    assert opened["reused"] is False
    again = open_entry(client, batch["id"], consent_attested=True, reuse=True)
    assert again["reused"] is True and again["id"] == opened["id"] and again["active"] is True
    first_claims, claims = security.verify(opened["entry_token"]), security.verify(again["entry_token"])
    # 新凭证绑定的是同一个入口，有效期不超过该入口的到期时间。
    assert claims["entry"] == first_claims["entry"] and claims["batch_id"] == batch["id"]
    assert claims["exp"] <= first_claims["exp"] + 2 and again["expires_at"] == opened["expires_at"]
    assert start_session(client, again, first["id"])["candidate_id"] == first["id"]
    assert [item["id"] for item in client.get(f"/api/batches/{batch['id']}/onsite-entries", headers=HR).json()] == [opened["id"]]

    # 告知方式不同、别人开启的入口不沿用。
    unattested = open_entry(client, batch["id"], consent_attested=False, reuse=True)
    assert unattested["reused"] is False and unattested["id"] != opened["id"]
    colleague = client.post(f"/api/batches/{batch['id']}/onsite-entries", headers=support.staff("hr_admin", "hr2"),
                            json={"consent_attested": True, "reuse": True}).json()
    assert colleague["reused"] is False and colleague["created_by"] == "hr2"

    # 剩余时间不足一小时的不沿用，避免面试中途到期。
    with SessionLocal() as db:
        db.get(OnsiteEntry, opened["id"]).expires_at = now() + timedelta(minutes=30)
        db.commit()
    renewed = open_entry(client, batch["id"], consent_attested=True, reuse=True)
    assert renewed["reused"] is False and renewed["id"] not in (opened["id"], unattested["id"], colleague["id"])

    # 关闭入口后，由它发出的所有凭证一并失效，也不再被沿用。
    assert client.delete(f"/api/onsite-entries/{renewed['id']}", headers=HR).status_code == 200
    assert client.get("/api/onsite/candidates", headers=support.bearer(renewed["entry_token"])).status_code == 401
    after = open_entry(client, batch["id"], consent_attested=True, reuse=True)
    assert after["reused"] is False and after["id"] != renewed["id"]
    assert start_session(client, after, second["id"])["candidate_id"] == second["id"]

    actions = [item["action"] for item in support.audits_since(client, mark) if item["target_id"] == str(batch["id"])]
    assert actions.count("onsite_entry_reopened") == 1 and actions.count("onsite_entry_created") == 5
    for role in ("interviewer", "report_reviewer", "business_user", "candidate"):
        denied = client.post(f"/api/batches/{batch['id']}/onsite-entries", headers=support.staff(role, role), json={"reuse": True})
        assert denied.status_code == 403, role
