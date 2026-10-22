"""把人岗匹配核心的存储结构整理成页面和接口使用的视图。"""
from __future__ import annotations

import re

from matching_core.services import batches, talent_library
from matching_core.services.auth import operator_name
from matching_core.services.batch_reports import batch_report_readiness
from matching_core.services.material_review import MATERIAL_FIELD_LABELS, material_value
from matching_core.services.scoring import assessment_summary_data, score_sort_key, score_value

MODES = {"岗位找人": "job_to_people", "人找岗位": "people_to_jobs"}
MODE_LABELS = {"job_to_people": "岗位选才", "people_to_jobs": "人才适岗"}
TASK_MODES = {value: key for key, value in MODES.items()}
DECISIONS = ("进入下一轮", "保留", "淘汰")
FIT_DECISIONS = ("推荐至该岗位", "作为备选岗位", "暂不推荐")


def evidence_view(items) -> list[dict]:
    return [{"text": item.get("text", ""), "file": item.get("file", ""), "location": item.get("location", ""),
             "origin": item.get("origin", "")} for item in (items or []) if isinstance(item, dict) and item.get("text")]


def assessment_view(score: dict, job: dict | None) -> dict:
    summary = assessment_summary_data(score, job)
    state = score.get("reasoning_analysis", {}) or {}
    return {
        "total": score_value(score), "coverage_percent": summary.get("coverage_percent"),
        "conclusion": summary["conclusion"], "summary": summary["summary"], "score_note": summary["score_note"],
        "evidence_summary": summary["evidence_summary"], "next_step": summary["next_step"],
        "recommended": summary["recommended"], "analysis_status": batches.analysis_status(score),
        "stale": bool(score.get("requires_reassessment")), "stale_reason": score.get("reassessment_reason", ""),
        "strengths": summary["strengths"], "gaps": summary["gaps"], "risks": summary["risks"],
        "verification": summary["verification"], "questions": summary["questions"],
        "dimensions": [{
            "dimension": item.get("dimension", ""), "weight": item.get("weight"), "score": item.get("score"),
            "weighted": item.get("weighted"), "status": item.get("status") or ("已评估" if item.get("score") is not None else "待核实"),
            "reason": item.get("reason") or "历史规则记录，建议重新分析", "evidence": evidence_view(item.get("evidence")),
        } for item in score.get("dimensions", [])],
        "hard_checks": [{"condition": item.get("condition", ""), "status": item.get("status", "无法确认"),
                         "evidence": item.get("evidence", ""), "sources": evidence_view(item.get("sources"))}
                        for item in score.get("hard_checks", [])],
        "weight_version": score.get("job_weight_version", ""), "assessed_at": score.get("assessed_at", ""),
        "model": {"status": state.get("status", ""), "reason": state.get("reason", ""), "name": state.get("model", "")},
    }


def material_view(candidate: dict) -> dict:
    parsed = candidate.get("parsed") or {}
    fields = parsed.get("fields") or {}
    return {
        "full_name": candidate.get("full_name") or "",
        "source_filename": candidate.get("source_filename", ""),
        "parse_status": candidate.get("parse_status", ""),
        "confirmed": candidate.get("parse_status") == "人工已复核",
        "material_version": int(parsed.get("material_version", 0) or 0),
        "updated_at": parsed.get("material_updated_at", ""), "updated_by": operator_name(parsed.get("material_updated_by", "")),
        "warning": parsed.get("warning", ""),
        "fields": [{"key": key, "label": "面试评价与纪要" if key == "interview_evaluation" else label,
                    "value": material_value((fields.get(key) or {}).get("value", "")),
                    "status": (fields.get(key) or {}).get("status", "待人工确认"),
                    "location": (fields.get(key) or {}).get("location", "")}
                   for key, label in MATERIAL_FIELD_LABELS.items()],
    }


def failure_reason(text: str) -> str:
    """失败原因只显示可读的说明：去掉异常类名，遮住服务器上的文件路径。"""
    reason = re.sub(r"(?:^|(?<=[：；]))\s*[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Timeout)\s*[:：]\s*", "", str(text or ""))
    reason = re.sub(r"(?:[A-Za-z]:[\\/]|/(?:home|usr|var|opt|tmp|data|mnt|srv)/)[^\s，。；;'\"]+", "（文件路径）", reason)
    return reason.strip() or "处理未完成，请重试"


def failure_view(item: dict) -> dict:
    """任务中未完成的人员。来自人员库的人员带人员编号和姓名，页面可以直接指到具体的人。"""
    person_id, name = item.get("source_entry_id") or "", ""
    if person_id:
        try:
            name = talent_library.get_entry(person_id)["full_name"]
        except KeyError:
            pass
    return {"file": item.get("file", ""), "reason": failure_reason(item.get("reason", "")), "stage": item.get("stage", ""),
            "person_id": person_id, "name": name, "candidate_id": item.get("candidate_id") or ""}


