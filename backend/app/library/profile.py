"""人员档案摘要与硬指标核验。

硬指标指可从简历档案核对的事实：学历、专业、工作履历、任职时间，以及岗位的硬性条件。
它和面试中的软性评价分开展示，默认不计入AI面试评分（是否计分、具体规则待人力资源部确认）。
"""
from __future__ import annotations

from pathlib import Path

from matching_core.db import decode_candidate, decode_candidate_job_match, rows
from matching_core.services import talent_library, workflow
from matching_core.services.material_review import material_value
from matching_core.services.scoring import _hard_condition, assessment_summary_data, score_value

PROFILE_FIELDS = (
    ("education", "教育经历"),
    ("work_experience", "工作经历"),
    ("tenure", "任职时间"),
    ("skills", "专业技能"),
    ("projects", "项目经历"),
    ("interview_evaluation", "面试评价与纪要"),
    ("additional_material", "补充资料"),
)
HARD_FIELDS = ("education", "work_experience", "tenure", "skills")


def field_view(parsed: dict, key: str, label: str) -> dict:
    field = (parsed.get("fields") or {}).get(key) or {}
    return {
        "key": key, "label": label, "value": material_value(field.get("value", "")),
        "status": field.get("status") or "待人工确认",
        "source_file": field.get("source_file", ""), "location": field.get("location", ""),
    }


def person_profile(entry: dict) -> dict:
    parsed = entry.get("parsed") or {}
    return {
        "person_id": entry["id"], "batch_id": entry["batch_id"], "name": entry["full_name"],
        "source_filename": entry["source_filename"], "status": entry["status"], "parse_status": entry["parse_status"],
        "confirmed": entry["parse_status"] == "人工已复核", "material_version": entry["material_version"],
        "fields": [field_view(parsed, key, label) for key, label in PROFILE_FIELDS],
    }


def _matching_result(person_id: str, library_job_id: str) -> dict | None:
    """该人员在该岗位上最近一次人岗匹配结果（若做过）。"""
    candidates = rows("SELECT * FROM candidates WHERE source_candidate_id=? ORDER BY updated_at DESC", (person_id,))
    best = None
    for record in candidates:
        candidate = decode_candidate(record)
        if candidate["job_id"] == library_job_id:
            score, task_id = candidate["score"], candidate["task_id"]
        else:
            match = rows("SELECT * FROM candidate_job_matches WHERE candidate_id=? AND job_id=?",
                         (candidate["id"], library_job_id))
            if not match:
                continue
            score, task_id = decode_candidate_job_match(match[0])["score"], candidate["task_id"]
        if score.get("requires_reassessment"):
            continue
        if score_value(score) is None:
            # 分析没有完成的任务不能当作核验结论。
            continue
        best = {"task_id": task_id, "candidate_id": candidate["id"], "score": score}
        break
    return best


def hard_indicators(person_id: str | None, library_job_id: str | None) -> dict:
    """返回硬指标：档案事实 + 岗位硬性条件核验 + 已有的人岗匹配结论。"""
    result = {"available": False, "reason": "", "profile": None, "facts": [], "hard_checks": [],
              "matching": None, "counted_in_score": False,
              "notice": "硬指标依据简历档案核对，供考官综合测评参考；是否计入评分及具体规则待人力资源部确认。"}
    if not person_id:
        result["reason"] = "候选人尚未关联人员库档案"
        return result
    try:
        entry = talent_library.get_entry(person_id)
    except KeyError:
        result["reason"] = "人员库中未找到该人员档案"
        return result
    profile = person_profile(entry)
    result["profile"] = profile
    result["facts"] = [item for item in profile["fields"] if item["key"] in HARD_FIELDS]
    if entry["status"] != "已解析":
        result["reason"] = "简历尚未完成解析"
        return result
    result["available"] = True
    if not library_job_id:
        return result
    try:
        job = workflow.get_job(library_job_id)
    except KeyError:
        return result
    matched = _matching_result(person_id, library_job_id)
    if matched:
        score = matched["score"]
        summary = assessment_summary_data(score, job)
        result["hard_checks"] = [{"condition": item.get("condition", ""), "status": item.get("status", "无法确认"),
                                  "evidence": item.get("evidence", ""), "source": "人岗匹配分析",
                                  "sources": item.get("sources", [])} for item in score.get("hard_checks", [])]
        result["matching"] = {"task_id": matched["task_id"], "candidate_id": matched["candidate_id"],
                              "total": score_value(score), "conclusion": summary["conclusion"],
                              "coverage_percent": summary.get("coverage_percent")}
        return result
    # 没做过人岗匹配时只做关键词初核，明确标注需要人工核实。
    text = ""
    redacted = Path(entry.get("redacted_path") or "")
    if redacted.is_file():
        text = redacted.read_text(encoding="utf-8", errors="ignore")
    for condition in job["hard_conditions"]:
        checked = _hard_condition(condition, text)
        result["hard_checks"].append({"condition": checked["condition"], "status": checked["status"],
                                      "evidence": checked["evidence"], "source": "关键词初核，待人工核实", "sources": []})
    return result
