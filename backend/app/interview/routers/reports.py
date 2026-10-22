"""面试报告：第一阶段报告的复核与导出、候选人对比、两阶段综合报告。"""
from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from matching_core.services import talent_library

from ...core.database import get_db
from ...core.deps import actor_context, audit, matching_operator, require
from ...core.settings import comparison_default_limit
from ...library.profile import hard_indicators
from .. import report_builder
from ..common import INTERVIEW_NOTICE, interview_is_preparing, loads, now, report_payload
from ..docx_export import comparison_docx, report_docx
from ..standards import DISCLAIMER
from ..models import Answer, Batch, Candidate, Interview, Job, ListeningSession, Report, ReportVersion

router = APIRouter(prefix="/api", tags=["AI面试·报告"])
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
READY_STATUSES = ("pending_review", "returned", "confirmed")


class ReportEditRequest(BaseModel):
    content: dict
    reason: str = Field(min_length=2)


class ReasonRequest(BaseModel):
    reason: str = Field(min_length=2)


class ReportRegenerateRequest(BaseModel):
    expected_version: int = Field(ge=1)


def get_report_or_404(db: Session, report_id: int) -> Report:
    report = db.get(Report, report_id)
    if not report:
        raise HTTPException(404, "报告不存在")
    return report


def require_ready(report: Report):
    if report.status == "generating":
        raise HTTPException(409, "报告正在生成，请稍后刷新")
    if report.status == "generation_failed" or not report.current_version:
        raise HTTPException(409, "报告尚未生成成功，请先重新生成")


def docx_response(content: bytes, filename: str) -> Response:
    return Response(content=content, media_type=DOCX, headers={
        "Content-Disposition": f'attachment; filename="{filename}"', "X-Download-Name": quote(filename)})


