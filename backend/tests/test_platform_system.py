"""平台公共部分：工作台、合并的审计日志、角色权限、合规规则、外部系统预留入口，以及已下线的接口。"""
from datetime import datetime

import pytest

from backend.app.core.deps import PERMISSIONS, ROLE_LABELS, STAFF_ROLES
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview import rule_store

from . import support

HR = support.staff("hr_admin", "hr")
ADMIN = support.staff()
ROLES = {role: support.staff(role, role) for role in ROLE_LABELS}
LIBRARY_KEYS = {"jobs", "person_batches", "persons", "persons_failed"}
MATCHING_KEYS = {"tasks", "running", "with_failures", "pending_review", "stale"}
INTERVIEW_KEYS = {"batches", "candidates", "interviewing", "completed", "questions_pending_review", "reports_generating",
                  "reports_failed", "reports_pending", "reports_confirmed"}


# ---- 工作台 ---------------------------------------------------------------------

@pytest.mark.parametrize("role,sections", [
    ("system_admin", {"library", "matching", "interview"}),
    ("hr_admin", {"library", "matching", "interview"}),
    ("business_user", {"library", "matching", "interview"}),
    ("interviewer", {"library", "matching", "interview"}),
    ("report_reviewer", {"library", "matching", "interview"}),
    # 题目审核人不参与人岗匹配。
    ("question_reviewer", {"library", "interview"}),
])
def test_workbench_sections_follow_permissions(client, role, sections):
    response = client.get("/api/overview", headers=ROLES[role])
    assert response.status_code == 200
    overview = response.json()
    assert overview["role"] == role and overview["role_label"] == ROLE_LABELS[role]
    assert {"library", "matching", "interview"} & set(overview) == sections
    assert set(overview["library"]) >= LIBRARY_KEYS and set(overview["interview"]) >= INTERVIEW_KEYS
    if "matching" in sections:
        assert set(overview["matching"]) >= MATCHING_KEYS
    numbers = [value for name in sections for value in overview[name].values()]
    assert all(type(value) is int and value >= 0 for value in numbers)
    assert isinstance(overview["todo"], list)
    for item in overview["todo"]:
        assert set(item) >= {"title", "count", "path"} and item["title"] and item["count"] > 0 and item["path"].startswith("/")
    # 服务状态若随工作台返回，只给出运行方式，不含地址和密钥。
    for name, value in (overview.get("services") or {}).items():
        assert isinstance(value, str) and "http" not in value, name


def test_workbench_is_for_staff_only(client):
    assert client.get("/api/overview", headers=ROLES["candidate"]).status_code == 403
    assert client.get("/api/overview").status_code == 401
    assert client.get("/api/overview", headers={"X-User-Role": "auditor", "X-User-Name": "someone"}).status_code == 401


def test_workbench_numbers_match_the_lists(client, created):
    job = support.create_library_job(client, created, "工作台测试岗位")
    people = support.create_person_batch(client, created, "工作台测试人员批次")
    support.import_persons(client, people["id"], [("工作台人员.txt", support.resume_text("工作台人员").encode("utf-8"))])
    batch = support.create_batch(client, created, "OVERVIEW-B1", "工作台测试批次", library_job_id=job["id"], mode="listening_only")
    support.create_candidate(client, created, batch["id"], "工作台候选人")
    overview = client.get("/api/overview", headers=ADMIN).json()
    assert overview["library"]["jobs"] == len(client.get("/api/library/jobs", headers=ADMIN).json())
    batches = client.get("/api/library/person-batches", headers=ADMIN).json()
    assert overview["library"]["person_batches"] == len(batches)
    assert overview["library"]["persons"] == sum(item["total_count"] for item in batches)
    assert overview["library"]["persons_failed"] == sum(item["failed_count"] for item in batches)
    assert overview["matching"]["tasks"] == len(client.get("/api/matching/tasks", headers=ADMIN).json())
    assert overview["interview"]["batches"] == len(client.get("/api/batches", headers=ADMIN).json())
    candidates = client.get("/api/candidates", headers=ADMIN).json()
    assert overview["interview"]["candidates"] == len(candidates)
    assert overview["interview"]["completed"] == sum(item["interview_status"] == "completed" for item in candidates)
    reports = client.get("/api/reports", headers=ADMIN).json()
    assert overview["interview"]["reports_confirmed"] == sum(item["status"] == "confirmed" for item in reports)
    assert overview["interview"]["reports_pending"] == sum(item["status"] in ("pending_review", "returned") for item in reports)
    # 各角色看到的是同一组数字。
    assert client.get("/api/overview", headers=ROLES["report_reviewer"]).json()["interview"] == overview["interview"]
    assert client.get("/api/overview", headers=ROLES["business_user"]).json()["library"] == overview["library"]


