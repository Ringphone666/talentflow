"""现场面试（线下集中面试）的入口。

现场用同一台设备（会议室的智慧屏、投屏的电脑或平板）依次面试多名候选人：工作人员为批次
开启入口，候选人在设备上选择本人后直接进入设备检测和面试，不需要账号密码，也不再填写
个人信息。工作人员开启入口时确认已在现场完成采集告知并取得同意的，合规须知一并跳过；
未确认的，候选人仍需在设备上阅读并同意。

工作人员在管理端点击“现场面试”时，在本机直接打开入口；同一个人在同一批次、同样的告知
方式下重复点击，沿用已开启且尚未到期的入口，不会每次新建一个。
"""
from __future__ import annotations

import uuid
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core import security
from ...core.database import get_db
from ...core.deps import actor_context, audit, require
from .. import listening_intelligence as listening_ai
from ..common import interview_is_preparing, now
from ..models import Batch, Candidate, Interview, OnsiteEntry

router = APIRouter(prefix="/api", tags=["AI面试·线下集中面试"])

CANDIDATE_SESSION_SECONDS = 4 * 60 * 60
# 沿用已开启的入口时，剩余有效时间不足这个数就另开一个，避免面试中途到期。
REUSE_MIN_SECONDS = 60 * 60


class OnsiteEntryCreate(BaseModel):
    consent_attested: bool = False
    hours: int = Field(default=8, ge=1, le=72)
    # 为真时沿用本人已开启、告知方式相同且尚未到期的入口（用于管理端的“现场面试”按钮）。
    reuse: bool = False


class OnsiteStart(BaseModel):
    candidate_id: int


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def entry_view(entry: OnsiteEntry) -> dict:
    expired = aware(entry.expires_at) <= now()
    return {"id": entry.id, "batch_id": entry.batch_id, "created_by": entry.created_by,
            "consent_attested": entry.consent_attested, "notice_version": entry.notice_version,
            "created_at": entry.created_at, "expires_at": entry.expires_at, "revoked_at": entry.revoked_at,
            "active": not expired and entry.revoked_at is None}


@router.get("/batches/{batch_id}/onsite-entries")
def list_onsite_entries(batch_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "onsite:manage")
    rows = db.scalars(select(OnsiteEntry).where(OnsiteEntry.batch_id == batch_id).order_by(OnsiteEntry.id.desc())).all()
    return [entry_view(item) for item in rows]


@router.post("/batches/{batch_id}/onsite-entries")
def create_onsite_entry(batch_id: int, body: OnsiteEntryCreate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "onsite:manage")
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "招聘批次不存在")
    if (batch.mode or "ai_interview") != "ai_interview":
        raise HTTPException(409, "本批次不做AI面试，无需开启现场入口")
    if batch.status != "active" or not batch.question_version:
        raise HTTPException(409, "批次尚未发布题目，不能开启现场入口")
    notice_version, _ = listening_ai.current_notice()
    if body.reuse:
        for opened in db.scalars(select(OnsiteEntry).where(
                OnsiteEntry.batch_id == batch.id, OnsiteEntry.created_by == ctx["user"], OnsiteEntry.revoked_at.is_(None),
                OnsiteEntry.consent_attested == body.consent_attested, OnsiteEntry.notice_version == notice_version,
        ).order_by(OnsiteEntry.id.desc())).all():
            remaining = int((aware(opened.expires_at) - now()).total_seconds())
            if remaining >= REUSE_MIN_SECONDS:
                token, expires = security.issue(f"onsite-entry:{opened.id}", "onsite", source="onsite_entry", ttl=remaining,
                                                entry=opened.token_id, batch_id=batch.id)
                audit(db, ctx, "onsite_entry_reopened", "batch", batch.id, f"在本机打开已开启的现场入口 #{opened.id}")
                db.commit()
                return {**entry_view(opened), "entry_token": token, "token_expires_at": expires, "reused": True}
    entry = OnsiteEntry(batch_id=batch.id, token_id=uuid.uuid4().hex, created_by=ctx["user"],
                        consent_attested=body.consent_attested, notice_version=notice_version,
                        expires_at=now() + timedelta(hours=body.hours))
    db.add(entry)
    db.flush()
    token, expires = security.issue(f"onsite-entry:{entry.id}", "onsite", source="onsite_entry", ttl=body.hours * 3600,
                                    entry=entry.token_id, batch_id=batch.id)
    audit(db, ctx, "onsite_entry_created", "batch", batch.id,
          f"开启线下集中面试入口，有效 {body.hours} 小时；现场已告知并取得同意：{'是' if body.consent_attested else '否'}")
    db.commit()
    # 入口凭证只在创建时返回一次，由工作人员在现场设备上打开。
    return {**entry_view(entry), "entry_token": token, "token_expires_at": expires, "reused": False}


