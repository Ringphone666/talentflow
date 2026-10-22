"""基础数据：岗位库（岗位说明、能力标签、面试评价标准）和人员库（批次、简历导入、资料核对、导出）。"""
import csv
import io
from urllib.parse import unquote
from zipfile import ZipFile

import pytest

from . import support

HR = support.staff("hr_admin", "hr")
ADMIN = support.staff()
INTERVIEWER = support.staff("interviewer", "interviewer")
BUSINESS = support.staff("business_user", "business")
READ_ONLY_ROLES = ("business_user", "question_reviewer", "interviewer", "report_reviewer")


def standard_model(client, job_id, **changes):
    """六维默认评价标准，可按维度名称覆盖其中一项。"""
    model = client.get(f"/api/library/jobs/{job_id}/interview-standard", headers=HR).json()["default_model"]
    return [dict(item, **changes.get(item["dimension"], {})) for item in model]


def library_job_ids(client, **params):
    return [item["id"] for item in client.get("/api/library/jobs", headers=HR, params=params).json()]


# ---- 岗位库 ---------------------------------------------------------------------

def test_job_can_be_created_read_and_updated(client, created):
    mark = support.audit_mark(client)
    job = support.create_library_job(client, created, "岗位库测试岗位甲")
    assert job["id"].startswith("JOB-") and job["is_active"] is True and job["weight_version"] == "W-NEW-1.0"
    assert (job["name"], job["sequence"], job["level"], job["jd_version"]) == ("岗位库测试岗位甲", "职能序列", "P3", "JD-TEST-1")
    assert job["responsibilities"] == ["负责招聘计划编制与执行", "负责人员调配和入职手续办理"]
    assert job["requirements"] == ["本科及以上学历", "三年以上人力资源工作经验"] and job["hard_conditions"] == ["本科及以上学历"]
    assert job["dimensions"] == [
        {"name": "专业能力", "keywords": ["招聘", "人力资源"], "negative_keywords": [], "weight": 60},
        {"name": "沟通协调", "keywords": ["沟通", "协调"], "negative_keywords": [], "weight": 40}]
    assert job["weights"] == {"专业能力": 60, "沟通协调": 40} and job["extra_sections"] == {"工作地点": "测试地点"}
    assert job["dimension_count"] == 2 and job["hard_condition_count"] == 1 and job["matching_task_count"] == 0
    # 新岗位还没有面试评价标准。
    assert job["interview"] == {"configured": False, "interview_job_id": None, "audit_status": "not_configured", "batch_count": 0}

    listed = next(item for item in client.get("/api/library/jobs", headers=HR).json() if item["id"] == job["id"])
    assert "responsibilities" not in listed and listed["name"] == "岗位库测试岗位甲" and listed["dimension_count"] == 2
    assert client.get(f"/api/library/jobs/{job['id']}", headers=HR).json() == job
    assert client.get("/api/library/jobs/JOB-NOT-EXISTING", headers=HR).status_code == 404

    # 只调整权重时沿用原有评分，版本号递增；改动能力标签则需要重新分析。
    weights = client.put(f"/api/library/jobs/{job['id']}", headers=HR,
                         json=support.job_payload("岗位库测试岗位甲", level="P4", weights={"专业能力": 70, "沟通协调": 30}))
    assert weights.status_code == 200
    assert weights.json()["scorecard_change"] == {"changed": False, "synchronized": 0}
    assert weights.json()["level"] == "P4" and weights.json()["weights"] == {"专业能力": 70, "沟通协调": 30}
    assert weights.json()["weight_version"] == "W-NEW-1.0-R1"
    tags = client.put(f"/api/library/jobs/{job['id']}", headers=HR, json=support.job_payload(
        "岗位库测试岗位甲", level="P4", weights={"专业能力": 50, "沟通协调": 20, "数据分析": 30},
        dimensions=[{"name": "专业能力", "keywords": ["招聘", "人力资源"]}, {"name": "沟通协调", "keywords": ["沟通", "协调"]},
                    {"name": "数据分析", "keywords": ["数据", "报表"]}]))
    assert tags.status_code == 200 and tags.json()["scorecard_change"]["changed"] is True
    assert tags.json()["dimension_count"] == 3 and tags.json()["weight_version"] == "W-NEW-1.0-R2"
    saved = client.get(f"/api/library/jobs/{job['id']}", headers=HR).json()
    assert [item["name"] for item in saved["dimensions"]] == ["专业能力", "沟通协调", "数据分析"]
    assert saved["weights"] == {"专业能力": 50, "沟通协调": 20, "数据分析": 30}

    platform = [item for item in support.audits_since(client, mark) if item["target_id"] == job["id"]]
    assert [item["action"] for item in platform] == ["library_job_saved"] * 3 and {item["actor"] for item in platform} == {"hr"}
    core = [item["action"] for item in support.audits_since(client, 0, source="matching") if item["target_id"] == job["id"]]
    assert set(core) >= {"岗位新增", "岗位修改", "权重修改", "评分标准修改"}


def test_job_validation_and_permissions(client, created):
    job = support.create_library_job(client, created, "岗位库测试岗位乙")
    other = support.create_library_job(client, created, "岗位库测试岗位丙")
    before = client.get(f"/api/library/jobs/{job['id']}", headers=HR).json()
    scorecard = [
        support.job_payload("岗位库测试无效岗位", weights={"专业能力": 60, "沟通协调": 30}),
        support.job_payload("岗位库测试无效岗位", weights={"专业能力": 140, "沟通协调": -40}),
    ]
    profile = [
        support.job_payload("岗位库测试无效岗位", responsibilities=[]),
        support.job_payload("岗位库测试无效岗位", requirements=["  "]),
        support.job_payload("岗位库测试无效岗位", dimensions=[]),
        support.job_payload("   "),
        support.job_payload("岗位库测试无效岗位", level=""),
    ]
    for payload in scorecard + profile:
        assert client.post("/api/library/jobs", headers=HR, json=payload).status_code == 422, payload
    # 岗位名称不能与其他在用岗位重复。
    for payload in profile + [support.job_payload(other["name"])]:
        assert client.put(f"/api/library/jobs/{job['id']}", headers=HR, json=payload).status_code == 422, payload
    assert client.put("/api/library/jobs/JOB-NOT-EXISTING", headers=HR, json=support.job_payload("不存在")).status_code == 404
    assert "岗位库测试无效岗位" not in [item["name"] for item in client.get("/api/library/jobs", headers=HR).json()]

    for role in READ_ONLY_ROLES:
        headers = support.staff(role, role)
        assert client.get("/api/library/jobs", headers=headers).status_code == 200, role
        assert client.get(f"/api/library/jobs/{job['id']}", headers=headers).status_code == 200
        assert client.get(f"/api/library/jobs/{job['id']}/capability-tags", headers=headers).status_code == 200
        assert client.get(f"/api/library/jobs/{job['id']}/interview-standard", headers=headers).status_code == 200
        rejected = [
            client.post("/api/library/jobs", headers=headers, json=support.job_payload("岗位库测试越权岗位")),
            client.put(f"/api/library/jobs/{job['id']}", headers=headers, json=support.job_payload("岗位库测试岗位乙", level="P9")),
            client.post(f"/api/library/jobs/{job['id']}/archive", headers=headers),
            client.post(f"/api/library/jobs/{job['id']}/restore", headers=headers),
            client.delete(f"/api/library/jobs/{job['id']}", headers=headers),
            client.put(f"/api/library/jobs/{job['id']}/interview-standard", headers=headers, json={
                "competency_model": standard_model(client, job["id"]), "material_version": "v1", "audit_status": "approved"}),
            client.post(f"/api/library/jobs/{job['id']}/interview-standard/advice", headers=headers),
            client.post("/api/library/jobs/scorecard-suggestion", headers=headers, json=support.job_payload("岗位库测试岗位乙")),
            client.post("/api/library/jobs/import", headers=headers, files=[("files", ("岗位.txt", b"x", "text/plain"))]),
        ]
        assert [response.status_code for response in rejected] == [403] * len(rejected), role
    candidate = support.candidate("candidate")
    assert client.get("/api/library/jobs", headers=candidate).status_code == 403
    assert client.get(f"/api/library/jobs/{job['id']}", headers=candidate).status_code == 403
    assert client.get("/api/library/jobs").status_code == 401
    assert client.get(f"/api/library/jobs/{job['id']}", headers=HR).json() == before