def test_todo_lists_only_what_the_role_can_handle(client, created):
    before = client.get("/api/overview", headers=ADMIN).json()["interview"]["questions_pending_review"]
    batch = support.create_batch(client, created, "OVERVIEW-Q1", "工作台待审题目批次")
    generated = client.post(f"/api/batches/{batch['id']}/questions/generate", headers=HR, json={"count": 3}).json()
    assert client.get("/api/overview", headers=ADMIN).json()["interview"]["questions_pending_review"] == before
    assert client.post(f"/api/batches/{batch['id']}/questions/{generated['version']}/submit-review", headers=HR).status_code == 200

    def todo(role):
        overview = client.get("/api/overview", headers=ROLES[role]).json()
        assert overview["interview"]["questions_pending_review"] == before + 1
        return {item["title"]: item["count"] for item in overview["todo"]}

    pending_reports = client.get("/api/overview", headers=ADMIN).json()["interview"]["reports_pending"]
    assert pending_reports >= 1
    def about(role, keyword):
        return [count for title, count in todo(role).items() if keyword in title]

    # 题目审核人只有审核题目这一项待办。
    assert list(todo("question_reviewer").values()) == [before + 1] and about("question_reviewer", "题目") == [before + 1]
    # HR管理员提交题目但不审核题目，也不复核报告。
    assert about("hr_admin", "题目") == [] and about("hr_admin", "报告") == []
    assert about("report_reviewer", "报告") == [pending_reports] and about("report_reviewer", "题目") == []
    assert about("interviewer", "报告") == [] and about("business_user", "报告") == []
    assert about("system_admin", "题目") == [before + 1] and about("system_admin", "报告") == [pending_reports]


# ---- 审计日志 --------------------------------------------------------------------

def test_audits_merge_platform_and_matching_records(client, created):
    marks = support.audit_mark(client), support.audit_mark(client, "matching")
    job = support.create_library_job(client, created, "审计测试岗位")
    assert client.put(f"/api/library/jobs/{job['id']}", headers=ADMIN, json=support.job_payload("审计测试岗位", level="P6")).status_code == 200
    merged = client.get("/api/audits", headers=HR, params={"keyword": job["id"]})
    assert merged.status_code == 200
    rows = merged.json()
    assert sorted((row["source"], row["action"], row["actor"]) for row in rows) == [
        ("matching", "岗位修改", "admin"), ("matching", "岗位新增", "hr"),
        ("platform", "library_job_saved", "admin"), ("platform", "library_job_saved", "hr")]
    for row in rows:
        assert set(row) >= {"id", "source", "source_label", "actor", "role", "role_label", "action", "target_type",
                            "target_id", "detail", "created_at"}
        assert row["target_id"] == job["id"] and row["id"].startswith("p-" if row["source"] == "platform" else "m-")
        assert row["source_label"] == ("平台与AI面试" if row["source"] == "platform" else "人岗匹配")
    platform = [row for row in rows if row["source"] == "platform"]
    matching = [row for row in rows if row["source"] == "matching"]
    assert [(row["role"], row["role_label"], row["target_type"]) for row in platform] == [
        ("system_admin", "系统管理员", "job"), ("hr_admin", "HR管理员", "job")]
    # 人岗匹配的记录保留业务角色，操作人显示登录名。
    assert [(row["role"], row["role_label"], row["target_type"]) for row in matching] == [("招聘人员", "招聘人员", "岗位")] * 2
    assert "审计测试岗位" in platform[1]["detail"] and all(row["detail"] for row in matching)
    # 两个库的时间写法不同（一个按 UTC、一个按本地时区），合并后统一成带时区的时间，新的在前。
    times = [datetime.fromisoformat(row["created_at"]) for row in rows]
    assert all(value.tzinfo is not None for value in times) and times == sorted(times, reverse=True)
    assert (times[0] - times[-1]).total_seconds() < 120

    assert [row["id"] for row in support.audits_since(client, marks[0], keyword=job["id"])] == [row["id"] for row in platform]
    assert [row["id"] for row in support.audits_since(client, marks[1], source="matching", keyword=job["id"])] == [row["id"] for row in matching]
    by_source = client.get("/api/audits", headers=HR, params={"keyword": job["id"], "source": "all"}).json()
    assert by_source == rows
    by_action = client.get("/api/audits", headers=HR, params={"keyword": job["id"], "action": "岗位修改"}).json()
    assert [row["id"] for row in by_action] == [matching[0]["id"]]
    by_actor = client.get("/api/audits", headers=HR, params={"keyword": "admin", "action": "library_job_saved", "limit": 1}).json()
    assert [row["id"] for row in by_actor] == [platform[0]["id"]]
    assert client.get("/api/audits", headers=HR, params={"keyword": "没有任何记录包含这段文字"}).json() == []


