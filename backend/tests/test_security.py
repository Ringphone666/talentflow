"""口令强度、随机密码、签名会话，以及候选人登录的失败锁定与重置解锁。"""
import base64
import json
from datetime import timedelta

import pytest

from backend.app.core import security
from backend.app.core.database import SessionLocal
from backend.app.interview.common import now
from backend.app.interview.models import User

from . import support


# ---- 口令强度与随机密码 -----------------------------------------------------------

@pytest.mark.parametrize("password,problem", [
    ("Ab1@xyz", "长度不少于8位"),
    ("abcdef1@gh", "需包含大写字母"),
    ("ABCDEF1@GH", "需包含小写字母"),
    ("Abcdefg@hi", "需包含数字"),
    ("Abcdefg1hi", "需包含特殊字符"),
])
def test_each_strength_rule_is_reported(password, problem):
    assert security.password_problems(password) == [problem]


def test_strong_password_passes_and_weak_password_lists_every_problem():
    assert security.password_problems("Xj#2026-Interview") == []
    assert security.password_problems("") == ["长度不少于8位", "需包含大写字母", "需包含小写字母", "需包含数字", "需包含特殊字符"]
    assert security.password_problems("12345678") == ["需包含大写字母", "需包含小写字母", "需包含特殊字符"]


def test_password_must_not_contain_the_login_account():
    assert security.password_problems("Cand2026-001#Ab", "cand2026-001") == ["不得包含登录账号"]
    assert security.password_problems("Xy#CAND2026-001z", "Cand2026-001") == ["不得包含登录账号"]
    # 过短的账号（如编号“1”）几乎必然出现在密码里，不作此项要求。
    assert security.password_problems("Ab1@xyzw", "1") == []
    assert security.password_problems("Ab1@xyzw", "b1") == []
    assert security.password_problems("Ab1@xyzw", "") == []


def test_generated_passwords_are_random_and_always_meet_the_policy():
    confusing = set("0O1lI")
    passwords = [security.generate_password("2026-D01-001") for _ in range(200)]
    assert len(set(passwords)) == 200
    for password in passwords:
        assert len(password) == 12
        assert security.password_problems(password, "2026-D01-001") == []
        assert not confusing & set(password)
    # 每一位都有变化，不是固定模板。
    assert all(len({password[index] for password in passwords}) > 10 for index in range(12))


def test_generated_password_never_contains_a_short_account():
    for _ in range(300):
        password = security.generate_password("abc")
        assert "abc" not in password.lower()


@pytest.mark.parametrize("configured,length", [("20", 20), ("8", 8), ("4", 8), ("64", 32), ("", 12), ("十二", 12)])
def test_password_length_is_configurable_within_bounds(monkeypatch, configured, length):
    monkeypatch.setenv("TALENTFLOW_CANDIDATE_PASSWORD_LENGTH", configured)
    assert security.password_length() == length
    password = security.generate_password()
    assert len(password) == length and security.password_problems(password) == []


def test_password_hash_is_salted_and_verifiable():
    first, second = security.hash_password("Xj#2026-Interview"), security.hash_password("Xj#2026-Interview")
    assert first != second
    for encoded in (first, second):
        algorithm, rounds, salt, digest = encoded.split("$")
        assert (algorithm, rounds) == ("pbkdf2_sha256", "120000") and len(salt) == 32 and len(digest) == 64
        assert "Xj#2026-Interview" not in encoded
        assert security.verify_password("Xj#2026-Interview", encoded)
        assert not security.verify_password("xj#2026-Interview", encoded)
        assert not security.verify_password("", encoded)
    for broken in ("", "plain-text", "md5$1$salt$digest", "pbkdf2_sha256$abc$salt$digest", first.rsplit("$", 1)[0]):
        assert not security.verify_password("Xj#2026-Interview", broken)


# ---- 签名会话 --------------------------------------------------------------------

def tampered(token, **changes):
    payload, signature = token.split(".")
    body = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    body.update(changes)
    forged = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return f"{forged}.{signature}"


