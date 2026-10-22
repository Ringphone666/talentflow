"""第一阶段面试报告的生成。

候选人提交面试后立即返回，报告在后台生成；生成失败时保留原始回答，工作人员可重新生成。
"""
from __future__ import annotations

import json

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core import background
from ..core.database import SessionLocal
from ..core.deps import audit
from ..core.settings import is_test_runtime
from ..library.profile import hard_indicators
from .common import interview_questions, loads, now
from .interview_context import resume_context
from .models import Answer, Interview, Job, JobMaterial, Report, ReportVersion
from .text_models import build_report

AI_EDITOR = "AI面试智能体"


def job_context(db: Session, job: Job | None) -> dict:
    if not job:
        return {"code": "", "name": "", "duties": "", "requirements": "", "professional_requirements": "",
                "competency_model": [], "material_version": "", "materials_text": ""}
    materials = db.scalars(select(JobMaterial).where(JobMaterial.job_id == job.id, JobMaterial.ocr_status == "completed")).all()
    return {
        "code": job.code, "name": job.name, "duties": job.duties, "requirements": job.requirements,
        "professional_requirements": job.professional_requirements,
        "competency_model": loads(job.competency_model, []), "material_version": job.material_version,
        "materials_text": "\n\n".join(m.ocr_text for m in materials),
    }


def answer_payload(db: Session, interview: Interview, answer_snapshot: list[dict] | None = None) -> list[dict]:
    questions = interview_questions(db, interview)
    answers = {a.question_id: a for a in db.scalars(select(Answer).where(Answer.interview_id == interview.id)).all()}
    if not questions or (answer_snapshot is None and any(q.id not in answers for q in questions)):
        raise HTTPException(409, "仍有主体题未提交或未记录超时")
    payload = []
    for q in questions:
        if answer_snapshot is not None:
            saved = next((item for item in answer_snapshot if item.get("sequence") == q.sequence and item.get("question") == q.content), None)
            if not saved or not saved.get("answer_code") or not isinstance(saved.get("transcript"), str):
                raise HTTPException(409, "历史报告的原始回答不完整，无法重新评分")
            payload.append({**saved, "dimension": q.dimension})
        else:
            a = answers[q.id]
            payload.append({
                "sequence": q.sequence, "dimension": q.dimension, "answer_code": a.answer_code, "question": q.content,
                "transcript": a.transcript, "followup": a.followup_text,
                "followup_answer": a.followup_answer, "timed_out": a.timed_out,
            })
    return payload


def build_interview_report(db: Session, interview: Interview, answer_snapshot: list[dict] | None = None) -> dict:
    job = db.get(Job, interview.job_id)
    content = build_report(interview.candidate.name, answer_payload(db, interview, answer_snapshot),
                           job=job_context(db, job), resume=resume_context(interview.candidate))
    # 硬指标来自人员库档案，与面试中的软性评价分开呈现，不改变六维评分。
    content["hard_indicators"] = hard_indicators(interview.candidate.library_person_id, job.library_job_id if job else None)
    return content


def pending_report(db: Session, interview: Interview) -> Report:
    """登记“报告生成中”。尚无任何版本时当前版本为 0，页面据此显示生成状态。"""
    report = db.scalar(select(Report).where(Report.interview_id == interview.id))
    if not report:
        report = Report(interview_id=interview.id, candidate_id=interview.candidate_id, current_version=0, match_score=0)
        db.add(report)
    report.status = "generating"
    report.generation_error = ""
    db.flush()
    return report


def generate_report(interview_id: int, actor: dict) -> None:
    """生成AI原始报告。独立的数据库会话，既可后台运行也可同步调用。"""
    with SessionLocal() as db:
        interview = db.get(Interview, interview_id)
        report = db.scalar(select(Report).where(Report.interview_id == interview_id)) if interview else None
        if not interview or not report:
            return
        try:
            content = build_interview_report(db, interview)
            next_version = (db.scalar(select(func.max(ReportVersion.version)).where(ReportVersion.report_id == report.id)) or 0) + 1
            db.add(ReportVersion(
                report_id=report.id, version=next_version, version_type="ai_original",
                content=json.dumps(content, ensure_ascii=False), editor=AI_EDITOR, reason="本次面试完成后 AI 原始生成",
            ))
            report.current_version = next_version
            report.status = "pending_review"
            report.generation_error = ""
            report.match_score = content["match_analysis"]["score"]
            audit(db, actor, "ai_report_generated", "report", report.id, f"AI 原始版本 {next_version}")
        except Exception as error:  # noqa: BLE001 - 失败原因要落到报告状态上供工作人员处理
            db.rollback()
            report = db.scalar(select(Report).where(Report.interview_id == interview_id))
            report.status = "generation_failed"
            report.generation_error = background.failure_message(error)[:500]
            audit(db, actor, "ai_report_generation_failed", "report", report.id, report.generation_error)
        db.commit()


def schedule_report(interview_id: int, actor: dict) -> None:
    actor = {"role": actor["role"], "user": actor["user"]}
    if is_test_runtime():
        generate_report(interview_id, actor)
    else:
        background.run_later(lambda: generate_report(interview_id, actor))