def test_audit_filters_are_validated(client):
    latest = client.get("/api/audits", headers=ADMIN, params={"limit": 3}).json()
    assert 1 <= len(latest) <= 3
    assert len(client.get("/api/audits", headers=ADMIN).json()) <= 200
    assert {row["source"] for row in client.get("/api/audits", headers=ADMIN, params={"source": "platform", "limit": 500}).json()} == {"platform"}
    assert {row["source"] for row in client.get("/api/audits", headers=ADMIN, params={"source": "matching", "limit": 500}).json()} <= {"matching"}
    initialized = client.get("/api/audits", headers=ADMIN, params={"action": "system_initialized"}).json()
    assert [(row["actor"], row["source"]) for row in initialized] == [("system", "platform")]
    for params in ({"source": "interview"}, {"limit": 0}, {"limit": 501}, {"limit": "many"}, {"keyword": "长" * 65}, {"action": "a" * 65}):
        assert client.get("/api/audits", headers=ADMIN, params=params).status_code == 422, params
    for role in ("business_user", "question_reviewer", "interviewer", "report_reviewer", "candidate"):
        assert client.get("/api/audits", headers=ROLES[role], params={"source": "matching"}).status_code == 403


# ---- 角色 -----------------------------------------------------------------------

def test_roles_and_permissions_are_consistent():
    assert set(PERMISSIONS) == set(ROLE_LABELS) and "candidate" not in STAFF_ROLES
    assert ROLE_LABELS["business_user"] == "用人部门" and "business_user" in STAFF_ROLES
    assert PERMISSIONS["candidate"] == {"interview:use"}
    # 只有系统管理员和HR管理员可以查看审计日志、维护合规规则。
    assert [role for role, granted in PERMISSIONS.items() if "*" in granted or "audit:read" in granted] == ["system_admin", "hr_admin"]
    assert [role for role, granted in PERMISSIONS.items() if "*" in granted or "config:edit" in granted] == ["system_admin", "hr_admin"]
    business = PERMISSIONS["business_user"]
    assert {"job:read", "person:read", "report:read", "compare:read", "matching:view", "matching:review", "matching:export"} <= business
    assert not {item for item in business if item.endswith((":edit", ":create", ":delete", ":confirm", ":manage"))}
    assert "listening:use" not in business and "interview:use" not in business