def test_signed_session_round_trip_and_rejections():
    token, expires = security.issue("CAND-1", "candidate", source="onsite", ttl=600, candidate_id=7, entry="abc")
    claims = security.verify(token)
    assert claims == {"sub": "CAND-1", "role": "candidate", "exp": expires, "source": "onsite", "candidate_id": 7, "entry": "abc"}
    assert security.verify(security.issue("候选人甲", "candidate")[0])["sub"] == "候选人甲"
    default_token, default_expires = security.issue("staff", "hr_admin", source="host_entry")
    assert security.verify(default_token)["source"] == "host_entry"
    assert 0 <= default_expires - claims["exp"] - (security.TOKEN_TTL_SECONDS - 600) <= 5
    rejected = [
        tampered(token, role="system_admin"), tampered(token, candidate_id=8), tampered(token, exp=expires + 3600),
        token[:-2] + ("AA" if not token.endswith("AA") else "BB"), token.split(".")[0], token.replace(".", ""),
        "", "not-a-token", "a.b.c",
        security.issue("CAND-1", "candidate", ttl=0)[0], security.issue("CAND-1", "candidate", ttl=-60)[0],
        security.issue("", "candidate")[0], security.issue("CAND-1", "")[0],
    ]
    for value in rejected:
        with pytest.raises(ValueError):
            security.verify(value)


def test_session_secret_can_be_rotated_by_configuration(monkeypatch):
    token, _ = security.issue("CAND-1", "candidate")
    monkeypatch.setenv("TALENTFLOW_SESSION_SECRET", "another-signing-secret-for-rotation-test")
    with pytest.raises(ValueError):
        security.verify(token)
    rotated, _ = security.issue("CAND-1", "candidate")
    assert security.verify(rotated)["sub"] == "CAND-1"
    monkeypatch.delenv("TALENTFLOW_SESSION_SECRET")
    assert security.verify(token)["sub"] == "CAND-1"
    with pytest.raises(ValueError):
        security.verify(rotated)


def test_bearer_token_is_checked_when_test_headers_are_absent(client):
    assert client.get("/api/interviews/me").status_code == 401
    assert client.get("/api/interviews/me", headers={"Authorization": "Basic abc"}).status_code == 401
    assert client.get("/api/interviews/me", headers=support.bearer("not-a-token")).status_code == 401
    expired, _ = security.issue("candidate", "candidate", ttl=-1)
    assert client.get("/api/interviews/me", headers=support.bearer(expired)).status_code == 401
    unknown_role, _ = security.issue("candidate", "visitor")
    assert client.get("/api/interviews/me", headers=support.bearer(unknown_role)).status_code == 401
    # 工作人员会话必须来自管理入口；自行签发来源为密码登录的工作人员令牌无效。
    staff, _ = security.issue("admin", "system_admin", source="password")
    assert client.get("/api/candidates", headers=support.bearer(staff)).status_code == 401
    valid, _ = security.issue("candidate", "candidate")
    me = client.get("/api/interviews/me", headers=support.bearer(valid))
    assert me.status_code == 200 and me.json()["candidate"]["code"] == "CAND-2026-001"
    # 只带角色、不带姓名的测试请求头不构成身份。
    assert client.get("/api/candidates", headers={"X-User-Role": "hr_admin"}).status_code == 401


# ---- 登录失败锁定 -----------------------------------------------------------------

@pytest.fixture
def account(client, created):
    person = support.create_candidate(client, created, support.seed_batch()["id"], "锁定测试候选人")
    return person["id"], person["credentials"]


def login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def stored_user(username):
    with SessionLocal() as db:
        user = db.query(User).filter_by(username=username).one()
        return user.failed_logins, user.locked_until


def candidate_row(client, candidate_id):
    rows = client.get("/api/candidates", headers=support.staff("hr_admin", "hr")).json()
    return next(item for item in rows if item["id"] == candidate_id)