def task_view(task: dict, jobs: dict, summary: dict | None = None) -> dict:
    mode = MODES.get(task.get("task_mode", "岗位找人"), "job_to_people")
    job_ids = task.get("job_ids") or [task["job_id"]]
    total = task.get("total_files", 0)
    return {
        "id": task["id"], "name": batches.batch_title(task, jobs), "mode": mode, "mode_label": MODE_LABELS[mode],
        "status": task["status"], "running": task["status"] in ("待处理", "处理中"),
        "jobs": [{"id": job_id, "name": jobs[job_id]["name"] if job_id in jobs else "岗位已删除"} for job_id in job_ids],
        "person_batch_id": task.get("talent_batch_id", ""),
        "total": total, "processed": task.get("processed_count", 0), "succeeded": task.get("success_count", 0),
        "failed": task.get("failure_count", 0),
        "failures": [failure_view(item) for item in task.get("failure_reasons", [])],
        "created_at": task["created_at"], "updated_at": task["updated_at"],
        "review": None if summary is None else {
            "passed": summary["通过"], "rejected": summary["未通过"], "kept": summary["保留"],
            "pending": summary["待审核"], "stale": summary["需重新审核"], "exportable": summary["exportable"],
            "people": summary["total"]},
    }


def person_rows(snapshot: dict) -> list[dict]:
    """任务内的人员列表，按综合匹配度从高到低。"""
    task, jobs, fit = snapshot["task"], snapshot["jobs"], snapshot["task"].get("task_mode") == "人找岗位"
    candidates = {item["id"]: item for item in snapshot["candidates"]}
    by_candidate: dict[str, list[dict]] = {}
    for match in snapshot["matches"]:
        by_candidate.setdefault(match["candidate_id"], []).append(match)
    rows = []
    for record in snapshot["rows"]:
        candidate = candidates.get(record["candidate_id"])
        own = sorted(by_candidate.get(record["candidate_id"], []), key=lambda m: score_sort_key(m["score"]), reverse=True)
        score = (own[0]["score"] if fit and own else candidate["score"]) if candidate else {}
        row = {
            "candidate_id": record["candidate_id"], "code": record["候选人编号"], "name": record["姓名"],
            "source_filename": record["原始文件"], "total": record["综合匹配度"], "conclusion": record["匹配结论"],
            "analysis_status": record["分析状态"], "review_status": record["审核状态"], "decision": record["人工结论"],
            "material_confirmed": record["资料确认"] == "已确认", "reviewed_jobs": record["已审岗位"],
            "review_comment": record["复核意见"], "reviewer": operator_name(record["审核人"]), "reviewed_at": record["审核时间"],
            "report_ready": record["报告状态"] == "可导出", "report_blockers": [] if record["报告状态"] == "可导出"
            else [item for item in record["报告状态"].split("；") if item],
            "note": failure_reason(record["处理说明"]) if record["处理说明"] else "", "person_id": (candidate or {}).get("source_candidate_id") or "",
            "sort_key": list(score_sort_key(score)) if candidate else [False, -1, 0],
        }
        if candidate:
            summary = assessment_summary_data(score, jobs.get(own[0]["job_id"] if fit and own else candidate["job_id"]))
            # 各维度得分用于图表对比；完整的判断依据在人员详情中。
            row["dimensions"] = [{"dimension": item.get("dimension", ""), "score": item.get("score")}
                                 for item in score.get("dimensions", [])]
            row.update(strengths=summary["strengths"][:3], risks=(summary["risks"] + summary["gaps"])[:3],
                       hard_failed=[item["condition"] for item in summary["hard_failed"]],
                       hard_unknown=[item["condition"] for item in summary["hard_unknown"]])
            if fit:
                cells = {}
                for match in own:
                    cells[match["job_id"]] = {"total": score_value(match["score"]), "decision": match.get("decision"),
                                              "analysis_status": batches.analysis_status(match["score"]),
                                              "conclusion": assessment_summary_data(match["score"], jobs.get(match["job_id"]))["conclusion"]}
                row["matrix"] = cells
                preferred = next((m for m in own if assessment_summary_data(m["score"], jobs.get(m["job_id"]))["recommended"]), None)
                row["preferred_job_id"] = preferred["job_id"] if preferred else None
        rows.append(row)
    rows.sort(key=lambda item: tuple(item["sort_key"]), reverse=True)
    for index, row in enumerate(rows, start=1):
        row["rank"] = index if row["total"] is not None else None
        row.pop("sort_key")
    return rows


def readiness(candidate: dict, matches: list[dict], jobs: dict, fit: bool) -> dict:
    ready, blockers = batch_report_readiness(candidate, matches, jobs, fit)
    return {"ready": ready, "blockers": blockers}
