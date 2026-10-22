"""工作台：两个业务模块的待办和数量汇总，以及外部服务的配置状态。"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from matching_core.services import batches as matching_batches
from matching_core.services import talent_library, workflow
from matching_core.services.model_adapter import model_settings

from ..core.database import get_db
from ..core.deps import ROLE_LABELS, actor_context, allowed, require
from ..interview.standards import DISCLAIMER
from ..interview.models import Batch, Candidate, Interview, Question, Report
from ..interview.text_models import status as interview_model_status

router = APIRouter(prefix="/api", tags=["工作台"])

# 工作台只汇总最近的任务，避免任务很多时拖慢首页。
RECENT_TASKS = 40
STATUS_CACHE_SECONDS = 30
_status_cache: dict = {}


def matching_model_status() -> dict:
    """人岗匹配评分所需的外部模型是否已配置；只说明缺什么，不返回地址和密钥。"""
    settings = model_settings()
    missing = []
    if settings["provider"] != "external":
        missing.append("未启用外部模型（MODEL_PROVIDER=external）")
    if not settings["key"] or "replace_" in settings["key"]:
        missing.append("未配置模型密钥")
    if not settings["url"]:
        missing.append("未配置模型服务地址")
    elif settings["url"].lower().startswith("http://") and not settings["http_allowed"]:
        missing.append("模型服务地址是 http，需设置 TALENTFLOW_MATCH_ALLOW_HTTP=true")
    if not settings["confirmed"]:
        missing.append("未确认密钥可用（TALENTFLOW_MATCH_KEY_ROTATED_CONFIRMED=true）")
    return {"mode": "unavailable" if missing else "live", "scoring_model": settings["reasoning_model"],
            "extraction_model": settings["model"],
            "note": "人岗匹配评分不可用：" + "；".join(missing) + "。仍可导入和查看资料。" if missing else ""}


def service_status() -> dict:
    """外部服务的配置状态。发言人区分等本地服务需要逐个探测，结果缓存片刻，避免每次打开工作台都等待。"""
    now = time.monotonic()
    if not _status_cache or now - _status_cache["at"] > STATUS_CACHE_SECONDS:
        _status_cache.update(at=now, text_models=interview_model_status(), matching_models=matching_model_status())
    return {"text_models": _status_cache["text_models"], "matching_models": _status_cache["matching_models"]}


@router.get("/health")
def health():
    return {"status": "ok", "message": DISCLAIMER, **service_status()}


def count(db: Session, column, *conditions) -> int:
    return db.scalar(select(func.count(column)).where(*conditions)) or 0


def library_summary() -> dict:
    person_batches = talent_library.list_batches()
    return {"jobs": len(workflow.get_jobs()), "person_batches": len(person_batches),
            "persons": sum(item.get("total_count") or 0 for item in person_batches),
            "persons_failed": sum(item.get("failed_count") or 0 for item in person_batches)}


def matching_summary() -> dict:
    tasks = workflow.get_tasks()
    running = [task for task in tasks if task["status"] in ("待处理", "处理中")]
    pending = stale = 0
    for task in tasks[:RECENT_TASKS]:
        if task["status"] == "待处理":
            continue
        summary = matching_batches.batch_snapshot(task["id"])["summary"]
        pending += summary["待审核"]
        stale += summary["需重新审核"]
    return {"tasks": len(tasks), "running": len(running),
            "with_failures": sum(1 for task in tasks if task.get("failure_count")),
            "pending_review": pending, "stale": stale}


def interview_summary(db: Session) -> dict:
    return {
        "batches": count(db, Batch.id), "candidates": count(db, Candidate.id),
        "interviewing": count(db, Interview.id, Interview.status == "in_progress"),
        "completed": count(db, Interview.id, Interview.status == "completed"),
        "questions_pending_review": db.scalar(select(func.count(func.distinct(Question.batch_id))).where(
            Question.status == "pending_review")) or 0,
        "reports_generating": count(db, Report.id, Report.status == "generating"),
        "reports_failed": count(db, Report.id, Report.status == "generation_failed"),
        "reports_pending": count(db, Report.id, Report.status.in_(("pending_review", "returned"))),
        "reports_confirmed": count(db, Report.id, Report.status == "confirmed"),
    }


def todo_items(ctx: dict, data: dict) -> list[dict]:
    """当前角色需要处理的事项，数量为 0 的不显示。"""
    items = []

    def add(permission: str, value: int, title: str, path: str):
        if value and allowed(ctx, permission):
            items.append({"title": title, "count": value, "path": path})

    interview, matching, library = data.get("interview", {}), data.get("matching", {}), data.get("library", {})
    add("question:review", interview.get("questions_pending_review", 0), "批次题目待审核", "/ai-interview/batches")
    add("report:edit", interview.get("reports_failed", 0), "面试报告生成失败，需重新生成", "/ai-interview/reports")
    add("report:confirm", interview.get("reports_pending", 0), "面试报告待人工复核", "/ai-interview/reports")
    add("matching:review", matching.get("pending_review", 0), "匹配结果待人工复核", "/matching/job-to-people")
    add("matching:review", matching.get("stale", 0), "资料或岗位标准已变更，需重新分析", "/matching/job-to-people")
    add("matching:create", matching.get("with_failures", 0), "匹配任务有未完成的人员", "/matching/job-to-people")
    add("person:edit", library.get("persons_failed", 0), "人员简历解析未完成", "/library/persons")
    return items


@router.get("/overview")
def overview(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "dashboard")
    data: dict = {"role": ctx["role"], "role_label": ROLE_LABELS[ctx["role"]]}
    if allowed(ctx, "job:read"):
        data["library"] = library_summary()
    if allowed(ctx, "matching:view"):
        data["matching"] = matching_summary()
    if allowed(ctx, "report:read") or allowed(ctx, "batch:read"):
        data["interview"] = interview_summary(db)
    data["todo"] = todo_items(ctx, data)
    return data
