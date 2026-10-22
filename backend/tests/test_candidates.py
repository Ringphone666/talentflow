"""候选人管理：编号与登录凭据、从人员库加入批次、调整与删除、简历关联。"""
import pytest

from backend.app.core import security
from backend.app.core.database import SessionLocal
from backend.app.interview.models import Interview, User

from . import support

HR = support.staff("hr_admin", "hr")
INTERVIEWER = support.staff("interviewer", "interviewer")


@pytest.fixture
def batch(client, created):
    """一个已发布题目、可以建立面试记录的批次。"""
    item = support.create_batch(client, created, "CAND-B1", "候选人管理测试批次")
    item["question_version"] = support.publish_questions(client, item["id"], count=3)
    return item


@pytest.fixture
def persons(client, created):
    """人员库里的三份简历，其中一份没有写姓名。"""
    library_batch = support.create_person_batch(client, created, "候选人管理测试人员批次")
    files = [("候选甲.txt", support.resume_text("候选甲").encode("utf-8")), ("候选乙.txt", support.resume_text("候选乙").encode("utf-8")),
             ("未署名简历.txt", "教育经历：本科，行政管理专业\n工作经历：两年行政事务工作\n".encode("utf-8"))]
    imported = support.import_persons(client, library_batch["id"], files)["imported"]
    return {item["source_filename"]: item for item in imported}


def rows(client, batch_id):
    return {item["code"]: item for item in client.get("/api/candidates", headers=HR, params={"batch_id": batch_id}).json()}


def login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_codes_are_generated_per_batch_and_double_as_login_accounts(client, created, batch):
    first = support.create_candidate(client, created, batch["id"], " 候选人一 ")
    second = support.create_candidate(client, created, batch["id"], "候选人二")
    assert (first["code"], second["code"]) == ("CAND-B1-001", "CAND-B1-002") and first["name"] == "候选人一"
    assert first["credentials"]["username"] == "CAND-B1-001" and second["credentials"]["username"] == "CAND-B1-002"
    assert first["credentials"]["password"] != second["credentials"]["password"]
    assert (first["job_id"], first["job_name"], first["batch_name"]) == (batch["job_id"], batch["job_name"], "候选人管理测试批次")
    with SessionLocal() as db:
        interview = db.query(Interview).filter_by(candidate_id=first["id"]).one()
        assert (interview.batch_id, interview.job_id, interview.question_version) == (batch["id"], batch["job_id"], batch["question_version"])
        assert (interview.status, interview.entry_mode, interview.consented) == ("consent_pending", "account", False)
    # 自动编号跳过已经用掉的编号和账号。
    manual = support.create_candidate(client, created, batch["id"], "手工编号候选人", code=" CAND-B1-003 ")
    assert manual["code"] == "CAND-B1-003"
    with SessionLocal() as db:
        db.add(User(username="CAND-B1-004", display_name="占用账号", role="candidate", candidate_id=None))
        db.commit()
    created.callbacks.append(lambda: _remove_user("CAND-B1-004"))
    assert support.create_candidate(client, created, batch["id"], "候选人五")["code"] == "CAND-B1-005"
    for code, name in (("CAND-B1-001", "编号重复"), ("CAND-B1-004", "账号被占用"), ("candidate", "与已有账号同名")):
        assert client.post("/api/candidates", headers=HR, json={"name": name, "batch_id": batch["id"], "code": code}).status_code == 409
    for body in ({"name": "", "batch_id": batch["id"]}, {"name": "长" * 65, "batch_id": batch["id"]}, {"batch_id": batch["id"]},
                 {"name": "缺少批次"}, {"name": "编号过长", "batch_id": batch["id"], "code": "C" * 33}):
        assert client.post("/api/candidates", headers=HR, json=body).status_code == 422, body
    assert list(rows(client, batch["id"])) == ["CAND-B1-005", "CAND-B1-003", "CAND-B1-002", "CAND-B1-001"]
    assert client.get("/api/candidates", headers=HR, params={"batch_id": 0}).status_code == 422
    assert client.get("/api/candidates", headers=HR, params={"batch_id": 999999}).json() == []
    assert batch["id"] in {item["batch_id"] for item in client.get("/api/candidates", headers=INTERVIEWER).json()}
    listed = next(item for item in client.get("/api/batches", headers=HR).json() if item["id"] == batch["id"])
    assert listed["candidate_count"] == 4


def _remove_user(username):
    with SessionLocal() as db:
        db.query(User).filter_by(username=username).delete()
        db.commit()