@pytest.mark.parametrize("changes", [
    {"weights": {"专业能力": 60, "沟通协调": 30}},
    {"weights": {"专业能力": 100}},
    {"dimensions": [{"name": "专业能力", "keywords": []}, {"name": "专业能力", "keywords": []}]},
])
def test_rejected_job_update_changes_nothing(client, created, changes):
    job = support.create_library_job(client, created, "岗位库测试原子保存岗位")
    rejected = client.put(f"/api/library/jobs/{job['id']}", headers=HR, json=support.job_payload(
        "岗位库测试原子保存岗位（改）", level="P9", responsibilities=["被拒绝的修改不应保存"], **changes))
    assert rejected.status_code == 422
    saved = client.get(f"/api/library/jobs/{job['id']}", headers=HR).json()
    assert (saved["name"], saved["level"], saved["responsibilities"]) == (job["name"], job["level"], job["responsibilities"])


def test_same_name_needs_confirmation_before_overwriting(client, created):
    job = support.create_library_job(client, created, "岗位库测试同名岗位")
    count = len(library_job_ids(client, include_archived=True))
    changed = support.job_payload("岗位库测试同名岗位", level="P5", responsibilities=["负责薪酬核算"],
                                  dimensions=[{"name": "薪酬核算", "keywords": ["薪酬"]}], weights={"薪酬核算": 100})
    conflict = client.post("/api/library/jobs", headers=HR, json=changed)
    assert conflict.status_code == 409
    detail = conflict.json()["detail"]
    assert "岗位库测试同名岗位" in detail["message"]
    assert detail["conflict"]["job_id"] == job["id"] and detail["conflict"]["name"] == "岗位库测试同名岗位"
    revision = detail["conflict"]["revision"]
    assert len(revision) == 64
    # 没有确认覆盖时什么都不改。
    assert client.get(f"/api/library/jobs/{job['id']}", headers=HR).json() == job
    assert client.post("/api/library/jobs", headers=HR, json=changed).json()["detail"]["conflict"]["revision"] == revision
    wrong = [dict(changed, overwrite_job_id=job["id"]), dict(changed, overwrite_job_id=job["id"], overwrite_revision="0" * 64),
             dict(changed, overwrite_job_id="JOB-OTHER", overwrite_revision=revision), dict(changed, overwrite_revision=revision)]
    for payload in wrong:
        assert client.post("/api/library/jobs", headers=HR, json=payload).status_code == 409
    assert client.get(f"/api/library/jobs/{job['id']}", headers=HR).json() == job

    overwritten = client.post("/api/library/jobs", headers=HR, json=dict(changed, overwrite_job_id=job["id"], overwrite_revision=revision))
    assert overwritten.status_code == 200
    saved = overwritten.json()
    assert saved["id"] == job["id"] and saved["level"] == "P5" and saved["responsibilities"] == ["负责薪酬核算"]
    assert saved["weights"] == {"薪酬核算": 100} and saved["weight_version"].startswith("W-REPLACE-")
    assert len(library_job_ids(client, include_archived=True)) == count
    # 同一份确认只能用一次：岗位已经变化，再次覆盖需要重新确认。
    again = client.post("/api/library/jobs", headers=HR, json=dict(changed, level="P6", overwrite_job_id=job["id"], overwrite_revision=revision))
    assert again.status_code == 409 and again.json()["detail"]["conflict"]["revision"] != revision
    assert "变更" in again.json()["detail"]["message"]
    # 要覆盖的岗位已改名或删除时不新建，也不覆盖别的岗位。
    gone = client.post("/api/library/jobs", headers=HR, json=dict(
        support.job_payload("岗位库测试不存在的同名岗位"), overwrite_job_id=job["id"], overwrite_revision=revision))
    assert gone.status_code == 422
    assert len(library_job_ids(client, include_archived=True)) == count
    assert client.get(f"/api/library/jobs/{job['id']}", headers=HR).json()["level"] == "P5"


