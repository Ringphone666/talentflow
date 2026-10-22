"""审计日志：合并查看平台与AI面试的操作记录，以及人岗匹配核心的处理记录。"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from matching_core.db import rows
from matching_core.services.auth import operator_name, operator_role

from ..core.database import get_db
from ..core.deps import ROLE_LABELS, actor_context, require
from ..interview.models import AuditLog

router = APIRouter(prefix="/api", tags=["审计日志"])

MAX_ROWS = 500
EPOCH = datetime.fromtimestamp(0, timezone.utc)


def as_utc(value) -> datetime:
    """两个库的时间写法不同：面试库按 UTC 保存且不带时区，人岗匹配保存带时区的本地时间。"""
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return EPOCH
        return (parsed if parsed.tzinfo else parsed.astimezone()).astimezone(timezone.utc)
    if not isinstance(value, datetime):
        return EPOCH
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


# 人岗匹配核心保存的是整条数据，字段名换成页面上的叫法；内部字段不显示。
FIELD_LABELS = {
    # 岗位
    "name": "岗位名称", "sequence": "岗位类别", "level": "职级", "jd_version": "说明书版本", "weight_version": "权重版本",
    "scope": "来源", "responsibilities": "岗位职责", "requirements": "任职要求", "hard_conditions": "硬性条件",
    "dimensions": "能力标签", "weights": "权重",
    # 模型调用和评分
    "status": "状态", "reason": "说明", "model": "模型", "embedding": "向量检索", "rerank": "重排",
    "available_evidence_count": "可用证据数", "processed_evidence_count": "已处理证据数", "elapsed_seconds": "耗时（秒）",
    "total": "综合匹配度", "hard_checks": "硬性条件核验", "strengths": "优势", "gaps": "差距", "risks": "风险",
    "mismatch_reasons": "不匹配原因", "pending_count": "待核实项数", "ai_suggestion": "AI建议", "formula": "计算方式",
    "reasoning_analysis": "评分分析", "retrieval_analysis": "证据检索", "diagnostics": "调用情况", "fields_count": "识别字段数",
    "scoring_method": "评分方式", "assessment_status": "分析状态", "score_source": "得分来源",
    "unassessed_dimensions": "未评估维度", "job_weight_version": "权重版本", "assessed_at": "分析时间",
    "coverage_percent": "覆盖权重（%）", "assessed_score": "已评估得分", "score_basis": "得分依据",
    "attempts": "尝试次数", "error_code": "错误代码", "sections": "分析内容", "evidence": "证据",
    # 人员资料
    "education": "教育经历", "work_experience": "工作经历", "projects": "项目经历", "skills": "专业技能",
    "tenure": "任职时间", "interview_evaluation": "面试评价与纪要", "additional_material": "补充资料",
    "source_file": "来源文件", "location": "位置",
}
# 同一个字段名在不同记录里含义不同时，按所在的上一级字段区分。
NESTED_LABELS = {("embedding", "dimensions"): "向量维度"}
HIDDEN_FIELDS = {"id", "updated_at", "is_active", "extra_sections", "created_at"}


def field_label(key: str, parent: str = "") -> str:
    return NESTED_LABELS.get((parent, key)) or FIELD_LABELS.get(key, key)


def readable(value, parent: str = "") -> str:
    if isinstance(value, dict):
        if "label" in value and "value" in value:
            # 人员资料字段：只显示内容和确认状态，没有内容的字段不显示。
            content, status = readable(value["value"]), readable(value.get("status"))
            return content + (f"（{status}）" if content and status else "")
        if "name" in value and len(value) <= 6:
            return str(value["name"])
        parts = ((field_label(key, parent), readable(item, key)) for key, item in value.items() if key not in HIDDEN_FIELDS)
        return "，".join(f"{name} {text}" for name, text in parts if text)
    if isinstance(value, list):
        return "、".join(text for text in (readable(item, parent) for item in value) if text)
    if isinstance(value, bool):
        return "是" if value else "否"
    return "" if value is None else str(value)


def summarize(before: str, after: str) -> str:
    """人岗匹配核心记录的是变更前后的内容，这里压成一段摘要。"""
    try:
        value = json.loads(after or "{}")
    except (TypeError, json.JSONDecodeError):
        return str(after or "")[:400]
    if not isinstance(value, dict) or not value:
        return ""
    parts = ((field_label(key), readable(item, key)) for key, item in value.items() if key not in HIDDEN_FIELDS)
    text = "；".join(f"{name}：{content}" for name, content in parts if content)
    return text if len(text) <= 400 else text[:400] + "…"


def platform_rows(db: Session, action: str | None, keyword: str, limit: int) -> list[dict]:
    query = select(AuditLog).order_by(AuditLog.id.desc())
    if action:
        query = query.where(AuditLog.action == action)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(AuditLog.actor.like(like) | AuditLog.detail.like(like) | AuditLog.target_id.like(like))
    return [{"id": f"p-{item.id}", "source": "platform", "source_label": "平台与AI面试", "actor": item.actor,
             "role": item.role, "role_label": ROLE_LABELS.get(item.role, item.role), "action": item.action,
             "target_type": item.target_type, "target_id": item.target_id, "detail": item.detail,
             "created_at": as_utc(item.created_at)} for item in db.scalars(query.limit(limit)).all()]


def matching_rows(action: str | None, keyword: str, limit: int) -> list[dict]:
    conditions, params = [], []
    if action:
        conditions.append("operation_type=?")
        params.append(action)
    if keyword:
        conditions.append("(operator LIKE ? OR object_id LIKE ? OR after_json LIKE ?)")
        params += [f"%{keyword}%"] * 3
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    records = rows(f"SELECT * FROM audits{where} ORDER BY id DESC LIMIT ?", (*params, limit))
    return [{"id": f"m-{item['id']}", "source": "matching", "source_label": "人岗匹配", "actor": operator_name(item["operator"]),
             "role": operator_role(item["operator"]), "role_label": operator_role(item["operator"]),
             "action": item["operation_type"], "target_type": item["object_type"], "target_id": item["object_id"],
             "detail": summarize(item["before_json"], item["after_json"]), "created_at": as_utc(item["operation_time"])}
            for item in records]


@router.get("/audits")
def list_audits(source: str = Query(default="all", pattern="^(all|platform|matching)$"),
                action: str | None = Query(default=None, max_length=64),
                keyword: str = Query(default="", max_length=64),
                limit: int = Query(default=200, ge=1, le=MAX_ROWS),
                ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "audit:read")
    keyword = keyword.strip()
    records = []
    if source in ("all", "platform"):
        records += platform_rows(db, action, keyword, limit)
    if source in ("all", "matching"):
        records += matching_rows(action, keyword, limit)
    # 人岗匹配的时间只到秒；同一秒内按各自的记录顺序排列。
    records.sort(key=lambda item: (item["created_at"].replace(microsecond=0), int(item["id"].split("-")[1])), reverse=True)
    return records[:limit]