def test_business_user_reads_results_but_manages_nothing(client):
    business = ROLES["business_user"]
    batch = support.seed_batch()
    readable = ["/api/overview", "/api/jobs", "/api/dimensions", "/api/batches", "/api/candidates", "/api/reports",
                f"/api/comparison?batch_id={batch['id']}", "/api/comprehensive-reports", "/api/library/jobs",
                "/api/library/person-batches", "/api/library/integrations", "/api/matching/options", "/api/matching/tasks"]
    for path in readable:
        assert client.get(path, headers=business).status_code == 200, path
    forbidden = ["/api/audits", "/api/questions", "/api/listening/candidates", f"/api/listening/{support.seed_candidate_id('CAND-2026-002')}",
                 "/api/sensitive-blocks", "/api/config/sensitive-rules", "/api/config/consent-notice",
                 f"/api/batches/{batch['id']}/onsite-entries", "/api/interviews/me"]
    for path in forbidden:
        assert client.get(path, headers=business).status_code == 403, path
    report_id = client.get("/api/reports", headers=business).json()[0]["id"]
    writes = [
        ("post", "/api/batches", {"code": "BUSINESS-B1", "name": "越权批次", "recruitment_type": "社会招聘", "job_id": batch["job_id"]}),
        ("put", f"/api/batches/{batch['id']}", {"code": batch["code"], "name": "越权改名", "recruitment_type": "社会招聘", "job_id": batch["job_id"]}),
        ("delete", f"/api/batches/{batch['id']}", None),
        ("post", "/api/candidates", {"name": "越权候选人", "batch_id": batch["id"]}),
        ("post", "/api/candidates/import", {"batch_id": batch["id"], "person_ids": ["TLE-1"]}),
        ("post", f"/api/batches/{batch['id']}/questions/generate", {"count": 3}),
        ("post", f"/api/batches/{batch['id']}/onsite-entries", {}),
        ("put", f"/api/reports/{report_id}", {"content": {"summary": "越权修改"}, "reason": "越权修改"}),
        ("post", f"/api/reports/{report_id}/confirm", {"reason": "越权确认"}),
        ("post", f"/api/reports/{report_id}/return", {"reason": "越权退回"}),
        ("post", f"/api/reports/{report_id}/retry-generation", None),
        ("put", "/api/config/sensitive-rules", {"rules": {"测试": ["测试"]}}),
        ("put", "/api/config/consent-notice", {"version": "BUSINESS-1", "text": "越权修改的采集告知文本：仅采集音频，录音和转写在本地留存。"}),
    ]
    for method, path, body in writes:
        assert client.request(method, path, headers=business, json=body).status_code == 403, (method, path)
    assert support.seed_batch() == batch


# ---- 合规与规则 ------------------------------------------------------------------

@pytest.fixture
def default_rules(client):
    """规则和告知文本保存在测试数据目录的配置文件里；用完恢复为默认内容。"""
    yield
    for path in (rule_store.RULES_FILE, rule_store.NOTICE_FILE):
        path.unlink(missing_ok=True)


def test_sensitive_rules_are_maintained_by_administrators(client, default_rules):
    rules = client.get("/api/config/sensitive-rules", headers=ROLES["question_reviewer"])
    assert rules.status_code == 200 and rules.json() == {"rules": rule_store.DEFAULT_RULES}
    for role in ("interviewer", "report_reviewer", "business_user", "candidate"):
        assert client.get("/api/config/sensitive-rules", headers=ROLES[role]).status_code == 403
        assert client.get("/api/sensitive-blocks", headers=ROLES[role]).status_code == 403
    changed = {**rule_store.DEFAULT_RULES, "薪资隐私": ["上一份工资", "薪资流水"]}
    for role in ("question_reviewer", "interviewer", "report_reviewer", "business_user", "candidate"):
        assert client.put("/api/config/sensitive-rules", headers=ROLES[role], json={"rules": changed}).status_code == 403
    for invalid in ({"rules": {}}, {"rules": {"薪资隐私": []}}, {"rules": {" ": ["工资"]}}, {"rules": ["工资"]}, {}):
        assert client.put("/api/config/sensitive-rules", headers=HR, json=invalid).status_code == 422, invalid
    question = {"content": "请提供你上一份工资的薪资流水。", "source_type": "question"}
    assert client.post("/api/filter/check", headers=HR, json=question).json()["allowed"] is True

    mark = support.audit_mark(client)
    saved = client.put("/api/config/sensitive-rules", headers=HR, json={"rules": changed})
    assert saved.status_code == 200 and saved.json() == {"ok": True, "rules": changed}
    assert client.get("/api/config/sensitive-rules", headers=ADMIN).json() == {"rules": changed}
    # 新规则立即用于题目、追问和旁听建议的过滤。
    blocked = client.post("/api/filter/check", headers=HR, json=question).json()
    assert blocked == {"allowed": False, "reason": "薪资隐私", "content": ""}
    assert client.post("/api/filter/check", headers=HR, json={"content": "你的年龄是多少"}).json()["reason"] == "年龄歧视"
    records = client.get("/api/sensitive-blocks", headers=ROLES["question_reviewer"]).json()
    assert (records[1]["reason"], records[1]["content"], records[1]["source_type"]) == ("薪资隐私", question["content"], "question")
    actions = [item["action"] for item in reversed(support.audits_since(client, mark))]
    assert actions == ["sensitive_rules_updated", "sensitive_content_blocked", "sensitive_content_blocked"]