def test_login_can_be_created_later_and_regenerated(client, created, batch):
    person = support.create_candidate(client, created, batch["id"], "暂不登录的候选人", create_login=False)
    assert person["credentials"] is None and person["has_login"] is False and person["login_username"] == ""
    assert person["interview_status"] == "consent_pending"
    assert login(client, person["code"], "Any-Pass-1!").status_code == 401
    path = f"/api/candidates/{person['id']}/password"
    for role in ("interviewer", "report_reviewer", "question_reviewer", "business_user", "candidate"):
        assert client.post(path, headers=support.staff(role, role)).status_code == 403
    mark = support.audit_mark(client)
    first = client.post(path, headers=HR).json()["credentials"]
    assert first["username"] == person["code"] and first["candidate_id"] == person["id"] and first["name"] == "暂不登录的候选人"
    assert security.password_problems(first["password"], first["username"]) == []
    row = rows(client, batch["id"])[person["code"]]
    assert row["has_login"] is True and row["login_username"] == person["code"] and row["password_set_at"]
    assert login(client, person["code"], first["password"]).status_code == 200
    second = client.post(path, headers=HR).json()["credentials"]
    assert second["password"] != first["password"]
    assert login(client, person["code"], first["password"]).status_code == 401
    assert login(client, person["code"], second["password"]).json()["candidate_id"] == person["id"]
    audits = support.audits_since(client, mark, action="candidate_password_reset")
    assert len(audits) == 2 and all(first["password"] not in item["detail"] and second["password"] not in item["detail"] for item in audits)
    with SessionLocal() as db:
        assert db.query(User).filter_by(candidate_id=person["id"]).count() == 1
    assert client.post("/api/candidates/999999/password", headers=HR).status_code == 404
    # 面试提交后不再发放登录凭据。
    finished = support.create_completed_candidate(created, "CAND-DONE-001", "已完成候选人")
    assert client.post(f"/api/candidates/{finished['candidate_id']}/password", headers=HR).status_code == 409


def test_people_from_the_person_library_join_a_batch(client, created, batch, persons):
    first, second, unnamed = persons["候选甲.txt"], persons["候选乙.txt"], persons["未署名简历.txt"]
    assert unnamed["name"] == "待人工确认"
    for role in ("interviewer", "report_reviewer", "business_user", "candidate"):
        assert client.post("/api/candidates/import", headers=support.staff(role, role),
                           json={"batch_id": batch["id"], "person_ids": [first["id"]]}).status_code == 403
    invalid = [{"batch_id": batch["id"], "person_ids": []}, {"batch_id": batch["id"]}, {"person_ids": [first["id"]]},
               {"batch_id": batch["id"], "person_ids": [f"TLE-{index}" for index in range(201)]}]
    assert [client.post("/api/candidates/import", headers=HR, json=body).status_code for body in invalid] == [422] * 4
    assert client.post("/api/candidates/import", headers=HR, json={"batch_id": 999999, "person_ids": [first["id"]]}).status_code == 404
    draft = support.create_batch(client, created, "CAND-DRAFT", "尚未发布题目的批次")
    assert client.post("/api/candidates/import", headers=HR, json={"batch_id": draft["id"], "person_ids": [first["id"]]}).status_code == 409
    assert rows(client, batch["id"]) == {} and rows(client, draft["id"]) == {}

    mark = support.audit_mark(client)
    response = client.post("/api/candidates/import", headers=HR, json={
        "batch_id": batch["id"], "person_ids": [first["id"], unnamed["id"], first["id"], "TLE-NOT-EXISTING"]})
    assert response.status_code == 200
    result = response.json()
    created.candidates += [item["id"] for item in result["candidates"]]
    assert result["created"] == 2 and result["skipped"] == [{"person_id": "TLE-NOT-EXISTING", "reason": "人员库中未找到该人员"}]
    # 没有识别出姓名的人员先用简历文件名，便于工作人员辨认。
    assert [(item["name"], item["code"], item["library_person_id"]) for item in result["candidates"]] == [
        ("候选甲", "CAND-B1-001", first["id"]), ("未署名简历", "CAND-B1-002", unnamed["id"])]
    assert [(item["username"], item["name"]) for item in result["credentials"]] == [("CAND-B1-001", "候选甲"), ("CAND-B1-002", "未署名简历")]
    assert all(security.password_problems(item["password"], item["username"]) == [] for item in result["credentials"])
    assert login(client, "CAND-B1-001", result["credentials"][0]["password"]).status_code == 200
    candidate = result["candidates"][0]
    assert candidate["interview_status"] == "consent_pending" and candidate["has_login"] is True
    assert candidate["resume"]["uploaded"] is True and candidate["resume"]["source"] == "library"
    assert candidate["resume"]["original_name"] == "候选甲.txt" and candidate["resume"]["ocr_status"] == "completed"
    assert "三年招聘与人员调配工作" in candidate["resume"]["text_preview"]
    audits = support.audits_since(client, mark, action="candidate_created")
    assert len(audits) == 2 and all(first["id"] in item["detail"] or unnamed["id"] in item["detail"] for item in audits)
    assert [item["candidate_code"] for item in client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["interviews"]] == ["CAND-B1-001"]
    downloaded = client.get(f"/api/candidates/{candidate['id']}/resume", headers=INTERVIEWER)
    assert downloaded.status_code == 200 and downloaded.content == support.resume_text("候选甲").encode("utf-8")

    # 同一个人不能在同一批次里出现两次；换一个批次可以再次加入。
    again = client.post("/api/candidates/import", headers=HR, json={"batch_id": batch["id"], "person_ids": [first["id"], second["id"]],
                                                                   "create_login": False}).json()
    created.candidates += [item["id"] for item in again["candidates"]]
    assert again["created"] == 1 and again["credentials"] == []
    assert again["skipped"] == [{"person_id": first["id"], "name": "候选甲", "reason": "已在本批次中"}]
    assert [(item["name"], item["has_login"]) for item in again["candidates"]] == [("候选乙", False)]
    assert client.post("/api/candidates", headers=HR, json={
        "name": "候选甲", "batch_id": batch["id"], "library_person_id": first["id"]}).status_code == 409
    assert client.post("/api/candidates", headers=HR, json={
        "name": "不存在的人员", "batch_id": batch["id"], "library_person_id": "TLE-NOT-EXISTING"}).status_code == 404
    listening = support.create_batch(client, created, "CAND-LISTEN", "仅旁听的批次", mode="listening_only")
    other = client.post("/api/candidates/import", headers=HR, json={"batch_id": listening["id"], "person_ids": [first["id"]],
                                                                   "create_login": True}).json()
    created.candidates += [item["id"] for item in other["candidates"]]
    assert other["created"] == 1 and other["credentials"] == [] and other["skipped"] == []
    assert (other["candidates"][0]["code"], other["candidates"][0]["interview_status"]) == ("CAND-LISTEN-001", "not_required")
    assert len(rows(client, batch["id"])) == 3
    assert len(client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["interviews"]) == 2


