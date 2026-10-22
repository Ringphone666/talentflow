"""合规与规则：敏感内容过滤规则、采集告知文本、拦截记录。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...core.deps import actor_context, allowed, audit
from ..standards import filter_sensitive
from ..models import SensitiveBlock
from ..rule_store import consent_notice, save_consent_notice, save_sensitive_rules, sensitive_rules

router = APIRouter(tags=["合规与规则"])


class FilterRequest(BaseModel):
    content: str
    source_type: str = "question"
    interview_id: int | None = None


class SensitiveRulesUpdate(BaseModel):
    rules: dict[str, list[str]]


class ConsentNoticeUpdate(BaseModel):
    version: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=20, max_length=5000)


@router.post("/api/filter/check")
def check_filter(body: FilterRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    allowed, reason = filter_sensitive(body.content)
    if not allowed:
        block = SensitiveBlock(interview_id=body.interview_id, content=body.content, reason=reason, source_type=body.source_type)
        db.add(block)
        db.flush()
        audit(db, ctx, "sensitive_content_blocked", "sensitive_block", block.id, reason)
        db.commit()
    return {"allowed": allowed, "reason": reason, "content": body.content if allowed else ""}


@router.get("/api/sensitive-blocks")
def list_sensitive_blocks(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    if not (allowed(ctx, "config:edit") or allowed(ctx, "question:review")):
        raise HTTPException(403, "无权查看拦截记录")
    return [{"id": b.id, "interview_id": b.interview_id, "content": b.content, "reason": b.reason, "source_type": b.source_type, "created_at": b.created_at} for b in db.scalars(select(SensitiveBlock).order_by(SensitiveBlock.id.desc())).all()]


@router.get("/api/config/sensitive-rules")
def get_sensitive_rules(ctx=Depends(actor_context)):
    if not (allowed(ctx, "config:edit") or allowed(ctx, "question:review")):
        raise HTTPException(403, "无权查看敏感规则")
    return {"rules": sensitive_rules()}


@router.put("/api/config/sensitive-rules")
def update_sensitive_rules(body: SensitiveRulesUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    if not allowed(ctx, "config:edit"):
        raise HTTPException(403, "仅系统管理员或HR管理员可维护敏感规则")
    if not body.rules or any(not key.strip() or not patterns for key, patterns in body.rules.items()):
        raise HTTPException(422, "每条规则必须包含原因和至少一个关键词")
    save_sensitive_rules(body.rules)
    audit(db, ctx, "sensitive_rules_updated", "config", "sensitive-rules", f"更新 {len(body.rules)} 类规则")
    db.commit()
    return {"ok": True, "rules": sensitive_rules()}


@router.get("/api/config/consent-notice")
def get_consent_notice(ctx=Depends(actor_context)):
    if ctx["role"] != "candidate" and not (allowed(ctx, "config:edit") or allowed(ctx, "listening:use")):
        raise HTTPException(403, "无权查看合规告知")
    return consent_notice()


@router.put("/api/config/consent-notice")
def update_consent_notice(body: ConsentNoticeUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    if not allowed(ctx, "config:edit"):
        raise HTTPException(403, "仅系统管理员或HR管理员可维护合规告知")
    save_consent_notice(body.model_dump())
    audit(db, ctx, "consent_notice_updated", "config", "consent-notice", f"发布告知版本 {body.version}")
    db.commit()
    return {"ok": True, **consent_notice()}