def test_new_consent_notice_requires_consent_again(client, created, default_rules):
    assert client.get("/api/config/consent-notice", headers=ROLES["candidate"]).json() == rule_store.DEFAULT_NOTICE
    for role in ("hr_admin", "interviewer", "report_reviewer"):
        assert client.get("/api/config/consent-notice", headers=ROLES[role]).status_code == 200
    for role in ("question_reviewer", "business_user"):
        assert client.get("/api/config/consent-notice", headers=ROLES[role]).status_code == 403
    notice = {"version": "TEST-NOTICE-9.9", "text": "本次测试使用的采集告知：仅采集音频，录音和转写在本地留存，拒绝后不启动采集。"}
    for role in ("interviewer", "report_reviewer", "question_reviewer", "business_user", "candidate"):
        assert client.put("/api/config/consent-notice", headers=ROLES[role], json=notice).status_code == 403
    for invalid in ({"version": "", "text": notice["text"]}, {"version": "V", "text": "太短"}, {"version": "V" * 65, "text": notice["text"]},
                    {"version": "V", "text": "长" * 5001}, {"text": notice["text"]}):
        assert client.put("/api/config/consent-notice", headers=HR, json=invalid).status_code == 422, invalid

    record = support.create_completed_candidate(created, "NOTICE-001", "告知版本测试", report_status="confirmed")
    url = f"/api/listening/{record['candidate_id']}"
    assert client.get(url, headers=ROLES["interviewer"]).json()["prior_consent_valid"] is True
    mark = support.audit_mark(client)
    saved = client.put("/api/config/consent-notice", headers=HR, json=notice)
    assert saved.status_code == 200 and saved.json() == {"ok": True, **notice}
    assert intelligence.current_notice() == (notice["version"], notice["text"])
    assert [item["action"] for item in support.audits_since(client, mark)] == ["consent_notice_updated"]
    me = client.get("/api/interviews/me", headers=ROLES["candidate"]).json()
    assert me["available_consent_version"] == notice["version"] and me["consent_text"] == notice["text"]
    # 告知内容更新后，按旧版本取得的同意不再作为旁听的依据，需要重新告知确认。
    state = client.get(url, headers=ROLES["interviewer"]).json()
    assert state["prior_consent_valid"] is False and state["notice_version"] == notice["version"]
    assert client.post(url + "/start", headers=ROLES["interviewer"], json={"consented": True}).status_code == 409
    started = client.post(url + "/start", headers=ROLES["interviewer"], json={"consented": True, "candidate_confirmed": True})
    assert started.status_code == 200
    consent = client.get(url, headers=ROLES["interviewer"]).json()["consent_record"]
    assert consent["notice_version"] == notice["version"] and consent["method"] == intelligence.ONSITE_METHOD


# ---- 外部系统预留入口 --------------------------------------------------------------

def test_integrations_are_listed_as_pending_and_import_nothing(client):
    jobs = client.get("/api/library/jobs?include_archived=true", headers=ADMIN).json()
    batches = client.get("/api/library/person-batches", headers=ADMIN).json()
    response = client.get("/api/library/integrations", headers=ROLES["interviewer"])
    assert response.status_code == 200
    entries = response.json()
    assert [item["key"] for item in entries] == ["recruitment_jobs", "organization_persons"]
    assert [item["target"] for item in entries] == ["岗位库", "人员库"]
    for item in entries:
        assert item["status"] == "pending_interface" and item["available"] is False and item["status_label"] == "待对接"
        assert item["name"] and item["system"] and item["pending"] and item["alternative"]
    for role in ("hr_admin", "business_user", "question_reviewer", "report_reviewer", "system_admin"):
        assert client.get("/api/library/integrations", headers=ROLES[role]).json() == entries
    assert client.get("/api/library/integrations", headers=ROLES["candidate"]).status_code == 403
    assert client.get("/api/library/integrations").status_code == 401

    for key, name in (("recruitment_jobs", "从人资招聘系统导入岗位"), ("organization_persons", "从组织架构选择人员")):
        for headers in (HR, ADMIN):
            imported = client.post(f"/api/library/integrations/{key}/import", headers=headers)
            # 接口尚未对接：如实说明，不返回任何模拟数据。
            assert imported.status_code == 501 and name in imported.json()["detail"] and "尚未对接" in imported.json()["detail"]
        for role in ("business_user", "interviewer", "report_reviewer", "question_reviewer", "candidate"):
            assert client.post(f"/api/library/integrations/{key}/import", headers=ROLES[role]).status_code == 403
    assert client.post("/api/library/integrations/payroll/import", headers=HR).status_code == 404
    assert client.get("/api/library/integrations/recruitment_jobs/import", headers=HR).status_code in {404, 405}
    assert client.get("/api/library/jobs?include_archived=true", headers=ADMIN).json() == jobs
    assert client.get("/api/library/person-batches", headers=ADMIN).json() == batches