def test_interview_standard_is_validated_and_saved(client, created):
    job = support.create_library_job(client, created, "岗位库测试评价标准岗位")
    path = f"/api/library/jobs/{job['id']}/interview-standard"
    initial = client.get(path, headers=INTERVIEWER).json()
    assert initial["configured"] is False and initial["audit_status"] == "not_configured" and initial["competency_model"] == []
    assert initial["materials"] == [] and initial["batch_count"] == 0
    dimensions = [item["name"] for item in client.get("/api/dimensions", headers=HR).json()]
    assert [item["dimension"] for item in initial["default_model"]] == dimensions and len(dimensions) == 6
    assert all(item["behavior"] and set(item["levels"]) == {"1", "3", "5"} for item in initial["default_model"])

    def body(model, **changes):
        return {"professional_requirements": " 熟悉招聘流程和劳动法规 ", "competency_model": model,
                "material_version": "IS-1.0", "audit_status": "draft", **changes}

    model = standard_model(client, job["id"])
    first = model[0]
    invalid = [
        body([dict(first, dimension="领导力"), *model[1:]]),
        body([dict(first, dimension=""), *model[1:]]),
        body([first, first, *model[2:]]),
        body([dict(first, behavior="  "), *model[1:]]),
        body([dict(first, levels={"1": "缺少证据", "5": "稳定完成"}), *model[1:]]),
        body([dict(first, levels={"1": "缺少证据", "3": " ", "5": "稳定完成"}), *model[1:]]),
        body([{key: value for key, value in first.items() if key != "levels"}, *model[1:]]),
        body([]), body(model, audit_status="published"), body(model, material_version=""),
        body(model, professional_requirements="长" * 12001),
    ]
    for payload in invalid:
        assert client.put(path, headers=HR, json=payload).status_code == 422, payload
    assert client.get(path, headers=HR).json()["configured"] is False
    assert client.get("/api/jobs", headers=HR).json() == [item for item in client.get("/api/jobs", headers=HR).json()
                                                          if item["library_job_id"] != job["id"]]

    custom = standard_model(client, job["id"], 沟通表达={"behavior": "能向候选人和用人部门说清同一项政策",
                                                    "levels": {"1": "表达含糊", "3": "表达基本清楚", "5": "能因人调整并确认理解"}})
    mark = support.audit_mark(client)
    saved = client.put(path, headers=HR, json=body(custom))
    assert saved.status_code == 200
    standard = saved.json()
    assert standard["configured"] is True and standard["audit_status"] == "draft" and standard["material_version"] == "IS-1.0"
    assert standard["professional_requirements"] == "熟悉招聘流程和劳动法规" and standard["competency_model"] == custom
    assert standard["batch_count"] == 0 and standard["materials"] == []
    assert [item["action"] for item in support.audits_since(client, mark)] == ["job_material_updated"]
    fetched = client.get(path, headers=HR).json()
    assert {key: fetched[key] for key in standard} == standard and fetched["default_model"] == initial["default_model"]
    detail = client.get(f"/api/library/jobs/{job['id']}", headers=HR).json()
    assert detail["interview"] == {"configured": True, "interview_job_id": standard["interview_job_id"],
                                   "audit_status": "draft", "batch_count": 0}
    assert detail["interview_standard"]["competency_model"] == custom

    # 面试侧只读引用岗位库的岗位说明。
    interview_job = next(item for item in client.get("/api/jobs", headers=HR).json() if item["library_job_id"] == job["id"])
    assert interview_job["id"] == standard["interview_job_id"] and interview_job["name"] == job["name"]
    assert interview_job["duties"] == "负责招聘计划编制与执行\n负责人员调配和入职手续办理"
    assert "三年以上人力资源工作经验" in interview_job["requirements"] and "岗位硬性条件" in interview_job["requirements"]
    assert interview_job["audit_status"] == "draft" and interview_job["competency_model"] == custom
    updated = client.put(f"/api/library/jobs/{job['id']}", headers=HR, json=support.job_payload(
        "岗位库测试评价标准岗位（新）", responsibilities=["负责员工关系管理"], hard_conditions=[]))
    assert updated.status_code == 200
    interview_job = next(item for item in client.get("/api/jobs", headers=HR).json() if item["library_job_id"] == job["id"])
    assert interview_job["name"] == "岗位库测试评价标准岗位（新）" and interview_job["duties"] == "负责员工关系管理"
    assert "岗位硬性条件" not in interview_job["requirements"]
    assert interview_job["competency_model"] == custom and interview_job["audit_status"] == "draft"

    approved = client.put(path, headers=ADMIN, json=body(custom, audit_status="approved", material_version="IS-1.1"))
    assert approved.status_code == 200 and approved.json()["audit_status"] == "approved"
    assert approved.json()["interview_job_id"] == standard["interview_job_id"] and approved.json()["material_version"] == "IS-1.1"
    for method in (client.get, client.put):
        assert method("/api/library/jobs/JOB-NOT-EXISTING/interview-standard", headers=HR,
                      **({} if method == client.get else {"json": body(custom)})).status_code == 404


def test_interview_standard_advice_is_a_suggestion_only(client, created):
    job = support.create_library_job(client, created, "岗位库测试评分建议岗位")
    path = f"/api/library/jobs/{job['id']}/interview-standard"
    mark = support.audit_mark(client)
    response = client.post(path + "/advice", headers=HR)
    assert response.status_code == 200
    advice = response.json()
    assert advice["status"] == "suggested" and advice["provenance"] == "AI辅助生成，须人工复核"
    assert advice["job_name"] == job["name"] and advice["total_weight"] == 100
    assert [item["dimension"] for item in advice["criteria"]] == [item["name"] for item in client.get("/api/dimensions", headers=HR).json()]
    assert sum(item["suggested_weight"] for item in advice["criteria"]) == 100
    assert all(set(item["levels"]) == {"0", "1", "2", "3", "4", "5"} and item["definition"] for item in advice["criteria"])
    assert advice["guardrails"] and advice["rationale"]
    assert [item["action"] for item in support.audits_since(client, mark)] == ["job_scoring_advice_generated"]
    # 建议不直接生效：评价标准仍是默认草稿，需要人工确认后保存。
    standard = client.get(path, headers=HR).json()
    assert standard["configured"] is True and standard["audit_status"] == "draft"
    assert standard["competency_model"] == standard["default_model"]
    assert client.post("/api/library/jobs/JOB-NOT-EXISTING/interview-standard/advice", headers=HR).status_code == 404


def test_capability_tags_are_a_structured_output(client, created):
    job = support.create_library_job(client, created, "岗位库测试能力标签岗位", hard_conditions=["本科及以上学历", "持有人力资源管理师证书"])
    mark = support.audit_mark(client)
    response = client.get(f"/api/library/jobs/{job['id']}/capability-tags", headers=BUSINESS)
    assert response.status_code == 200
    tags = response.json()
    assert tags["job_id"] == job["id"] and tags["job_name"] == job["name"]
    assert (tags["sequence"], tags["level"], tags["jd_version"], tags["weight_version"]) == ("职能序列", "P3", "JD-TEST-1", "W-NEW-1.0")
    assert tags["required_tags"] == [{"name": "本科及以上学历", "type": "硬性条件"}, {"name": "持有人力资源管理师证书", "type": "硬性条件"}]
    assert tags["capability_tags"] == [{"name": "专业能力", "weight": 60, "keywords": ["招聘", "人力资源"]},
                                       {"name": "沟通协调", "weight": 40, "keywords": ["沟通", "协调"]}]
    assert sum(item["weight"] for item in tags["capability_tags"]) == 100
    assert tags["source"] == "自动化测试岗位" and tags["updated_at"] and "业务参考" in tags["notice"]
    audits = support.audits_since(client, mark)
    assert [(item["action"], item["actor"], item["target_id"]) for item in audits] == [("capability_tags_exported", "business", job["id"])]
    assert client.get("/api/library/jobs/JOB-NOT-EXISTING/capability-tags", headers=HR).status_code == 404
    assert client.get(f"/api/library/jobs/{job['id']}/capability-tags", headers=support.candidate("candidate")).status_code == 403


