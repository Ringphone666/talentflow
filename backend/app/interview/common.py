"""AI面试各接口共用的小工具和视图函数。"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.database import DATA_DIR
from ..core.settings import is_test_runtime
from ..library.profile import hard_indicators
from . import doubao_asr, text_models
from .models import Batch, Candidate, Interview, Job, Question, Report, ReportVersion, User

TEST_RUNTIME = is_test_runtime()
INTERVIEW_NOTICE = "对比和评价仅供人工参考，不构成自动录用或淘汰决定。"
PROFILE_FIELDS = ("phone", "email", "education", "major", "years")


def now():
    return datetime.now(timezone.utc)


def loads(value: str, fallback: Any):
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def asr_runtime_mode() -> str:
    """按配置的转写方式区分记录的来源；已有的旁听记录按它查找，不受密钥是否在位影响。"""
    if doubao_asr.enabled():
        return "doubao"
    return "mock" if TEST_RUNTIME else "unavailable"


def asr_available_mode() -> str:
    """语音转写现在能不能用：启用了但没有配置密钥时如实报告不可用，页面据此说明原因。"""
    mode = asr_runtime_mode()
    if mode == "doubao" and not text_models.key_configured("doubao"):
        return "unavailable"
    return mode


def require_speech_for_interview():
    """没有可用的语音转写时不让候选人开始：录音转不成文字，面试结果无从评价。"""
    if asr_available_mode() == "unavailable":
        raise HTTPException(503, "语音转写服务尚未配置，暂时不能进行AI面试，请联系工作人员")


def recording_manifest(value: str):
    manifest = loads(value, None)
    if isinstance(manifest, dict):
        return manifest
    return {"main": value} if value else {}


def save_recording_file(data_url: str, filename: str):
    try:
        encoded = data_url.split(",", 1)[-1]
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise HTTPException(422, "录音数据格式无效") from exc
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(413, "单段录音不能超过 12MB")
    recordings = DATA_DIR / "recordings"
    recordings.mkdir(parents=True, exist_ok=True)
    path = recordings / filename
    path.write_bytes(data)
    return str(path.relative_to(DATA_DIR)), len(data)


def candidate_user(db: Session, ctx: dict) -> User | None:
    return db.scalar(select(User).where(User.username == ctx.get("user"), User.role == "candidate"))


def candidate_id_of(db: Session, ctx: dict) -> int | None:
    """当前候选人会话对应的候选人。现场入口的会话直接携带候选人编号，账号登录则按账号查找。"""
    claimed = (ctx.get("claims") or {}).get("candidate_id")
    if claimed:
        return int(claimed)
    user = candidate_user(db, ctx)
    return user.candidate_id if user else None


def require_interview_owner(db: Session, ctx: dict, interview: Interview):
    """候选人只能操作自己的面试记录。"""
    if ctx.get("role") != "candidate":
        return
    if candidate_id_of(db, ctx) != interview.candidate_id:
        raise HTTPException(403, "候选账号不能操作其他候选人的面试记录")


def get_candidate_interview(db: Session, ctx: dict | None = None):
    if ctx and ctx.get("role") == "candidate":
        candidate_id = candidate_id_of(db, ctx)
        if not candidate_id:
            raise HTTPException(404, "该候选账号尚未绑定面试记录")
        return db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    if TEST_RUNTIME:
        candidate = db.scalar(select(Candidate).where(Candidate.code == "CAND-2026-001"))
        return db.scalar(select(Interview).where(Interview.candidate_id == candidate.id)) if candidate else None
    return None


def profile_complete(profile: dict):
    return all(str(profile.get(field, "")).strip() for field in PROFILE_FIELDS)


def profile_required(interview: Interview) -> bool:
    """线下集中面试跳过个人信息填报，由工作人员在后台维护候选人资料。"""
    return interview.entry_mode != "onsite"


def interview_is_preparing(interview: Interview):
    return (
        interview.status in {"consent_pending", "consent_declined", "mic_check", "ready"}
        and interview.started_at is None and interview.completed_at is None
    )


def require_interview_preparing(interview: Interview):
    if interview.status == "completed" or interview.completed_at is not None:
        raise HTTPException(409, "本次面试已提交，不能重新面试或修改作答")
    if not interview_is_preparing(interview):
        raise HTTPException(409, "面试已开始，不能返回准备步骤或重新开始")


def question_dict(q: Question):
    return {
        "id": q.id, "batch_id": q.batch_id, "job_id": q.job_id, "sequence": q.sequence,
        "dimension": q.dimension, "content": q.content, "time_limit": q.time_limit,
        "version": q.version, "status": q.status, "review_comment": q.review_comment,
        "change_log": loads(q.change_log, []), "updated_at": q.updated_at,
    }


def interview_questions(db: Session, interview: Interview) -> list[Question]:
    return db.scalars(select(Question).where(
        Question.batch_id == interview.batch_id, Question.job_id == interview.job_id,
        Question.version == interview.question_version,
    ).order_by(Question.sequence)).all()


def report_payload(db: Session, report: Report):
    candidate = db.get(Candidate, report.candidate_id)
    job = db.get(Job, candidate.job_id)
    batch = db.get(Batch, candidate.batch_id)
    versions = db.scalars(select(ReportVersion).where(ReportVersion.report_id == report.id).order_by(ReportVersion.version)).all()
    current = next((v for v in versions if v.version == report.current_version), versions[-1] if versions else None)
    content = loads(current.content, {}) if current else {}
    if content and "hard_indicators" not in content:
        # 旧报告生成时还没有硬指标，查看时按候选人当前的档案补上，不改动已保存的版本。
        content["hard_indicators"] = hard_indicators(candidate.library_person_id, job.library_job_id if job else None)
    return {
        "id": report.id,
        "candidate": {"id": candidate.id, "code": candidate.code, "name": candidate.name,
                      "library_person_id": candidate.library_person_id},
        "job": {"id": job.id, "code": job.code, "name": job.name, "library_job_id": job.library_job_id} if job else None,
        "batch": {"id": batch.id, "code": batch.code, "name": batch.name} if batch else None,
        "status": report.status,
        "generation_error": report.generation_error,
        "current_version": report.current_version,
        "match_score": report.match_score,
        "current_content": content,
        "versions": [{
            "version": v.version, "version_type": v.version_type, "editor": v.editor,
            "reason": v.reason, "created_at": v.created_at, "content": loads(v.content, {}),
        } for v in versions],
        "updated_at": report.updated_at,
    }
