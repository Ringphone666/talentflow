"""招聘批次。批次关联岗位库中的岗位，并决定本批次是否先做AI面试。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...core.deps import actor_context, audit, require, require_any
from ...library.jobs import ensure_interview_job
from ..models import Batch, Candidate, Job, Question

router = APIRouter(prefix="/api", tags=["AI面试·批次"])

RECRUITMENT_TYPES = ("社会招聘", "校园招聘", "内部竞聘")
BATCH_MODES = {"ai_interview": "AI面试 + 人工面试旁听", "listening_only": "仅人工面试旁听"}


class BatchPayload(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    recruitment_type: str
    # 岗位库中的岗位编号；旧客户端仍可传面试岗位的数字编号 job_id。
    library_job_id: str | None = None
    job_id: int | None = None
    mode: str = Field(default="ai_interview", pattern="^(ai_interview|listening_only)$")


def batch_view(db: Session, batch: Batch) -> dict:
    return {
        "id": batch.id, "code": batch.code, "name": batch.name, "recruitment_type": batch.recruitment_type,
        "job_id": batch.job_id, "job_name": batch.job.name, "library_job_id": batch.job.library_job_id,
        "job_audit_status": batch.job.audit_status,
        "mode": batch.mode or "ai_interview", "mode_label": BATCH_MODES.get(batch.mode or "ai_interview"),
        "status": batch.status, "question_version": batch.question_version, "created_at": batch.created_at,
        "candidate_count": db.scalar(select(func.count(Candidate.id)).where(Candidate.batch_id == batch.id)) or 0,
        "accepts_candidates": batch_accepts_candidates(batch),
    }


def batch_accepts_candidates(batch: Batch) -> bool:
    """仅旁听的批次不需要题目；AI面试批次须先发布题目。"""
    if (batch.mode or "ai_interview") == "listening_only":
        return True
    return batch.status == "active" and bool(batch.question_version)


def resolve_job(db: Session, body: BatchPayload) -> Job:
    if body.library_job_id:
        return ensure_interview_job(db, body.library_job_id)
    job = db.get(Job, body.job_id) if body.job_id else None
    if not job:
        raise HTTPException(404, "岗位不存在，请从岗位库选择岗位")
    return job


@router.get("/batches")
def list_batches(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require_any(ctx, "batch:read", "report:read", "compare:read", "listening:use")
    return [batch_view(db, batch) for batch in db.scalars(select(Batch).order_by(Batch.id.desc())).all()]


@router.post("/batches")
def create_batch(body: BatchPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "batch:create")
    if body.recruitment_type not in RECRUITMENT_TYPES:
        raise HTTPException(422, "请选择社会招聘、校园招聘或内部竞聘")
    if db.scalar(select(Batch).where(Batch.code == body.code.strip())):
        raise HTTPException(409, "批次编号已存在")
    job = resolve_job(db, body)
    listening_only = body.mode == "listening_only"
    batch = Batch(code=body.code.strip(), name=body.name.strip(), recruitment_type=body.recruitment_type, job_id=job.id,
                  mode=body.mode, status="active" if listening_only else "draft", question_version=0)
    db.add(batch)
    db.flush()
    audit(db, ctx, "batch_created", "batch", batch.id, f"新增批次 {batch.code}（{BATCH_MODES[body.mode]}）")
    db.commit()
    db.refresh(batch)
    return batch_view(db, batch)


@router.put("/batches/{batch_id}")
def update_batch(batch_id: int, body: BatchPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "batch:edit")
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "招聘批次不存在")
    if body.recruitment_type not in RECRUITMENT_TYPES:
        raise HTTPException(422, "请选择社会招聘、校园招聘或内部竞聘")
    if db.scalar(select(Batch).where(Batch.code == body.code.strip(), Batch.id != batch_id)):
        raise HTTPException(409, "批次编号已存在")
    job = resolve_job(db, body)
    has_questions = db.scalar(select(Question.id).where(Question.batch_id == batch_id).limit(1))
    has_candidates = db.scalar(select(Candidate.id).where(Candidate.batch_id == batch_id).limit(1))
    if job.id != batch.job_id and has_questions:
        raise HTTPException(409, "批次已有题目版本，不能更换关联岗位")
    if job.id != batch.job_id and has_candidates:
        raise HTTPException(409, "批次已关联候选人，不能更换关联岗位")
    if body.mode != (batch.mode or "ai_interview") and has_candidates:
        raise HTTPException(409, "批次已关联候选人，不能更改面试方式")
    batch.code = body.code.strip()
    batch.name = body.name.strip()
    batch.recruitment_type = body.recruitment_type
    batch.job_id = job.id
    if body.mode != (batch.mode or "ai_interview"):
        batch.mode = body.mode
        if body.mode == "listening_only":
            batch.status = "active"
        elif not batch.question_version:
            batch.status = "draft"
    audit(db, ctx, "batch_updated", "batch", batch.id, f"修改批次 {batch.code}")
    db.commit()
    db.refresh(batch)
    return {"ok": True, **batch_view(db, batch)}


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "batch:delete")
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "招聘批次不存在")
    if db.scalar(select(Question).where(Question.batch_id == batch_id)) or db.scalar(select(Candidate).where(Candidate.batch_id == batch_id)):
        raise HTTPException(409, "批次已关联题目或候选人，不能删除；请先停用或清理关联数据")
    code = batch.code
    db.delete(batch)
    audit(db, ctx, "batch_deleted", "batch", batch_id, f"删除批次 {code}")
    db.commit()
    return {"ok": True}