def test_job_can_be_archived_restored_and_purged(client, created):
    job = support.create_library_job(client, created, "岗位库测试停用岗位")
    path = f"/api/library/jobs/{job['id']}"
    standard = client.put(path + "/interview-standard", headers=HR, json={
        "competency_model": standard_model(client, job["id"]), "material_version": "IS-1.0", "audit_status": "approved"}).json()
    # 在用的岗位不能直接彻底删除。
    assert client.delete(path, headers=HR).status_code == 422
    assert client.post(path + "/archive", headers=HR).json() == {"ok": True}
    assert client.post(path + "/archive", headers=HR).status_code == 200
    assert job["id"] not in library_job_ids(client)
    archived = next(item for item in client.get("/api/library/jobs?include_archived=true", headers=HR).json() if item["id"] == job["id"])
    assert archived["is_active"] is False and archived["interview"]["configured"] is True
    assert client.get(path, headers=HR).json()["is_active"] is False
    # 已删除的岗位不能再用来建立面试批次、保存评价标准或建立匹配任务。
    refused = [
        client.post("/api/batches", headers=HR, json={"code": "LIB-ARCHIVED", "name": "停用岗位批次", "recruitment_type": "社会招聘",
                                                      "library_job_id": job["id"]}),
        client.put(path + "/interview-standard", headers=HR, json={
            "competency_model": standard_model(client, job["id"]), "material_version": "IS-1.1", "audit_status": "draft"}),
        client.post(path + "/interview-standard/advice", headers=HR),
    ]
    assert [response.status_code for response in refused] == [409] * 3
    assert client.get("/api/batches", headers=HR).json() == [item for item in client.get("/api/batches", headers=HR).json()
                                                             if item["code"] != "LIB-ARCHIVED"]

    # 已有同名的在用岗位时不能恢复。
    twin = support.create_library_job(client, created, "岗位库测试停用岗位")
    assert twin["id"] != job["id"]
    assert client.post(path + "/restore", headers=HR).status_code == 422
    assert client.post(f"/api/library/jobs/{twin['id']}/archive", headers=HR).status_code == 200
    assert client.post(path + "/restore", headers=HR).json() == {"ok": True}
    assert client.post(path + "/restore", headers=HR).status_code == 200
    assert job["id"] in library_job_ids(client) and twin["id"] not in library_job_ids(client)
    assert client.get(path, headers=HR).json()["is_active"] is True
    assert client.get(path + "/interview-standard", headers=HR).json()["audit_status"] == "approved"

    assert client.post(path + "/archive", headers=HR).status_code == 200
    assert client.delete(path, headers=HR).json() == {"ok": True}
    assert client.get(path, headers=HR).status_code == 404
    assert job["id"] not in library_job_ids(client, include_archived=True)
    assert standard["interview_job_id"] not in [item["id"] for item in client.get("/api/jobs", headers=HR).json()]
    for action in ("archive", "restore"):
        assert client.post(f"{path}/{action}", headers=HR).status_code == 404
    assert client.delete(path, headers=HR).status_code in {404, 422}


def test_job_in_use_by_interview_batches_is_protected(client, created):
    job = support.create_library_job(client, created, "岗位库测试在用岗位")
    path = f"/api/library/jobs/{job['id']}"
    batch = support.create_batch(client, created, "LIB-INUSE", "在用岗位批次", library_job_id=job["id"], mode="listening_only")
    # 只有批次、还没有候选人时可以停用，但不能彻底删除。
    assert client.post(path + "/archive", headers=HR).status_code == 200
    assert client.delete(path, headers=HR).status_code == 409
    assert client.post("/api/candidates", headers=HR, json={"name": "停用岗位候选人", "batch_id": batch["id"]}).status_code == 200
    created.candidates.append(client.get("/api/candidates", headers=HR, params={"batch_id": batch["id"]}).json()[0]["id"])
    assert client.post(path + "/restore", headers=HR).status_code == 200
    # 已有候选人的岗位不能停用。
    assert client.post(path + "/archive", headers=HR).status_code == 409
    assert client.get(path, headers=HR).json()["is_active"] is True
    assert client.get(path, headers=HR).json()["interview"]["batch_count"] == 1


def test_batch_on_library_job_starts_from_a_draft_standard(client, created):
    job = support.create_library_job(client, created, "岗位库测试批次岗位")
    standard_path = f"/api/library/jobs/{job['id']}/interview-standard"
    assert client.get(standard_path, headers=HR).json()["configured"] is False
    missing = [{"library_job_id": "JOB-NOT-EXISTING"}, {"job_id": 999999}, {}]
    for reference in missing:
        response = client.post("/api/batches", headers=HR, json={
            "code": "LIB-MISSING", "name": "岗位不存在的批次", "recruitment_type": "社会招聘", **reference})
        assert response.status_code == 404, reference
    assert client.post("/api/batches", headers=HR, json={
        "code": "LIB-BATCH-X", "name": "方式无效的批次", "recruitment_type": "社会招聘", "library_job_id": job["id"],
        "mode": "video_interview"}).status_code == 422
    assert client.post("/api/batches", headers=HR, json={
        "code": "LIB-BATCH-X", "name": "类型无效的批次", "recruitment_type": "实习招聘", "library_job_id": job["id"]}).status_code == 422
    assert client.get(standard_path, headers=HR).json()["configured"] is False

    batch = support.create_batch(client, created, "LIB-BATCH-1", "岗位库岗位批次", library_job_id=job["id"])
    assert batch["library_job_id"] == job["id"] and batch["job_name"] == job["name"]
    assert batch["job_audit_status"] == "draft" and batch["mode"] == "ai_interview" and batch["status"] == "draft"
    assert batch["question_version"] == 0 and batch["accepts_candidates"] is False and batch["candidate_count"] == 0
    # 批次关联岗位时自动按六维默认标准建立评价标准草稿。
    standard = client.get(standard_path, headers=HR).json()
    assert standard["configured"] is True and standard["audit_status"] == "draft" and standard["batch_count"] == 1
    assert standard["interview_job_id"] == batch["job_id"] and standard["material_version"] == "JD-TEST-1"
    assert standard["competency_model"] == standard["default_model"]
    assert standard["professional_requirements"] == "专业能力；沟通协调"
    second = support.create_batch(client, created, "LIB-BATCH-2", "同岗位的第二个批次", library_job_id=job["id"], mode="listening_only")
    assert second["job_id"] == batch["job_id"]
    assert client.get(standard_path, headers=HR).json()["batch_count"] == 2
    assert len([item for item in client.get("/api/jobs", headers=HR).json() if item["library_job_id"] == job["id"]]) == 1
    assert client.post("/api/batches", headers=HR, json={
        "code": "LIB-BATCH-1", "name": "编号重复", "recruitment_type": "社会招聘", "library_job_id": job["id"]}).status_code == 409

    # 评价标准确认前不能生成题目。
    generate = f"/api/batches/{batch['id']}/questions/generate"
    assert client.post(generate, headers=HR, json={"count": 3}).status_code == 409
    assert client.put(standard_path, headers=HR, json={
        "competency_model": standard["competency_model"], "material_version": "IS-1.0", "audit_status": "approved"}).status_code == 200
    listed = next(item for item in client.get("/api/batches", headers=HR).json() if item["id"] == batch["id"])
    assert listed["job_audit_status"] == "approved"
    generated = client.post(generate, headers=HR, json={"count": 3})
    assert generated.status_code == 200 and generated.json()["count"] == 3