def test_account_locks_after_five_wrong_passwords_and_reset_unlocks(client, account):
    candidate_id, credentials = account
    username = credentials["username"]
    mark = support.audit_mark(client)
    assert security.LOGIN_MAX_FAILURES == 5 and security.LOGIN_LOCK_SECONDS == 600
    for attempt in range(1, 5):
        assert login(client, username, "Wrong-Pass-1!").status_code == 401
        assert stored_user(username) == (attempt, None)
    assert candidate_row(client, candidate_id)["login_locked"] is False
    # 第五次输错后锁定；锁定期间即使密码正确也不能登录。
    assert login(client, username, "Wrong-Pass-1!").status_code == 401
    failures, locked_until = stored_user(username)
    assert failures == 0 and locked_until is not None
    remaining = locked_until.replace(tzinfo=now().tzinfo) - now()
    assert timedelta(minutes=9) < remaining <= timedelta(minutes=10)
    for password in (credentials["password"], "Wrong-Pass-1!"):
        locked = login(client, username, password)
        assert locked.status_code == 423 and "锁定" in locked.json()["detail"]
    assert stored_user(username) == (0, locked_until)
    assert candidate_row(client, candidate_id)["login_locked"] is True
    audits = support.audits_since(client, mark)
    assert [(item["action"], item["actor"]) for item in audits] == [("login_locked", username)]

    # 工作人员重新生成密码即解除锁定；旧密码随之失效。
    assert client.post(f"/api/candidates/{candidate_id}/password", headers=support.staff("interviewer", "interviewer")).status_code == 403
    reset = client.post(f"/api/candidates/{candidate_id}/password", headers=support.staff("hr_admin", "hr"))
    assert reset.status_code == 200
    renewed = reset.json()["credentials"]
    assert renewed["username"] == username and renewed["password"] != credentials["password"]
    assert security.password_problems(renewed["password"], username) == []
    assert stored_user(username) == (0, None)
    assert candidate_row(client, candidate_id)["login_locked"] is False
    assert login(client, username, credentials["password"]).status_code == 401
    session = login(client, username, renewed["password"])
    assert session.status_code == 200 and session.json()["candidate_id"] == candidate_id
    assert client.get("/api/interviews/me", headers=support.bearer(session.json()["access_token"])).status_code == 200


def test_successful_login_clears_earlier_failures(client, account):
    _, credentials = account
    username = credentials["username"]
    for _ in range(4):
        assert login(client, username, "Wrong-Pass-1!").status_code == 401
    assert login(client, username, credentials["password"]).status_code == 200
    assert stored_user(username) == (0, None)
    for _ in range(4):
        assert login(client, username, "Wrong-Pass-1!").status_code == 401
    assert login(client, username, credentials["password"]).status_code == 200


def test_lock_expires_by_itself(client, account):
    _, credentials = account
    username = credentials["username"]
    for _ in range(5):
        login(client, username, "Wrong-Pass-1!")
    assert login(client, username, credentials["password"]).status_code == 423
    with SessionLocal() as db:
        db.query(User).filter_by(username=username).one().locked_until = now() - timedelta(seconds=1)
        db.commit()
    assert login(client, username, credentials["password"]).status_code == 200
    assert stored_user(username) == (0, None)


def test_login_failures_do_not_reveal_or_lock_other_accounts(client, account):
    _, credentials = account
    for _ in range(6):
        unknown = login(client, "no-such-account", "Wrong-Pass-1!")
        assert unknown.status_code == 401 and unknown.json()["detail"] == "账号或密码错误"
    wrong = login(client, credentials["username"], "Wrong-Pass-1!")
    assert wrong.status_code == 401 and wrong.json()["detail"] == "账号或密码错误"
    # 工作人员账号不在此入口登录，也不会因此被锁定。
    for _ in range(6):
        assert login(client, "hr", "Wrong-Pass-1!").status_code == 403
    assert stored_user("hr") == (0, None)
    assert login(client, credentials["username"], credentials["password"]).status_code == 200
    assert client.post("/api/auth/login", json={"username": "", "password": "x"}).status_code == 422
    assert client.post("/api/auth/login", json={"username": credentials["username"], "password": ""}).status_code == 422


def test_plaintext_password_is_shown_once_and_never_stored(client, account):
    candidate_id, credentials = account
    with SessionLocal() as db:
        user = db.query(User).filter_by(username=credentials["username"]).one()
        assert user.initial_password == "" and user.password_changed_at is not None
        assert user.password_hash.startswith("pbkdf2_sha256$") and credentials["password"] not in user.password_hash
    hr = support.staff("hr_admin", "hr")
    for path in ("/api/candidates", f"/api/candidates?batch_id={support.seed_batch()['id']}", "/api/audits?limit=500"):
        response = client.get(path, headers=hr)
        assert response.status_code == 200 and credentials["password"] not in response.text
    row = candidate_row(client, candidate_id)
    assert row["has_login"] is True and row["login_username"] == credentials["username"] and row["password_set_at"]
    assert not {"password", "initial_password", "credentials", "password_hash"} & set(row)
    updated = client.put(f"/api/candidates/{candidate_id}", headers=hr, json={
        "code": credentials["username"], "name": "锁定测试候选人", "batch_id": row["batch_id"], "profile": {}})
    assert updated.status_code == 200 and "credentials" not in updated.json() and credentials["password"] not in updated.text