def test_candidate_can_be_adjusted_until_the_interview_starts(client, created, batch):
    person = support.create_candidate(client, created, batch["id"], "待调整候选人")
    other = support.create_candidate(client, created, batch["id"], "另一名候选人")
    password = person["credentials"]["password"]
    path = f"/api/candidates/{person['id']}"

    def update(**changes):
        body = {"code": person["code"], "name": "待调整候选人", "batch_id": batch["id"], "profile": {}, **changes}
        return client.put(path, headers=changes.pop("headers", HR), json=body)

    renamed = update(code=" CAND-RENAMED ", name=" 已改名候选人 ", profile={"education": "硕士"})
    assert renamed.status_code == 200
    body = renamed.json()
    assert (body["ok"], body["code"], body["name"], body["profile"]) == (True, "CAND-RENAMED", "已改名候选人", {"education": "硕士"})
    # 登录账号跟随候选人编号，密码不变。
    assert body["login_username"] == "CAND-RENAMED" and "credentials" not in body
    assert login(client, person["code"], password).status_code == 401
    assert login(client, "CAND-RENAMED", password).json()["display_name"] == "已改名候选人"
    assert update(code=other["code"]).status_code == 409 and update(code="candidate").status_code == 409
    assert update(batch_id=999999).status_code == 404
    assert client.put("/api/candidates/999999", headers=HR, json={"code": "X", "name": "不存在", "batch_id": batch["id"]}).status_code == 404
    assert client.put(path, headers=INTERVIEWER, json={"code": "X", "name": "越权", "batch_id": batch["id"]}).status_code == 403
    for invalid in ({"code": "", "name": "无编号", "batch_id": batch["id"]}, {"code": "X", "name": "", "batch_id": batch["id"]}):
        assert client.put(path, headers=HR, json=invalid).status_code == 422

    # 未开始面试时可以换到同一种面试方式的批次，题目版本随之更换。
    target = support.create_batch(client, created, "CAND-B2", "调整后的批次", job_id=support.seed_batch("2026-HR-01")["job_id"])
    draft = support.create_batch(client, created, "CAND-B3", "尚未发布题目的批次")
    listening = support.create_batch(client, created, "CAND-B4", "仅旁听的批次", mode="listening_only")
    version = support.publish_questions(client, target["id"], count=4)
    assert update(code="CAND-RENAMED", batch_id=draft["id"]).status_code == 409
    assert update(code="CAND-RENAMED", batch_id=listening["id"]).status_code == 409
    moved = update(code="CAND-RENAMED", batch_id=target["id"])
    assert moved.status_code == 200
    assert (moved.json()["batch_id"], moved.json()["job_id"], moved.json()["batch_name"]) == (target["id"], target["job_id"], "调整后的批次")
    me = support.my_interview(client, support.candidate("CAND-RENAMED"))
    assert me["question_version"] == version and len(me["questions"]) == 4 and me["current_question"] == 1
    assert {question["batch_id"] for question in me["questions"]} == {target["id"]}
    assert "CAND-RENAMED" in rows(client, target["id"]) and "CAND-RENAMED" not in rows(client, batch["id"])

    support.prepare_interview(client, support.candidate("CAND-RENAMED"))
    assert update(code="CAND-RENAMED", batch_id=batch["id"]).status_code == 409
    assert update(code="CAND-RENAMED", name="面试中仍可更正姓名", batch_id=target["id"]).status_code == 200
    assert rows(client, target["id"])["CAND-RENAMED"]["interview_status"] == "in_progress"