def test_supplementary_material_is_kept_even_when_recognition_is_unavailable(client, created):
    import fitz
    job = support.create_library_job(client, created, "岗位库测试补充资料岗位")
    path = f"/api/library/jobs/{job['id']}/materials"
    document = fitz.open()
    document.new_page().insert_text((60, 60), "Job supplementary material")
    pdf = document.tobytes()
    document.close()
    rejected = [
        client.post(path, headers=HR, files={"file": ("岗位资料.docx", pdf, "application/pdf")}),
        client.post(path, headers=HR, files={"file": ("岗位资料.pdf", b"not a pdf", "application/pdf")}),
        client.post("/api/library/jobs/JOB-NOT-EXISTING/materials", headers=HR, files={"file": ("岗位资料.pdf", pdf, "application/pdf")}),
    ]
    assert [response.status_code for response in rejected] == [422, 422, 404]
    assert client.post(path, headers=INTERVIEWER, files={"file": ("岗位资料.pdf", pdf, "application/pdf")}).status_code == 403
    mark = support.audit_mark(client)
    uploaded = client.post(path, headers=HR, files={"file": ("岗位资料.pdf", pdf, "application/pdf")})
    assert uploaded.status_code == 200
    material = uploaded.json()
    assert material["original_name"] == "岗位资料.pdf" and material["size"] == len(pdf)
    # 测试环境没有文字识别服务：原件保留，如实标记识别未完成，不生成替代文本。
    assert material["ocr_status"] == "failed" and material["ocr_error"] and material["ocr_text_preview"] == ""
    assert [item["action"] for item in reversed(support.audits_since(client, mark))] == ["job_material_uploaded", "job_material_ocr_failed"]
    standard = client.get(f"/api/library/jobs/{job['id']}/interview-standard", headers=HR).json()
    assert standard["configured"] is True
    assert [(item["id"], item["original_name"], item["ocr_status"]) for item in standard["materials"]] == [(material["id"], "岗位资料.pdf", "failed")]

    other = support.create_library_job(client, created, "岗位库测试补充资料岗位二")
    assert client.delete(f"/api/library/jobs/{other['id']}/materials/{material['id']}", headers=HR).status_code == 404
    assert client.delete(f"{path}/{material['id']}", headers=INTERVIEWER).status_code == 403
    assert client.delete(f"{path}/{material['id']}", headers=HR).json() == {"ok": True}
    assert client.delete(f"{path}/{material['id']}", headers=HR).status_code == 404
    assert client.get(f"/api/library/jobs/{job['id']}/interview-standard", headers=HR).json()["materials"] == []


def test_job_description_import_needs_the_extraction_model(client):
    before = library_job_ids(client, include_archived=True)
    text = "岗位名称：导入测试岗位\n岗位职责：\n负责招聘\n任职要求：\n本科及以上学历\n".encode("utf-8")
    rejected = [
        client.post("/api/library/jobs/import", headers=HR, files=[("files", ("岗位说明书.xlsx", text, "application/octet-stream"))]),
        client.post("/api/library/jobs/import", headers=HR,
                    files=[("files", (f"岗位说明书{index}.txt", text, "text/plain")) for index in range(11)]),
        client.post("/api/library/jobs/import", headers=HR),
    ]
    assert [response.status_code for response in rejected] == [422, 422, 422]
    response = client.post("/api/library/jobs/import", headers=HR, data={"reference_job_id": ""},
                           files=[("files", ("岗位说明书.txt", text, "text/plain")), ("files", ("岗位说明书二.txt", text, "text/plain"))])
    assert response.status_code == 200 and response.json()["kind"] == "job_import"
    operation = support.wait_operation(client, response.json(), HR)
    # 没有配置信息提取模型时如实说明未识别，不用本地规则凑出草稿。
    assert operation["status"] == "completed"
    drafts = operation["result"]["drafts"]
    assert [(item["source_file"], item["draft"]) for item in drafts] == [("岗位说明书.txt", None), ("岗位说明书二.txt", None)]
    assert all(item["error"] and "尚未启用" in item["error"] for item in drafts)
    assert library_job_ids(client, include_archived=True) == before
    suggestion = client.post("/api/library/jobs/scorecard-suggestion", headers=HR, json=support.job_payload("评分建议测试岗位"))
    assert suggestion.status_code == 422 and "尚未启用" in suggestion.json()["detail"]
    assert client.get(f"/api/library/operations/{response.json()['id']}", headers=ADMIN).status_code == 404
    assert client.get("/api/library/operations/not-existing", headers=HR).status_code == 404


# ---- 人员库 ---------------------------------------------------------------------

def person_batches(client):
    return {item["id"]: item for item in client.get("/api/library/person-batches", headers=HR).json()}