@router.get("/reports")
def list_reports(job_id: int | None = Query(default=None, ge=1), batch_id: int | None = Query(default=None, ge=1),
                 ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:read")
    query = (select(Report).join(Candidate, Report.candidate_id == Candidate.id)
             .join(Interview, Report.interview_id == Interview.id)
             .where(Interview.status == "completed").order_by(Report.updated_at.desc()))
    if job_id is not None:
        query = query.where(Candidate.job_id == job_id)
    if batch_id is not None:
        query = query.where(Candidate.batch_id == batch_id)
    return [report_payload(db, r) for r in db.scalars(query).all()]


@router.get("/reports/{report_id}")
def get_report(report_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:read")
    return report_payload(db, get_report_or_404(db, report_id))


@router.put("/reports/{report_id}")
def edit_report(report_id: int, body: ReportEditRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:edit")
    report = get_report_or_404(db, report_id)
    require_ready(report)
    next_version = (db.scalar(select(func.max(ReportVersion.version)).where(ReportVersion.report_id == report.id)) or 0) + 1
    content = dict(body.content)
    content["disclaimer"] = DISCLAIMER
    content["decision"] = None
    db.add(ReportVersion(report_id=report.id, version=next_version, version_type="human_modified",
                         content=json.dumps(content, ensure_ascii=False), editor=ctx["user"], reason=body.reason))
    report.current_version = next_version
    report.status = "pending_review"
    report.match_score = float(content.get("match_analysis", {}).get("score", report.match_score))
    audit(db, ctx, "human_report_modified", "report", report.id, f"版本 {next_version}；原因：{body.reason}")
    db.commit()
    return report_payload(db, report)


@router.post("/reports/{report_id}/retry-generation")
def retry_generation(report_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """报告生成失败后重新生成；候选人的原始回答不受影响。"""
    require(ctx, "report:edit")
    report = get_report_or_404(db, report_id)
    if report.status != "generation_failed":
        raise HTTPException(409, "只有生成失败的报告需要重新生成")
    interview = db.get(Interview, report.interview_id)
    if not interview or interview.status != "completed":
        raise HTTPException(409, "面试尚未提交，不能生成报告")
    report_builder.pending_report(db, interview)
    audit(db, ctx, "ai_report_generation_retried", "report", report.id, "重新生成AI面试报告")
    db.commit()
    report_builder.schedule_report(interview.id, ctx)
    db.refresh(report)
    return report_payload(db, report)


@router.post("/reports/{report_id}/regenerate")
def regenerate_report(report_id: int, body: ReportRegenerateRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:edit")
    report = get_report_or_404(db, report_id)
    require_ready(report)
    if report.current_version != body.expected_version:
        raise HTTPException(409, "报告版本已更新，请刷新后重试")
    interview = db.get(Interview, report.interview_id)
    if not interview:
        raise HTTPException(404, "面试记录不存在")
    original = db.scalar(select(ReportVersion).where(
        ReportVersion.report_id == report_id, ReportVersion.version_type == "ai_original").order_by(ReportVersion.version))
    has_answers = db.scalar(select(Answer.id).where(Answer.interview_id == interview.id).limit(1))
    # 旧版的“重置面试”可能在报告保存后删除了回答；此时只从不可变的AI原始版本恢复问答。
    snapshot = loads(original.content, {}).get("qa_records") if original and not has_answers else None
    legacy_reset = bool(snapshot and interview_is_preparing(interview))
    if interview.status != "completed" and not legacy_reset:
        raise HTTPException(409, "仅已完成的面试可重新评分")
    original_status = report.status
    next_version = body.expected_version + 1
    content = report_builder.build_interview_report(db, interview, answer_snapshot=snapshot)
    if snapshot:
        content["answer_source"] = {"type": "original_report_snapshot", "version": original.version}
    # 生成期间其他复核人可能已修改或确认报告。
    changed = db.execute(update(Report).where(
        Report.id == report_id, Report.current_version == body.expected_version, Report.status == original_status,
    ).values(current_version=next_version, status="pending_review", match_score=content["match_analysis"]["score"]))
    if changed.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "报告在评分期间已被更新，本次结果未保存，请刷新后重试")
    db.add(ReportVersion(
        report_id=report_id, version=next_version, version_type="ai_regenerated",
        content=json.dumps(content, ensure_ascii=False), editor=ctx["user"],
        reason="依据已保存的原始回答及当前岗位资料重新AI评分；保留历史版本，重新进入人工复核",
    ))
    if legacy_reset:
        interview.status = "completed"
        interview.completed_at = original.created_at
        interview.current_question = len(content["qa_records"]) + 1
        audit(db, ctx, "legacy_interview_completion_restored", "interview", interview.id,
              f"旧重置操作已删除回答；依据AI原始报告版本 {original.version} 的问答快照恢复已完成状态")
    audit(db, ctx, "ai_report_regenerated", "report", report_id, f"原版本 {body.expected_version}；新版本 {next_version}；未改变面试回答")
    db.commit()
    return report_payload(db, db.get(Report, report_id))


@router.post("/reports/{report_id}/return")
def return_report(report_id: int, body: ReasonRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:return")
    report = get_report_or_404(db, report_id)
    require_ready(report)
    report.status = "returned"
    audit(db, ctx, "report_returned", "report", report.id, body.reason)
    db.commit()
    return {"ok": True, "status": report.status}


def interview_conclusion(db: Session, candidate: Candidate) -> str:
    """候选人已经人工确认的面试结论：第一阶段AI面试报告和人工面试综合报告，未确认的不写入。"""
    batch = db.get(Batch, candidate.batch_id)
    job = db.get(Job, candidate.job_id)
    scope = f"{batch.name if batch else ''} · {job.name if job else ''}"
    lines = []
    report = db.scalar(select(Report).where(Report.candidate_id == candidate.id).order_by(Report.id.desc()))
    if report and report.status == "confirmed":
        content = report_payload(db, report)["current_content"]
        lines += [f"AI面试（{scope}）人工确认版本 v{report.current_version}，辅助匹配度 {report.match_score:g}%。",
                  "面试纪要：" + str(content.get("summary", "")).strip()]
        for item in content.get("evaluations", []):
            score = "证据不足" if item.get("score") is None else f"{item['score']}/5"
            lines.append(f"{item.get('dimension')}：{score}。{item.get('reason', '')}")
    session = latest_listening(db, candidate.id)
    if session and session.comprehensive_report and session.comprehensive_status == "confirmed":
        payload = listening_report_payload(session)
        content = payload["current_content"]
        lines += [f"人工面试综合报告（{scope}）人工确认版本 v{payload['current_version']}。",
                  str(content.get("stage_two_summary", "")).strip()]
        for item in content.get("findings", []):
            lines.append(f"{item.get('dimension')}：{item.get('status')}。{item.get('analysis', '')}")
    return "\n".join(line for line in lines if line.strip())


def sync_to_person_library(db: Session, ctx: dict, candidate: Candidate | None) -> str:
    """人工确认后的面试结论写入人员库，作为人岗匹配的输入材料。返回同步说明。"""
    if not candidate or not candidate.library_person_id:
        return "候选人未关联人员库，面试结论未同步"
    try:
        entry = talent_library.get_entry(candidate.library_person_id)
        talent_library.update_entry_material(
            candidate.library_person_id, {"interview_evaluation": interview_conclusion(db, candidate)[:6000]},
            matching_operator(ctx), confirmed=False, expected_material_version=entry["material_version"])
    except (KeyError, ValueError, PermissionError, HTTPException) as error:
        detail = error.detail if isinstance(error, HTTPException) else (error.args[0] if error.args else "")
        return f"面试结论未同步到人员库：{detail}"
    return "面试结论已同步到人员库，可作为人岗匹配的输入材料"


@router.post("/reports/{report_id}/confirm")
def confirm_report(report_id: int, body: ReasonRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:confirm")
    report = get_report_or_404(db, report_id)
    require_ready(report)
    report.status = "confirmed"
    audit(db, ctx, "human_report_confirmed", "report", report.id, body.reason)
    db.commit()
    note = sync_to_person_library(db, ctx, db.get(Candidate, report.candidate_id))
    audit(db, ctx, "interview_result_synced", "report", report.id, note)
    db.commit()
    return {"ok": True, "status": report.status, "library_sync": note}


@router.get("/reports/{report_id}/export")
def export_report(report_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:export")
    report = get_report_or_404(db, report_id)
    if report.status != "confirmed":
        raise HTTPException(409, "未经人工确认的报告不得导出")
    payload = report_payload(db, report)
    audit(db, ctx, "report_exported", "report", report.id, f"导出确认版本 {report.current_version}")
    db.commit()
    metadata = {
        "candidate_name": payload["candidate"]["name"], "candidate_code": payload["candidate"]["code"],
        "job_name": payload["job"]["name"] if payload.get("job") else "—",
        "batch_name": payload["batch"]["name"] if payload.get("batch") else "—",
        "version": payload["current_version"],
    }
    return docx_response(report_docx("TalentFlowAI面试报告", payload["current_content"], metadata),
                         f"confirmed-report-{report.id}-v{report.current_version}.docx")


@router.get("/matching/interview-results/{candidate_id}")
def matching_output(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """AI面试结果的结构化输出，只使用人工确认后的报告。"""
    require(ctx, "report:read")
    report = db.scalar(select(Report).where(Report.candidate_id == candidate_id).order_by(Report.id.desc()))
    candidate = db.get(Candidate, candidate_id)
    if not report or not candidate:
        raise HTTPException(404, "候选人报告不存在")
    if report.status != "confirmed":
        raise HTTPException(409, "人岗匹配输出必须使用人工确认后的报告")
    job = db.get(Job, candidate.job_id)
    content = report_payload(db, report)["current_content"]
    return {
        "candidate_code": candidate.code, "library_person_id": candidate.library_person_id,
        "job_code": job.code if job else None, "library_job_id": job.library_job_id if job else None,
        "report_id": report.id, "report_version": report.current_version, "review_status": report.status,
        "match_score": content.get("match_analysis", {}).get("score"),
        "dimensions": [{"name": item.get("dimension"), "score": item.get("score"),
                        "evidence_answer_ids": item.get("answer_ids", [])} for item in content.get("evaluations", [])],
        "risk_flags": content.get("risks", []), "decision": None,
        "notice": "仅供人工初筛参考，不构成自动录用或淘汰决定。",
    }


# ---- 候选人对比 ------------------------------------------------------------------

def listening_report_payload(session: ListeningSession):
    content = loads(session.comprehensive_report, {}) if session.comprehensive_report else {}
    versions = loads(session.comprehensive_versions, [])
    if content and not versions:
        versions = [{"version": session.comprehensive_version or 1, "version_type": "ai_original",
                     "editor": report_builder.AI_EDITOR, "reason": "AI原始生成",
                     "created_at": session.updated_at, "content": content}]
    current_version = session.comprehensive_version or (versions[-1]["version"] if versions else 0)
    current = next((item for item in versions if item.get("version") == current_version), None)
    # 后台生成中、或没有生成出来时还没有报告内容，状态仍然如实返回。
    known = content or session.comprehensive_status in ("generating", "generation_failed")
    return {
        "session_id": session.id, "candidate_id": session.candidate_id,
        "status": session.comprehensive_status if known else "not_generated",
        "generation_error": session.comprehensive_error or "",
        "current_version": current_version,
        "current_content": current.get("content", content) if current else content,
        "versions": versions,
    }


def latest_listening(db: Session, candidate_id: int) -> ListeningSession | None:
    return db.scalar(select(ListeningSession).where(ListeningSession.candidate_id == candidate_id)
                     .order_by(ListeningSession.updated_at.desc(), ListeningSession.id.desc()))


def comparison_items(db: Session, job_id: int | None, batch_id: int | None, selected_ids: set[int] | None) -> list[dict]:
    query = select(Candidate).order_by(Candidate.id)
    if job_id is not None:
        query = query.where(Candidate.job_id == job_id)
    if batch_id is not None:
        query = query.where(Candidate.batch_id == batch_id)
    if selected_ids is not None:
        query = query.where(Candidate.id.in_(selected_ids))
    items = []
    for candidate in db.scalars(query).all():
        report = db.scalar(select(Report).where(Report.candidate_id == candidate.id).order_by(Report.id.desc()))
        has_report = bool(report and report.current_version and report.status in READY_STATUSES)
        session = latest_listening(db, candidate.id)
        comprehensive = listening_report_payload(session) if session and session.comprehensive_report else None
        if not has_report and not comprehensive:
            continue
        content = report_payload(db, report)["current_content"] if has_report else {}
        job = db.get(Job, candidate.job_id)
        stage_two = comprehensive["current_content"] if comprehensive else {}
        items.append({
            "report_id": report.id if has_report else None,
            "candidate": {"id": candidate.id, "code": candidate.code, "name": candidate.name,
                          "library_person_id": candidate.library_person_id},
            "batch_id": candidate.batch_id,
            "status": report.status if has_report else "not_generated",
            "match_score": report.match_score if has_report else None,
            "scores": {e["dimension"]: e["score"] for e in content.get("evaluations", [])},
            "risks": content.get("risks", []),
            "hard_indicators": hard_indicators(candidate.library_person_id, job.library_job_id if job else None),
            "stage_two": None if not comprehensive else {
                "status": comprehensive["status"], "evidence_count": len(stage_two.get("stage_two_evidence") or []),
                "findings": [{"dimension": f.get("dimension"), "status": f.get("status")} for f in stage_two.get("findings") or []],
            },
        })
    return items


def default_selection(items: list[dict]) -> list[int]:
    """默认选中该批次全部候选人；配置了上限时取匹配度最高的若干人。"""
    limit = comparison_default_limit()
    ranked = sorted(items, key=lambda item: (item["match_score"] is not None, item["match_score"] or 0), reverse=True)
    chosen = ranked[:limit] if limit else ranked
    return [item["candidate"]["id"] for item in chosen]


def parse_ids(candidate_ids: str | None) -> set[int] | None:
    if not candidate_ids:
        return None
    try:
        selected = {int(value) for value in candidate_ids.split(",") if value.strip()}
    except ValueError as exc:
        raise HTTPException(422, "候选人编号格式不正确") from exc
    if not selected:
        raise HTTPException(422, "请至少选择一名候选人")
    return selected


@router.get("/comparison")
def comparison(job_id: int | None = Query(default=None), batch_id: int | None = Query(default=None),
               candidate_ids: str | None = Query(default=None), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "compare:read")
    items = comparison_items(db, job_id, batch_id, parse_ids(candidate_ids))
    return {"job_id": job_id, "batch_id": batch_id,
            "notice": "对比结果仅供人工初筛参考，不构成自动录用或淘汰决定。",
            "default_selected": default_selection(items), "default_limit": comparison_default_limit(), "items": items,
            "without_report": candidates_without_report(db, job_id, batch_id, {item["candidate"]["id"] for item in items})}


def candidates_without_report(db: Session, job_id: int | None, batch_id: int | None, compared: set[int]) -> list[dict]:
    """同一范围内还没有任何报告、因此无法参与对比的候选人。"""
    query = select(Candidate).order_by(Candidate.code)
    if job_id is not None:
        query = query.where(Candidate.job_id == job_id)
    if batch_id is not None:
        query = query.where(Candidate.batch_id == batch_id)
    people = []
    for candidate in db.scalars(query).all():
        if candidate.id in compared:
            continue
        interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
        report = db.scalar(select(Report).where(Report.candidate_id == candidate.id).order_by(Report.id.desc()))
        people.append({"id": candidate.id, "code": candidate.code, "name": candidate.name,
                       "interview_status": interview.status if interview else "not_required",
                       "report_status": report.status if report else "not_generated"})
    return people


@router.get("/comparison/export")
def export_comparison(job_id: int | None = Query(default=None), batch_id: int | None = Query(default=None),
                      candidate_ids: str | None = Query(default=None), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "compare:read")
    batch = db.get(Batch, batch_id) if batch_id else None
    job = db.get(Job, batch.job_id if batch else job_id) if (batch or job_id) else None
    if not job:
        raise HTTPException(404, "请先选择批次")
    items = comparison_items(db, None if batch else job.id, batch.id if batch else None, parse_ids(candidate_ids))
    # 只导出经人工确认的内容：AI面试报告已确认，或（没有做AI面试的）综合报告已确认。
    export_items = [item for item in items if item["status"] == "confirmed"
                    or (item["report_id"] is None and (item["stage_two"] or {}).get("status") == "confirmed")]
    if not export_items:
        raise HTTPException(409, "所选候选人暂无人工确认的报告，不能导出候选人对比结果")
    audit(db, ctx, "comparison_exported", "job", job.id, f"导出 {len(export_items)} 名已人工确认候选人")
    db.commit()
    title = f"{job.name}" + (f" · {batch.name}" if batch else "")
    return docx_response(comparison_docx(title, export_items), f"candidate-comparison-{job.code}.docx")


# ---- 两阶段综合报告 ----------------------------------------------------------------

def comprehensive_session(db: Session, candidate_id: int) -> ListeningSession:
    session = db.scalar(select(ListeningSession).where(ListeningSession.candidate_id == candidate_id)
                        .order_by(ListeningSession.id.desc()))
    if not session or not session.comprehensive_report:
        raise HTTPException(404, "综合报告不存在")
    return session


def settled_session(db: Session, candidate_id: int) -> ListeningSession:
    """可以复核的综合报告：正在重新生成时先不处理，避免复核的是即将被替换的版本。"""
    session = comprehensive_session(db, candidate_id)
    if session.comprehensive_status == "generating":
        raise HTTPException(409, "综合报告正在重新生成，请等待完成后再处理")
    return session


@router.get("/comprehensive-reports")
def list_comprehensive_reports(job_id: int | None = Query(default=None), batch_id: int | None = Query(default=None),
                               ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """每名候选人最新的一份综合报告。"""
    require(ctx, "report:read")
    query = select(ListeningSession).join(Candidate, Candidate.id == ListeningSession.candidate_id)
    if job_id is not None:
        query = query.where(Candidate.job_id == job_id)
    if batch_id is not None:
        query = query.where(Candidate.batch_id == batch_id)
    sessions = db.scalars(query.order_by(ListeningSession.updated_at.desc(), ListeningSession.id.desc())).all()
    items = []
    seen: set[int] = set()
    for session in sessions:
        if session.candidate_id in seen or not session.comprehensive_report:
            continue
        seen.add(session.candidate_id)
        candidate = db.get(Candidate, session.candidate_id)
        if not candidate:
            continue
        job = db.get(Job, candidate.job_id)
        batch = db.get(Batch, candidate.batch_id)
        payload = listening_report_payload(session)
        content = payload["current_content"]
        stage = content.get("stage_one") if isinstance(content.get("stage_one"), dict) else {}
        stage_content = stage.get("content", {}) if isinstance(stage, dict) else {}
        evaluations = content.get("stage_one_evaluations") or stage_content.get("evaluations") or []
        match = content.get("stage_one_match_analysis") or stage_content.get("match_analysis") or {}
        risks = []
        for risk in [*(content.get("stage_one_risks") or stage_content.get("risks") or []), *(content.get("risks") or [])]:
            if risk not in risks:
                risks.append(risk)
        items.append({
            "session_id": session.id, "mode": content.get("mode") or ("linked" if stage.get("report_id") else "standalone"),
            "candidate": {"id": candidate.id, "code": candidate.code, "name": candidate.name,
                          "library_person_id": candidate.library_person_id},
            "job": {"id": job.id, "code": job.code, "name": job.name} if job else None,
            "batch": {"id": batch.id, "code": batch.code, "name": batch.name} if batch else None,
            "status": payload["status"], "current_version": payload["current_version"],
            "stage_one": {
                "report_id": stage.get("report_id"), "version": stage.get("version"),
                "summary": content.get("stage_one_summary") or stage_content.get("summary") or "",
                "scores": {item.get("dimension", "未分类维度"): item.get("score") for item in evaluations},
                "match_score": match.get("score"),
            },
            "stage_two": {
                "summary": content.get("stage_two_summary") or "暂无人工面试纪要",
                "evidence_count": len(content.get("stage_two_evidence") or []),
                "finding_statuses": {item.get("dimension", "未分类维度"): item.get("status", "证据不足")
                                     for item in content.get("findings") or []},
            },
            "hard_indicators": hard_indicators(candidate.library_person_id, job.library_job_id if job else None),
            "risks": risks, "content": content, "versions": payload["versions"], "updated_at": session.updated_at,
        })
    return {"job_id": job_id, "batch_id": batch_id, "items": items,
            "notice": "综合报告汇总AI面试（如有）与人工面试AI旁听信息，仅供人工评估，不构成自动录用或淘汰决定。"}


@router.get("/listening/{candidate_id}/report")
def get_listening_report(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:read")
    return listening_report_payload(comprehensive_session(db, candidate_id))


@router.put("/listening/{candidate_id}/report")
def edit_listening_report(candidate_id: int, body: ReportEditRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:edit")
    session = settled_session(db, candidate_id)
    if session.comprehensive_status == "confirmed":
        raise HTTPException(409, "已确认的综合报告不能直接修改")
    versions = loads(session.comprehensive_versions, [])
    next_version = max([int(item.get("version", 0)) for item in versions] or [session.comprehensive_version or 0]) + 1
    versions.append({"version": next_version, "version_type": "human_edit", "editor": ctx["user"],
                     "reason": body.reason, "created_at": now().isoformat(), "content": body.content})
    session.comprehensive_report = json.dumps(body.content, ensure_ascii=False)
    session.comprehensive_status = "pending_review"
    session.comprehensive_version = next_version
    session.comprehensive_versions = json.dumps(versions, ensure_ascii=False)
    audit(db, ctx, "human_comprehensive_report_modified", "listening_report", session.id, body.reason)
    db.commit()
    return listening_report_payload(session)


@router.post("/listening/{candidate_id}/report/return")
def return_listening_report(candidate_id: int, body: ReasonRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:return")
    session = settled_session(db, candidate_id)
    session.comprehensive_status = "returned"
    audit(db, ctx, "human_comprehensive_report_returned", "listening_report", session.id, body.reason)
    db.commit()
    return {"ok": True, "status": session.comprehensive_status}


@router.post("/listening/{candidate_id}/report/confirm")
def confirm_listening_report(candidate_id: int, body: ReasonRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:confirm")
    session = settled_session(db, candidate_id)
    session.comprehensive_status = "confirmed"
    audit(db, ctx, "human_comprehensive_report_confirmed", "listening_report", session.id, body.reason)
    db.commit()
    note = sync_to_person_library(db, ctx, db.get(Candidate, candidate_id))
    audit(db, ctx, "interview_result_synced", "listening_report", session.id, note)
    db.commit()
    return {"ok": True, "status": session.comprehensive_status, "library_sync": note}


@router.get("/listening/{candidate_id}/report/export")
def export_listening_report(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "report:export")
    session = comprehensive_session(db, candidate_id)
    if session.comprehensive_status != "confirmed":
        raise HTTPException(409, "未经人工确认的综合报告不得导出")
    payload = listening_report_payload(session)
    candidate = db.get(Candidate, candidate_id)
    job = db.get(Job, candidate.job_id) if candidate else None
    batch = db.get(Batch, candidate.batch_id) if candidate else None
    audit(db, ctx, "comprehensive_report_exported", "listening_report", session.id, f"导出确认版本 {payload['current_version']}")
    db.commit()
    metadata = {
        "candidate_name": candidate.name if candidate else payload["current_content"].get("candidate", "—"),
        "candidate_code": candidate.code if candidate else "—",
        "job_name": job.name if job else "—", "batch_name": batch.name if batch else "—",
        "version": payload["current_version"],
    }
    title = "TalentFlowAI面试两阶段综合报告" if payload["current_content"].get("mode") != "standalone" else "TalentFlow人工面试AI旁听综合报告"
    return docx_response(report_docx(title, payload["current_content"], metadata),
                         f"comprehensive-report-{candidate_id}-v{payload['current_version']}.docx")