# ---- 已下线的接口 -----------------------------------------------------------------

REMOVED = [
    ("post", "/api/jobs"), ("put", "/api/jobs/1"), ("delete", "/api/jobs/1"),
    ("post", "/api/jobs/draft"), ("post", "/api/jobs/draft?name=质量岗"),
    ("get", "/api/jobs/matching-source"), ("get", "/api/jobs/matching-source/JOB-1"), ("post", "/api/jobs/matching-source/JOB-1"),
    ("post", "/api/jobs/1/scoring-advice"), ("post", "/api/jobs/1/materials"), ("delete", "/api/jobs/1/materials/1"),
    ("get", "/api/auth/users"), ("post", "/api/auth/users"), ("put", "/api/auth/users/1"),
    ("get", "/api/model-services"), ("get", "/api/model-services/status"), ("post", "/api/model-services/test"),
    ("get", "/api/matching/2"), ("post", "/api/listening/2/next"), ("get", "/api/listening/2/next"),
]


@pytest.mark.parametrize("method,path", REMOVED)
def test_removed_endpoints_are_gone(client, method, path):
    before = client.get("/api/jobs", headers=ADMIN).json()
    response = client.request(method, path, headers=ADMIN, json=None if method in ("get", "delete") else {})
    assert response.status_code in {404, 405}, response.text
    assert client.get("/api/jobs", headers=ADMIN).json() == before


def test_replacements_of_removed_endpoints_are_in_place(client):
    candidate_id = support.seed_candidate_id("CAND-2026-002")
    moved = client.get(f"/api/matching/interview-results/{candidate_id}", headers=ROLES["report_reviewer"])
    assert moved.status_code == 200 and moved.json()["candidate_code"] == "CAND-2026-002" and moved.json()["decision"] is None
    # 未经人工确认的报告不作为人岗匹配的输入。
    pending = support.seed_candidate_id("CAND-2026-004")
    assert client.get(f"/api/matching/interview-results/{pending}", headers=ROLES["report_reviewer"]).status_code == 409
    assert client.get(f"/api/matching/interview-results/{candidate_id}", headers=ROLES["question_reviewer"]).status_code == 403
    assert [item["code"] for item in client.get("/api/jobs", headers=ROLES["interviewer"]).json()][:3] == ["JOB-2026-001", "JOB-HR-001", "JOB-HR-002"]
    assert client.get("/api/library/jobs", headers=ROLES["interviewer"]).status_code == 200
    assert client.get("/api/listening/candidates", headers=ROLES["interviewer"]).status_code == 200
    docs = client.get("/openapi.json").json()["paths"]
    assert {"/api/library/jobs/{job_id}/interview-standard", "/api/library/jobs/{job_id}/interview-standard/advice",
            "/api/library/jobs/{library_job_id}/materials", "/api/matching/interview-results/{candidate_id}",
            "/api/reports/{report_id}/retry-generation", "/api/batches/{batch_id}/onsite-entries", "/api/onsite/sessions",
            "/api/listening/candidates", "/api/listening/{candidate_id}/prepare", "/api/candidates/import",
            "/api/candidates/{candidate_id}/password", "/api/library/operations/{job_id}"} <= set(docs)
    assert list(docs["/api/jobs"]) == ["get"]
    assert not [path for path in docs if path.startswith(("/api/model-services", "/api/auth/users", "/api/jobs/"))]