def test_person_batch_crud_and_categories(client, created):
    assert client.get("/api/library/person-categories", headers=HR).json() == {
        "selectable": ["社招", "校招", "内聘"], "all": ["校招", "社招", "内聘", "未分类"],
        # 一次导入的份数上限是单个匹配任务人数上限（默认 20）的 5 倍。
        "import_limit": 100}
    mark = support.audit_mark(client)
    batches = {category: support.create_person_batch(client, created, f" 人员库测试{category}批次 ", category)
               for category in ("社招", "校招", "内聘")}
    internal = batches["内聘"]
    assert internal["id"].startswith("TLB-") and internal["name"] == "人员库测试内聘批次" and internal["category"] == "内聘"
    assert (internal["total_count"], internal["parsed_count"], internal["failed_count"], internal["pending_count"]) == (0, 0, 0, 0)
    assert internal["created_at"] and "hr" in internal["created_by"]
    assert [item["action"] for item in support.audits_since(client, mark)] == ["person_batch_created"] * 3
    listed = person_batches(client)
    assert {batch["id"] for batch in batches.values()} <= set(listed) and listed[internal["id"]] == internal
    assert client.get(f"/api/library/person-batches/{internal['id']}", headers=HR).json() == {**internal, "persons": []}
    assert client.get("/api/library/person-batches/TLB-NOT-EXISTING", headers=HR).status_code == 404

    before = set(person_batches(client))
    # “未分类”只用于历史数据，新建批次不能选择。
    for payload in ({"name": "人员库测试无效批次", "category": "未分类"}, {"name": "人员库测试无效批次", "category": "全职"},
                    {"name": "人员库测试无效批次", "category": ""}, {"name": "人员库测试无效批次"},
                    {"name": "", "category": "社招"}, {"name": "   ", "category": "社招"}, {"name": "长" * 101, "category": "社招"}):
        assert client.post("/api/library/person-batches", headers=HR, json=payload).status_code == 422, payload
    assert set(person_batches(client)) == before

    renamed = client.put(f"/api/library/person-batches/{internal['id']}", headers=HR, json={"name": "人员库测试内部竞聘批次", "category": "校招"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "人员库测试内部竞聘批次" and renamed.json()["category"] == "校招"
    assert renamed.json()["id"] == internal["id"]
    assert client.put(f"/api/library/person-batches/{internal['id']}", headers=HR, json={"name": " ", "category": "校招"}).status_code == 422
    assert client.put(f"/api/library/person-batches/{internal['id']}", headers=HR, json={"name": "人员库测试", "category": "全职"}).status_code == 422
    assert client.put("/api/library/person-batches/TLB-NOT-EXISTING", headers=HR, json={"name": "不存在", "category": "社招"}).status_code == 404
    assert person_batches(client)[internal["id"]]["name"] == "人员库测试内部竞聘批次"

    for role in ("business_user", "interviewer", "report_reviewer"):
        headers = support.staff(role, role)
        assert client.get("/api/library/person-batches", headers=headers).status_code == 200
        assert client.get("/api/library/person-categories", headers=headers).status_code == 200
        assert client.get(f"/api/library/person-batches/{internal['id']}", headers=headers).status_code == 200
        rejected = [
            client.post("/api/library/person-batches", headers=headers, json={"name": "人员库测试越权批次", "category": "社招"}),
            client.put(f"/api/library/person-batches/{internal['id']}", headers=headers, json={"name": "越权改名", "category": "社招"}),
            client.post("/api/library/person-batches/delete", headers=headers, json={"batch_ids": [internal["id"]]}),
            client.post(f"/api/library/person-batches/{internal['id']}/import", headers=headers,
                        files=[("files", ("简历.txt", "姓名：越权".encode("utf-8"), "text/plain"))]),
            client.post("/api/library/uploads/preflight", headers=headers,
                        files=[("files", ("简历.txt", "姓名：越权".encode("utf-8"), "text/plain"))]),
        ]
        assert [response.status_code for response in rejected] == [403] * 5, role
    for role in ("question_reviewer", "candidate"):
        assert client.get("/api/library/person-batches", headers=support.staff(role, role)).status_code == 403
        assert client.get(f"/api/library/person-batches/{internal['id']}", headers=support.staff(role, role)).status_code == 403

    # 删除是整体操作：选中的批次有一个不存在就都不删除。
    ids = [batch["id"] for batch in batches.values()]
    assert client.post("/api/library/person-batches/delete", headers=HR, json={"batch_ids": [ids[0], "TLB-NOT-EXISTING"]}).status_code == 422
    assert client.post("/api/library/person-batches/delete", headers=HR, json={"batch_ids": []}).status_code == 422
    assert set(ids) <= set(person_batches(client))
    deleted = client.post("/api/library/person-batches/delete", headers=HR, json={"batch_ids": ids[:2] + ids[:1]})
    assert deleted.status_code == 200 and deleted.json() == {"deleted_batches": 2, "deleted_entries": 0}
    assert set(person_batches(client)) & set(ids) == {ids[2]}


@pytest.fixture
def people(client, created):
    """一个人员批次，导入了一份 TXT 简历和一份 Word 简历。"""
    batch = support.create_person_batch(client, created, "人员库测试导入批次", "内聘")
    files = [("人员甲.txt", support.resume_text("人员甲", "LIB-P-001").encode("utf-8")),
             ("人员乙.docx", support.docx_bytes(support.resume_text("人员乙", "LIB-P-002", phone="13987654321")))]
    result = support.import_persons(client, batch["id"], files)
    assert result["failed"] == [] and len(result["imported"]) == 2
    first, second = result["imported"]
    return batch, first, second, dict(files)


def test_resumes_are_imported_in_the_background(client, created, people):
    batch, first, second, files = people
    assert (first["name"], first["source_filename"], first["status"]) == ("人员甲", "人员甲.txt", "已解析")
    assert (second["name"], second["source_filename"], second["status"]) == ("人员乙", "人员乙.docx", "已解析")
    for person in (first, second):
        assert person["id"].startswith("TLE-") and person["batch_id"] == batch["id"] and person["error_message"] == ""
        assert person["confirmed"] is False and person["material_version"] == 0
        assert person["education"] == "本科，人力资源管理专业" and person["work_experience"] == "三年招聘与人员调配工作"
    detail = client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()
    assert (detail["total_count"], detail["parsed_count"], detail["failed_count"], detail["pending_count"]) == (2, 2, 0, 0)
    assert sorted(detail["persons"], key=lambda item: item["id"]) == sorted([first, second], key=lambda item: item["id"])

    person = client.get(f"/api/library/persons/{first['id']}", headers=BUSINESS).json()
    assert {key: person[key] for key in first} == first
    fields = {item["key"]: item for item in person["profile"]["fields"]}
    assert list(fields) == ["education", "work_experience", "tenure", "skills", "projects", "interview_evaluation", "additional_material"]
    assert fields["skills"]["value"] == "招聘、沟通协调、人力资源规划" and fields["skills"]["status"] == "已识别"
    assert fields["skills"]["source_file"] == "人员甲.txt" and fields["skills"]["location"]
    assert fields["interview_evaluation"]["value"] == "" and fields["interview_evaluation"]["label"] == "面试评价与纪要"
    assert [item["key"] for item in person["editable_fields"]] == [
        "education", "work_experience", "projects", "skills", "tenure", "interview_evaluation", "additional_material"]
    # 保存的证据已脱敏，原件保持不变。
    evidence = "\n".join(item["text"] for item in person["evidence"])
    assert "138****5678" in evidence and "13812345678" not in evidence and person["evidence_total"] == len(person["evidence"])
    assert person["matching_history"] == [] and person["interviews"] == []
    # 参与复核的角色（含用人部门）都可以核对和修正人员资料。
    assert person["can_edit"] is True
    assert client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["can_edit"] is True
    for entry, name in ((first, "人员甲.txt"), (second, "人员乙.docx")):
        original = client.get(f"/api/library/persons/{entry['id']}/file", headers=HR)
        assert original.status_code == 200 and original.content == files[name]
    assert client.get("/api/library/persons/TLE-NOT-EXISTING", headers=HR).status_code == 404
    assert client.get("/api/library/persons/TLE-NOT-EXISTING/file", headers=HR).status_code == 404
    for role in ("question_reviewer", "candidate"):
        assert client.get(f"/api/library/persons/{first['id']}", headers=support.staff(role, role)).status_code == 403
        assert client.get(f"/api/library/persons/{first['id']}/file", headers=support.staff(role, role)).status_code == 403


def test_import_rejects_unusable_files_and_reports_unreadable_ones(client, created):
    batch = support.create_person_batch(client, created, "人员库测试异常导入批次")
    path = f"/api/library/person-batches/{batch['id']}/import"
    resume = support.resume_text("人员丙").encode("utf-8")
    rejected = [
        client.post(path, headers=HR, files=[("files", ("简历.xlsx", resume, "application/octet-stream"))]),
        client.post(path, headers=HR, files=[("files", ("简历.txt", b"", "text/plain"))]),
        client.post(path, headers=HR, files=[("files", ("简历.pdf", b"not a pdf", "application/pdf"))]),
        client.post(path, headers=HR, files=[("files", ("简历.txt", resume, "text/plain"))], data={"minute_assignments": "不是对应关系"}),
        client.post(path, headers=HR),
    ]
    assert [response.status_code for response in rejected] == [422] * 5
    assert client.post("/api/library/person-batches/TLB-NOT-EXISTING/import", headers=HR,
                       files=[("files", ("简历.txt", resume, "text/plain"))]).status_code == 404
    assert client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()["persons"] == []
    preflight = client.post("/api/library/uploads/preflight", headers=HR, files=[("files", ("简历.txt", resume, "text/plain"))])
    assert preflight.status_code == 200 and preflight.json() == {"scans": [], "errors": []}

    # 同名文件各自保存；读不出内容的文件留下记录并说明原因，不影响其他人。
    result = support.import_persons(client, batch["id"], [("简历.txt", resume), ("简历.txt", support.resume_text("人员丁").encode("utf-8")),
                                                          ("空白.txt", "  \n \n".encode("utf-8"))])
    assert [(item["name"], item["source_filename"]) for item in result["imported"]] == [("人员丙", "简历.txt"), ("人员丁", "简历_2.txt")]
    assert len(result["failed"]) == 1
    failed = result["failed"][0]
    assert failed["status"] == "解析失败" and failed["source_filename"] == "空白.txt" and failed["error_message"]
    detail = client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()
    assert (detail["total_count"], detail["parsed_count"], detail["failed_count"], detail["pending_count"]) == (3, 2, 1, 0)
    overview = client.get("/api/overview", headers=HR).json()
    assert overview["library"]["persons_failed"] >= 1
    assert any("解析未完成" in item["title"] for item in overview["todo"])

    retry = client.post(f"/api/library/persons/{failed['id']}/retry", headers=HR)
    assert retry.status_code == 200 and retry.json()["kind"] == "person_retry"
    operation = support.wait_operation(client, retry.json(), HR)
    assert operation["status"] == "completed" and operation["result"]["status"] == "解析失败"
    assert client.post(f"/api/library/persons/{failed['id']}/retry", headers=INTERVIEWER).status_code == 403
    assert client.post("/api/library/persons/TLE-NOT-EXISTING/retry", headers=HR).status_code == 404
    # 解析失败的资料可以由工作人员手工补录。
    empty = client.put(f"/api/library/persons/{failed['id']}/material", headers=HR, json={"fields": {}, "confirmed": True})
    assert empty.status_code == 422
    manual = client.put(f"/api/library/persons/{failed['id']}/material", headers=HR, json={
        "fields": {"education": "本科，行政管理专业"}, "full_name": "人员戊", "confirmed": True})
    assert manual.status_code == 200 and manual.json()["status"] == "已解析" and manual.json()["name"] == "人员戊"
    assert client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()["failed_count"] == 0


def test_scanned_pages_need_authorization_before_import(client, created):
    import fitz
    with fitz.open() as document:
        document.new_page().insert_text((40, 40), "Resume: three years of recruiting experience")
        document.new_page().draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
        pdf = document.tobytes()
    scans = [{"file": "扫描简历.pdf", "pages": "2", "page_count": 2, "text_pages": 1, "blank_pages": 0}]
    batch = support.create_person_batch(client, created, "人员库测试扫描件批次")
    files = [("files", ("扫描简历.pdf", pdf, "application/pdf"))]
    preflight = client.post("/api/library/uploads/preflight", headers=HR, files=files)
    assert preflight.status_code == 200 and preflight.json() == {"scans": scans, "errors": []}
    # 扫描页要发送到识别服务，没有确认授权时整批都不导入。
    path = f"/api/library/person-batches/{batch['id']}/import"
    refused = client.post(path, headers=HR, files=files + [("files", ("文字简历.txt", support.resume_text("人员己").encode("utf-8"), "text/plain"))])
    assert refused.status_code == 409
    assert refused.json()["detail"]["scans"] == scans and "授权" in refused.json()["detail"]["message"]
    assert client.post(path, headers=HR, files=files, data={"allow_ocr": "false"}).status_code == 409
    assert client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()["persons"] == []
    interview_batch = support.create_batch(client, created, "LIB-SCAN", "扫描件测试批次", mode="listening_only")
    candidate = support.create_candidate(client, created, interview_batch["id"], "扫描件候选人")
    upload = client.post(f"/api/candidates/{candidate['id']}/resume", headers=HR, files={"file": ("扫描简历.pdf", pdf, "application/pdf")})
    assert upload.status_code == 409 and upload.json()["detail"]["scans"] == scans
    row = client.get("/api/candidates", headers=HR, params={"batch_id": interview_batch["id"]}).json()[0]
    assert row["resume"]["uploaded"] is False and row["library_person_id"] is None

    # 已确认授权但识别服务没有配置：保留能读出的文字页，如实提示扫描页未识别。
    result = support.import_persons(client, batch["id"], [("扫描简历.pdf", pdf)], allow_ocr="true")
    assert result["failed"] == [] and len(result["imported"]) == 1
    person = client.get(f"/api/library/persons/{result['imported'][0]['id']}", headers=HR).json()
    assert person["status"] == "已解析" and person["confirmed"] is False and person["warning"]
    assert "人工确认" in person["parse_status"]
    assert [item["text"] for item in person["evidence"]] == ["Resume: three years of recruiting experience"]
    assert all("第1页" in item["location"] for item in person["evidence"])


def test_person_material_can_be_corrected_and_confirmed(client, people):
    _, first, _, files = people
    path = f"/api/library/persons/{first['id']}/material"
    mark = support.audit_mark(client)
    edited = client.put(path, headers=HR, json={"fields": {"education": "硕士，人力资源管理专业", "additional_material": "持有人力资源管理师证书"}})
    assert edited.status_code == 200
    person = edited.json()
    assert person["material_version"] == 1 and person["confirmed"] is False and person["parse_status"] == "待人工确认"
    assert person["education"] == "硕士，人力资源管理专业"
    fields = {item["key"]: item for item in person["profile"]["fields"]}
    assert fields["education"]["status"] == "人工已修改，待确认" and fields["education"]["source_file"] == "人工核实记录"
    assert fields["additional_material"]["value"] == "持有人力资源管理师证书"
    assert fields["work_experience"]["value"] == "三年招聘与人员调配工作" and fields["work_experience"]["status"] == "已识别"

    rejected = [
        {"fields": {"education": "博士"}, "expected_material_version": 0},
        {"fields": {"salary": "面议"}},
        {"fields": {"education": ["本科"]}},
        {"fields": {"additional_material": "联系电话 13912345678"}},
        {"fields": {}, "full_name": "  "},
        {"fields": {}, "full_name": "姓" * 101},
    ]
    for payload in rejected:
        assert client.put(path, headers=HR, json=payload).status_code == 422, payload
    assert client.put("/api/library/persons/TLE-NOT-EXISTING/material", headers=HR, json={"fields": {"education": "本科"}}).status_code == 404
    for role in ("question_reviewer", "candidate"):
        assert client.put(path, headers=support.staff(role, role), json={"fields": {"education": "越权修改"}}).status_code == 403
    assert client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["material_version"] == 1

    # 面试官和用人部门参与复核，可以核对并确认资料。
    confirmed = client.put(path, headers=INTERVIEWER, json={"fields": {}, "full_name": "人员甲（已核对）", "confirmed": True,
                                                            "expected_material_version": 1})
    assert confirmed.status_code == 200
    person = confirmed.json()
    assert person["material_version"] == 2 and person["confirmed"] is True and person["parse_status"] == "人工已复核"
    assert person["name"] == "人员甲（已核对）" and person["education"] == "硕士，人力资源管理专业"
    assert {item["status"] for item in person["profile"]["fields"]} == {"人工已确认"}
    detail = client.get(f"/api/library/persons/{first['id']}", headers=HR).json()
    assert any(item["origin"] == "human_review" and "硕士" in item["text"] for item in detail["evidence"])
    assert not any("本科，人力资源管理专业" in item["text"] for item in detail["evidence"])
    actions = [(item["action"], item["actor"]) for item in reversed(support.audits_since(client, mark))]
    assert actions == [("person_material_updated", "hr"), ("person_material_confirmed", "interviewer")]
    # 原件不因核对而改变；已有人工修改的资料不能用重新解析覆盖。
    assert client.get(f"/api/library/persons/{first['id']}/file", headers=HR).content == files["人员甲.txt"]
    retry = client.post(f"/api/library/persons/{first['id']}/retry", headers=HR)
    assert retry.status_code == 200
    assert support.wait_operation(client, retry.json(), HR)["status"] == "failed"
    assert client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["education"] == "硕士，人力资源管理专业"


def test_person_list_and_files_can_be_exported(client, people):
    batch, first, second, files = people
    path = f"/api/library/person-batches/{batch['id']}/export"
    mark = support.audit_mark(client)
    response = client.get(path, headers=HR, params={"kind": "csv"})
    assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
    assert unquote(response.headers["x-download-name"]) == "人员库测试导入批次_人员明细.csv"
    rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert sorted((row["姓名"], row["简历文件"], row["解析状态"], row["资料确认"]) for row in rows) == [
        ("人员乙", "人员乙.docx", "已解析", "待确认"), ("人员甲", "人员甲.txt", "已解析", "待确认")]
    assert list(rows[0]) == ["姓名", "简历文件", "解析状态", "资料确认", "导入时间", "处理说明"]
    assert "13812345678" not in response.text
    selected = client.get(path, headers=BUSINESS, params={"kind": "csv", "ids": second["id"]})
    assert [row["姓名"] for row in csv.DictReader(io.StringIO(selected.content.decode("utf-8-sig")))] == ["人员乙"]

    single = client.get(path, headers=HR, params={"kind": "resumes", "ids": first["id"]})
    assert single.status_code == 200 and single.content == files["人员甲.txt"]
    archive = client.get(path, headers=HR, params={"kind": "resumes"})
    assert archive.status_code == 200 and unquote(archive.headers["x-download-name"]).endswith(".zip")
    with ZipFile(io.BytesIO(archive.content)) as package:
        assert sorted(package.read(name) for name in package.namelist()) == sorted(files.values())
    profile = client.get(path, headers=HR, params={"kind": "profiles", "ids": first["id"]})
    assert profile.status_code == 200 and unquote(profile.headers["x-download-name"]).endswith(".docx")
    text = support.document_xml(profile.content)
    assert "人员简历资料报告" in text and "人员甲" in text and "本科，人力资源管理专业" in text
    actions = [item["action"] for item in reversed(support.audits_since(client, mark))]
    assert actions == ["person_list_exported", "person_list_exported", "person_files_exported", "person_files_exported", "person_files_exported"]

    # 面试官可以查看人员资料，但不能导出；候选人和题目审核人不能访问人员库。
    for kind in ("csv", "resumes", "profiles"):
        assert client.get(path, headers=INTERVIEWER, params={"kind": kind}).status_code == 403, kind
        assert client.get(path, headers=support.staff("question_reviewer", "question_reviewer"), params={"kind": kind}).status_code == 403
    assert client.get(path, headers=HR, params={"kind": "xlsx"}).status_code == 422
    assert client.get(path, headers=HR).status_code == 422
    assert client.get("/api/library/person-batches/TLB-NOT-EXISTING/export", headers=HR, params={"kind": "csv"}).status_code == 404
    other = client.get(path, headers=HR, params={"kind": "resumes", "ids": "TLE-NOT-IN-BATCH"})
    assert other.status_code == 422


def test_people_linked_to_interview_candidates_cannot_be_deleted(client, created, people):
    batch, first, second, _ = people
    interview_batch = support.create_batch(client, created, "LIB-LINKED", "人员库关联测试批次", mode="listening_only")
    linked = support.create_candidate(client, created, interview_batch["id"], "人员甲", library_person_id=first["id"])
    assert linked["library_person_id"] == first["id"] and linked["resume"]["source"] == "library"
    records = client.get(f"/api/library/persons/{first['id']}", headers=HR).json()["interviews"]
    assert records == [{"candidate_id": linked["id"], "candidate_code": linked["code"], "batch_name": "人员库关联测试批次",
                        "job_name": interview_batch["job_name"], "interview_status": "not_created",
                        "report_status": "not_generated", "match_score": None}]
    assert client.get(f"/api/library/persons/{second['id']}", headers=HR).json()["interviews"] == []
    refused = client.post("/api/library/person-batches/delete", headers=HR, json={"batch_ids": [batch["id"]]})
    assert refused.status_code == 409
    assert client.get(f"/api/library/person-batches/{batch['id']}", headers=HR).json()["total_count"] == 2
    support.purge_candidates([linked["id"]])
    deleted = client.post("/api/library/person-batches/delete", headers=HR, json={"batch_ids": [batch["id"]]})
    assert deleted.status_code == 200 and deleted.json() == {"deleted_batches": 1, "deleted_entries": 2}
    assert client.get(f"/api/library/persons/{first['id']}", headers=HR).status_code == 404