def test_candidate_with_records_cannot_be_deleted(client, created, batch):
    fresh = support.create_candidate(client, created, batch["id"], "可以删除的候选人")
    started = support.create_candidate(client, created, batch["id"], "已开始面试的候选人")
    support.prepare_interview(client, support.candidate(started["code"]))
    finished = support.create_completed_candidate(created, "CAND-DONE-002", "已有报告的候选人")
    listened = support.create_candidate(client, created, batch["id"], "已有旁听记录的候选人")
    assert client.post(f"/api/listening/{listened['id']}/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    for candidate_id in (started["id"], finished["candidate_id"], listened["id"]):
        assert client.delete(f"/api/candidates/{candidate_id}", headers=HR).status_code == 409
    assert client.delete(f"/api/candidates/{fresh['id']}", headers=INTERVIEWER).status_code == 403
    assert client.delete("/api/candidates/999999", headers=HR).status_code == 404
    assert len(rows(client, batch["id"])) == 3

    mark = support.audit_mark(client)
    assert client.delete(f"/api/candidates/{fresh['id']}", headers=HR).json() == {"ok": True}
    assert fresh["code"] not in rows(client, batch["id"])
    assert login(client, fresh["code"], fresh["credentials"]["password"]).status_code == 401
    with SessionLocal() as db:
        assert db.query(Interview).filter_by(candidate_id=fresh["id"]).count() == 0
        assert db.query(User).filter_by(username=fresh["code"]).count() == 0
    assert [item["action"] for item in support.audits_since(client, mark)] == ["candidate_deleted"]
    assert client.delete(f"/api/candidates/{fresh['id']}", headers=HR).status_code == 404
    # 有候选人的批次不能删除。
    assert client.delete(f"/api/batches/{batch['id']}", headers=HR).status_code == 409


def test_resume_link_can_be_removed_before_the_interview(client, created, batch, persons):
    person = persons["候选甲.txt"]
    linked = support.create_candidate(client, created, batch["id"], "候选甲", library_person_id=person["id"])
    plain = support.create_candidate(client, created, batch["id"], "没有简历的候选人")
    path = f"/api/candidates/{linked['id']}/resume"
    assert client.get(f"/api/candidates/{plain['id']}/resume", headers=HR).status_code == 404
    assert client.delete(f"/api/candidates/{plain['id']}/resume", headers=HR).status_code == 404
    assert client.delete("/api/candidates/999999/resume", headers=HR).status_code == 404
    assert client.get("/api/candidates/999999/resume", headers=HR).status_code == 404
    assert client.delete(path, headers=INTERVIEWER).status_code == 403
    for role in ("question_reviewer", "candidate"):
        assert client.get(path, headers=support.staff(role, role)).status_code == 403
    assert client.get(path, headers=HR).status_code == 200

    assert client.delete(path, headers=HR).json() == {"ok": True}
    row = rows(client, batch["id"])[linked["code"]]
    assert row["library_person_id"] is None and row["resume"]["uploaded"] is False and row["resume"]["source"] == "candidate"
    assert client.get(path, headers=HR).status_code == 404
    # 取消关联不删除人员库里的资料。
    detail = client.get(f"/api/library/persons/{person['id']}", headers=HR).json()
    assert detail["status"] == "已解析" and detail["interviews"] == []
    assert client.get(f"/api/library/persons/{person['id']}/file", headers=HR).status_code == 200

    again = support.create_candidate(client, created, batch["id"], "候选甲", library_person_id=person["id"])
    support.prepare_interview(client, support.candidate(again["code"]))
    assert client.delete(f"/api/candidates/{again['id']}/resume", headers=HR).status_code == 409
    upload = client.post(f"/api/candidates/{again['id']}/resume", headers=HR,
                         files={"file": ("新简历.txt", support.resume_text("候选甲").encode("utf-8"), "text/plain")})
    assert upload.status_code == 409
    assert rows(client, batch["id"])[again["code"]]["library_person_id"] == person["id"]