@router.delete("/onsite-entries/{entry_id}")
def revoke_onsite_entry(entry_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "onsite:manage")
    entry = db.get(OnsiteEntry, entry_id)
    if not entry:
        raise HTTPException(404, "现场入口不存在")
    if entry.revoked_at is None:
        entry.revoked_at = now()
        audit(db, ctx, "onsite_entry_revoked", "batch", entry.batch_id, "关闭线下集中面试入口")
        db.commit()
    return entry_view(entry)


def onsite_entry(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> OnsiteEntry:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "请使用工作人员开启的现场入口进入")
    try:
        claims = security.verify(authorization.split(" ", 1)[1].strip())
    except ValueError:
        raise HTTPException(401, "现场入口已过期，请联系工作人员重新开启") from None
    if claims.get("role") != "onsite" or claims.get("source") != "onsite_entry":
        raise HTTPException(401, "现场入口无效")
    entry = db.scalar(select(OnsiteEntry).where(OnsiteEntry.token_id == str(claims.get("entry"))))
    if not entry or entry.revoked_at is not None or aware(entry.expires_at) <= now():
        raise HTTPException(401, "现场入口已关闭或过期，请联系工作人员重新开启")
    return entry


def waiting_status(interview: Interview | None) -> str:
    if not interview:
        return "unavailable"
    if interview.status == "completed":
        return "completed"
    return "waiting" if interview_is_preparing(interview) else "in_progress"


@router.get("/onsite/candidates")
def onsite_candidates(entry: OnsiteEntry = Depends(onsite_entry), db: Session = Depends(get_db)):
    """现场设备上显示的候选人名单，只含姓名、编号和面试状态。"""
    batch = db.get(Batch, entry.batch_id)
    candidates = db.scalars(select(Candidate).where(Candidate.batch_id == entry.batch_id).order_by(Candidate.code)).all()
    people = []
    for candidate in candidates:
        interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
        people.append({"id": candidate.id, "code": candidate.code, "name": candidate.name,
                       "status": waiting_status(interview)})
    return {"batch": {"id": batch.id, "name": batch.name, "job_name": batch.job.name},
            "consent_attested": entry.consent_attested, "expires_at": entry.expires_at, "candidates": people}


@router.post("/onsite/sessions")
def start_onsite_session(body: OnsiteStart, entry: OnsiteEntry = Depends(onsite_entry), db: Session = Depends(get_db)):
    candidate = db.get(Candidate, body.candidate_id)
    if not candidate or candidate.batch_id != entry.batch_id:
        raise HTTPException(404, "本批次中没有该候选人")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
    if not interview:
        raise HTTPException(409, "该候选人没有AI面试记录")
    if interview.status == "completed":
        raise HTTPException(409, "该候选人的面试已提交，不能重新面试")
    actor = {"role": "candidate", "user": candidate.code}
    if interview_is_preparing(interview):
        interview.entry_mode = "onsite"
        notice_version, notice_text = listening_ai.current_notice()
        if entry.consent_attested:
            interview.consented = True
            interview.consent_version = notice_version
            interview.consented_at = now()
            interview.consent_method = "offline_attested"
            interview.consent_recorded_by = entry.created_by
            if interview.status in ("consent_pending", "consent_declined"):
                interview.status = "mic_check"
            audit(db, actor, "candidate_consented", "interview", interview.id,
                  f'{{"version": "{notice_version}", "notice": "线下集中面试：工作人员 {entry.created_by} 确认已在现场告知采集事项并取得同意"}}')
    audit(db, actor, "onsite_session_started", "interview", interview.id, f"通过现场入口 #{entry.id} 进入面试")
    db.commit()
    token, expires = security.issue(candidate.code, "candidate", source="onsite", ttl=CANDIDATE_SESSION_SECONDS,
                                    candidate_id=candidate.id, entry=entry.token_id)
    return {"username": candidate.code, "display_name": candidate.name, "role": "candidate", "role_label": "候选人",
            "permissions": ["interview:use"], "access_token": token, "expires_at": expires,
            "candidate_id": candidate.id, "entry_mode": "onsite"}
