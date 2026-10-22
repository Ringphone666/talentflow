"""佐证数据：把一次匹配任务的全流程依据整理成结构化结果和可归档的数据包。

评审要求人岗匹配的全流程佐证材料与数据能够回流业务系统，用于处理申诉。业务系统的接收
接口尚未确定，这里先提供两种取数方式：结构化结果接口（JSON）和佐证数据包（ZIP）。
"""
from __future__ import annotations

import io
import json
import re
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from matching_core.config import DISCLAIMER, REPORT_DIR
from matching_core.db import rows
from matching_core.services import batches, workflow
from matching_core.services.auth import can, operator_name
from matching_core.services.audit import record_audit
from matching_core.services.batch_reports import _safe_payload, _safe_text

from .views import MODES, assessment_view, material_view, person_rows


def _folder(value: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")[:60] or "未命名"


def task_results(task_id: str, candidate_ids: list[str] | None = None) -> dict:
    """任务的结构化结果：岗位标准、每人各维度评分与依据、硬性条件核验、人工结论。"""
    snapshot = batches.batch_snapshot(task_id)
    task, jobs = snapshot["task"], snapshot["jobs"]
    fit = task.get("task_mode") == "人找岗位"
    job_ids = task.get("job_ids") or [task["job_id"]]
    wanted = set(candidate_ids) if candidate_ids else None
    matches: dict[str, list[dict]] = {}
    for match in snapshot["matches"]:
        matches.setdefault(match["candidate_id"], []).append(match)
    overview = {row["candidate_id"]: row for row in person_rows(snapshot)}
    people = []
    for candidate in snapshot["candidates"]:
        if wanted is not None and candidate["id"] not in wanted:
            continue
        row = overview.get(candidate["id"], {})
        subjects = matches.get(candidate["id"], []) if fit else [candidate]
        people.append(_safe_payload({
            "candidate_id": candidate["id"], "candidate_code": candidate["parsed"].get("candidate_code", candidate["id"]),
            "name": candidate["full_name"], "person_id": candidate.get("source_candidate_id") or "",
            "source_filename": candidate["source_filename"], "rank": row.get("rank"),
            "review_status": row.get("review_status"), "report_ready": row.get("report_ready"),
            "reviewer": operator_name(row.get("reviewer", "")), "reviewed_at": row.get("reviewed_at", ""),
            "material": material_view(candidate),
            "redaction": {"status": candidate["redaction_status"], "types": candidate["sensitive_types"]},
            "assessments": [{
                "job_id": subject["job_id"], "job_name": jobs.get(subject["job_id"], {}).get("name", ""),
                "decision": subject.get("decision"), "review_comment": subject.get("review_comment", ""),
                **assessment_view(subject["score"], jobs.get(subject["job_id"])),
            } for subject in subjects],
        }))
    return {
        "task": {"id": task["id"], "name": batches.batch_title(task, jobs), "mode": MODES.get(task["task_mode"]),
                 "status": task["status"], "created_at": task["created_at"], "updated_at": task["updated_at"]},
        "jobs": [_safe_payload({key: jobs[job_id].get(key) for key in (
            "id", "name", "sequence", "level", "jd_version", "weight_version", "responsibilities", "requirements",
            "hard_conditions", "dimensions", "weights")}) for job_id in job_ids if job_id in jobs],
        "people": people, "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "notice": DISCLAIMER,
    }


def task_audits(task_id: str) -> list[dict]:
    return rows("SELECT operation_time,operation_type,object_type,object_id,before_json,after_json,operator "
                "FROM audits WHERE object_id=? OR object_id LIKE ? ORDER BY id", (task_id, task_id + "%"))


def _shared_export(path: Path) -> bool:
    """涉及多人的导出文件：多人对比报告和单人报告打包。"""
    return path.suffix.lower() == ".zip" or "_多人对比_" in path.name


def build_package(task_id: str, candidate_ids: list[str] | None, operator: str, include_originals: bool) -> tuple[bytes, str]:
    """生成佐证数据包。原始简历含未脱敏个人信息，仅在调用方明确要求时打包。

    每个人的文件夹里放这个人的单人报告；多人对比报告和报告包涉及多人，只在“报告/”里放一份。
    """
    if not can(operator, "export_report"):
        raise PermissionError("当前角色无权导出佐证数据")
    results = task_results(task_id, candidate_ids)
    if not results["people"]:
        raise ValueError("所选人员尚无可导出的匹配结果")
    selected = {person["candidate_id"] for person in results["people"]}
    candidates = {item["id"]: item for item in workflow.get_candidates(task_id) if item["id"] in selected}
    audits = task_audits(task_id)
    buffer = io.BytesIO()
    report_root = REPORT_DIR.resolve()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        manifest = {"task": results["task"], "people": len(results["people"]),
                    "generated_at": results["generated_at"], "generated_by": operator_name(operator),
                    "include_originals": include_originals, "notice": results["notice"],
                    "contents": ["结果.json：岗位标准、各维度评分与依据、硬性条件核验、人工结论",
                                 "人员/<编号>/脱敏材料.txt：送入模型分析的脱敏文本",
                                 "人员/<编号>/结构化资料.json：解析字段与原文证据位置",
                                 "人员/<编号>/报告/：已导出的单人正式报告",
                                 "报告/：已导出的多人对比报告和报告包（涉及多人，只放一份）",
                                 "操作记录.csv：本任务的处理、修改、复核、导出记录"]}
        archive.writestr("说明.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("结果.json", json.dumps(results, ensure_ascii=False, indent=2))
        shared: dict[str, Path] = {}
        for person in results["people"]:
            candidate = candidates[person["candidate_id"]]
            folder = f"人员/{_folder(person['candidate_code'])}_{_folder(person['name'])}"
            redacted = Path(candidate.get("redacted_path") or "")
            if redacted.is_file():
                archive.write(redacted, f"{folder}/脱敏材料.txt")
            archive.writestr(f"{folder}/结构化资料.json",
                             json.dumps(_safe_payload(candidate["parsed"]), ensure_ascii=False, indent=2))
            original = Path(candidate.get("original_path") or "")
            if include_originals and original.is_file():
                archive.write(original, f"{folder}/原始材料/{_folder(original.name)}")
            seen = set()
            for report in workflow.get_reports(candidate["id"]):
                path = Path(report["path"])
                if not path.is_file() or not path.resolve().is_relative_to(report_root):
                    continue
                if _shared_export(path):
                    shared.setdefault(path.name, path)
                elif path.name not in seen:
                    seen.add(path.name)
                    archive.write(path, f"{folder}/报告/{path.name}")
        for name, path in sorted(shared.items()):
            archive.write(path, f"报告/{name}")
        records = [{"操作时间": item["operation_time"], "操作类型": item["operation_type"],
                    "对象类型": item["object_type"], "对象": item["object_id"],
                    "操作人": item["operator"], "变更前": item["before_json"], "变更后": item["after_json"]}
                   for item in audits]
        archive.writestr("操作记录.csv", batches.safe_csv(records))
    name = f"{_folder(_safe_text(results['task']['name']))}_佐证数据_{datetime.now().strftime('%Y%m%d%H%M%S')}.zip"
    record_audit("佐证数据导出", "批量任务", task_id, {},
                 {"人员数": len(results["people"]), "包含原始材料": include_originals, "导出文件名": name}, operator)
    return buffer.getvalue(), name
