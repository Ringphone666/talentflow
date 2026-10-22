"""人工面试的AI旁听。

按批次选择候选人；候选人做过第一阶段AI面试的，旁听关联其报告，没做过的直接依据简历和岗位
要求，二者流程相同。开始前可先生成一组提问建议；现场录音转写后给出补充提问，结束时汇总为
综合报告，交人工复核。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core.database import DATA_DIR, get_db
from ...core.deps import actor_context, allowed, audit, require
from ...library.profile import hard_indicators
from .. import listening_intelligence as listening_ai
from .. import listening_roles, listening_tasks
from .. import speaker_services
from ..common import asr_available_mode, asr_runtime_mode, loads, now
from ..interview_context import resume_context
from ..standards import DISCLAIMER, filter_sensitive
from ..models import Batch, Candidate, Interview, Job, ListeningSession, Report, SensitiveBlock, SpeechCapture
from ..speech_routes import get_capture
from .reports import listening_report_payload

router = APIRouter(prefix="/api/listening", tags=["AI面试·AI旁听"])

UNBOUND_MODES = ("unavailable", "unconfigured")


class ListeningStart(BaseModel):
    consented: bool = False
    # 面试官确认已当面向候选人告知采集事项并取得同意（候选人没有系统内同意记录时必填）。
    candidate_confirmed: bool = False
    candidate_code: str = ""
    notice_version: str = ""


class SuggestionAction(BaseModel):
    suggestion_id: int
    action: str
    edited_text: str = Field(default="", max_length=400)
    # followup：现场生成的补充提问；prepared：开始前准备的提问建议。
    source: str = Field(default="followup", pattern="^(followup|prepared)$")


class CaptureReference(BaseModel):
    capture_id: str


class BackgroundOption(BaseModel):
    # 为真时在后台处理，接口立即返回；页面从旁听状态里读取进度和结果。
    background: bool = False


class TurnRole(BaseModel):
    """连续对话中的一段话（从第 first 句到第 last 句，从 0 起算）是谁说的。"""
    capture_id: str
    first: int = Field(ge=0)
    last: int = Field(ge=0)
    role: str


class SpeakerLabel(BaseModel):
    capture_id: str
    speaker: str


def candidate_or_404(db: Session, candidate_id: int) -> Candidate:
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    return candidate


def find_session(db: Session, candidate_id: int) -> ListeningSession | None:
    mode = asr_runtime_mode()
    session = db.scalar(select(ListeningSession).where(
        ListeningSession.candidate_id == candidate_id, ListeningSession.source_mode == mode,
    ).order_by(ListeningSession.id.desc()))
    if session:
        return session
    # 语音服务配置前建立的记录还没有采集任何内容，配置完成后继续使用（保留已准备的提问建议）。
    session = db.scalar(select(ListeningSession).where(
        ListeningSession.candidate_id == candidate_id, ListeningSession.source_mode.in_(UNBOUND_MODES),
        ListeningSession.status == "ready",
    ).order_by(ListeningSession.id.desc()))
    if session and mode not in UNBOUND_MODES:
        session.source_mode = mode
    return session


def open_session(db: Session, candidate: Candidate) -> ListeningSession:
    session = find_session(db, candidate.id)
    if not session:
        session = ListeningSession(candidate_id=candidate.id, batch_id=candidate.batch_id, source_mode=asr_runtime_mode())
        db.add(session)
        db.flush()
        listening_tasks.reset(session.id)
    elif session.batch_id is None:
        session.batch_id = candidate.batch_id
    return session


def running_session(db: Session, candidate_id: int) -> ListeningSession:
    session = find_session(db, candidate_id)
    if not session or session.status != "running":
        raise HTTPException(409, "旁听未开始或已结束")
    return session


def comprehensive_state(session: ListeningSession | None) -> str:
    if session and (session.comprehensive_report or session.comprehensive_status in ("generating", "generation_failed")):
        return session.comprehensive_status
    return "not_generated"


def own_capture(db: Session, ctx, candidate_id: int, capture_id: str) -> SpeechCapture | None:
    capture = db.get(SpeechCapture, capture_id)
    if capture and (capture.owner, capture.role, capture.kind, capture.target_id) == (
            ctx["user"], ctx["role"], "listening", candidate_id):
        return capture
    return None


def require_asr():
    if asr_available_mode() == "unavailable":
        raise HTTPException(503, "实时语音转写未启用或未配置密钥，请先完成语音服务配置")


@router.get("/candidates")
def listening_candidates(batch_id: int | None = Query(default=None, ge=1), ctx=Depends(actor_context),
                         db: Session = Depends(get_db)):
    """某个批次中可以旁听的候选人，以及各自已有的依据（第一阶段报告、简历）。"""
    require(ctx, "listening:use")
    query = select(Candidate).order_by(Candidate.code)
    if batch_id is not None:
        query = query.where(Candidate.batch_id == batch_id)
    people = []
    for candidate in db.scalars(query).all():
        report = db.scalar(select(Report).where(Report.candidate_id == candidate.id).order_by(Report.id.desc()))
        interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
        session = find_session(db, candidate.id)
        batch = db.get(Batch, candidate.batch_id)
        has_report = bool(report and report.current_version)
        people.append({
            "id": candidate.id, "code": candidate.code, "name": candidate.name,
            "batch_id": candidate.batch_id, "batch_name": batch.name if batch else "",
            "job_name": batch.job.name if batch else "", "library_person_id": candidate.library_person_id,
            "interview_status": interview.status if interview else "not_required",
            "stage_one": {"report_id": report.id, "status": report.status, "match_score": report.match_score} if has_report else None,
            "resume_status": resume_context(candidate)["status"],
            "listening_status": session.status if session else "ready",
            "comprehensive_status": comprehensive_state(session),
        })
    db.rollback()  # 列表只读，不保存 find_session 对旧记录的调整
    return people


@router.get("/{candidate_id}")
def get_listening(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    candidate = candidate_or_404(db, candidate_id)
    # 只是查看不建立旁听记录；生成提问建议或开始旁听时才建立。
    session = find_session(db, candidate_id)
    if session:
        details = listening_ai.info(db, session)
        db.commit()
        report = listening_report_payload(session)
    else:
        details = listening_ai.preview(db, candidate)
        report = {"session_id": None, "candidate_id": candidate_id, "status": "not_generated", "current_version": 0,
                  "current_content": {}, "versions": []}
    batch = db.get(Batch, candidate.batch_id)
    job = db.get(Job, candidate.job_id)
    captures = db.scalars(select(SpeechCapture).where(
        SpeechCapture.kind == "listening", SpeechCapture.target_id == candidate_id, SpeechCapture.owner == ctx["user"],
    ).order_by(SpeechCapture.created_at)).all()
    return {
        **details, "id": session.id if session else None, "candidate_id": candidate_id,
        "candidate": {"id": candidate.id, "code": candidate.code, "name": candidate.name,
                      "library_person_id": candidate.library_person_id},
        "batch": {"id": batch.id, "code": batch.code, "name": batch.name, "mode": batch.mode or "ai_interview"} if batch else None,
        "job": {"id": job.id, "name": job.name, "library_job_id": job.library_job_id,
                "duties": job.duties, "requirements": job.requirements} if job else None,
        "hard_indicators": hard_indicators(candidate.library_person_id, job.library_job_id if job else None),
        "status": session.status if session else "ready", "asr_mode": asr_available_mode(),
        "transcript_index": session.transcript_index if session else 0,
        "transcript": loads(session.transcript, []) if session else [],
        "suggestions": loads(session.suggestions, []) if session else [],
        "prepared_questions": loads(session.prepared_questions, []) if session else [],
        "comprehensive_report": report["current_content"] or None, "comprehensive_report_meta": report,
        # 后台处理的进度：提问建议、综合报告。
        "tasks": {"prepare": listening_tasks.view("prepare", session.id) if session else None,
                  "report": listening_tasks.report_state(session)},
        "message": DISCLAIMER,
        "captures": [{"id": c.id, "status": c.status, "text": c.transcript, "speaker_status": c.speaker_status,
                      "speaker_analysis": loads(c.speaker_result, {})} for c in captures],
    }


@router.post("/{candidate_id}/prepare")
def prepare_questions(candidate_id: int, body: BackgroundOption | None = None, ctx=Depends(actor_context),
                      db: Session = Depends(get_db)):
    """旁听开始前依据简历和岗位要求准备提问建议；不需要第一阶段面试，也不需要语音服务。

    默认同步返回结果；background 为真时在后台生成，立即返回后台处理记录，生成期间可以先开始旁听。
    """
    require(ctx, "listening:use")
    candidate = candidate_or_404(db, candidate_id)
    session = open_session(db, candidate)
    if session.status == "completed":
        raise HTTPException(409, "本场旁听已结束")
    if body and body.background:
        db.commit()
        basis = "简历和岗位要求" if resume_context(candidate)["status"] == "ready" else "岗位要求"
        return {"operation": listening_tasks.start_prepare(session, ctx, basis),
                "prepared_questions": loads(session.prepared_questions, [])}
    if listening_tasks.running("prepare", session.id):
        raise HTTPException(409, listening_tasks.BUSY["prepare"])
    questions = listening_ai.prepare_questions(db, session, ctx)
    listening_tasks.forget("prepare", session.id)
    return {"prepared_questions": questions}


@router.post("/{candidate_id}/start")
def start_listening(candidate_id: int, body: ListeningStart | None = None, ctx=Depends(actor_context),
                    db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    require_asr()
    candidate = candidate_or_404(db, candidate_id)
    if not body or not body.consented:
        raise HTTPException(409, "须取得参与者同意并告知音频发送至火山引擎")
    session = open_session(db, candidate)
    if session.status == "completed":
        raise HTTPException(409, "旁听已完成，禁止覆盖历史记录")
    resumed = session.status == "running" and listening_ai.consent_valid(db, session)
    if not resumed:
        listening_ai.begin(db, session, candidate, body, ctx)
        record = loads(listening_ai.context(db, session).consent, {})
        if record.get("method") == listening_ai.ONSITE_METHOD:
            audit(db, ctx, "listening_consent_attested", "listening", candidate_id,
                  f"面试官确认已当面告知采集事项并取得候选人同意（告知版本 {record.get('notice_version')}）")
        else:
            audit(db, ctx, "listening_consent_reused", "listening", candidate_id, "已核验并引用候选人在系统内确认的采集同意")
        audit(db, ctx, "listening_started", "listening", candidate_id,
              "关联第一阶段AI面试报告" if session.mode == "linked" else "未做第一阶段AI面试，依据简历和岗位要求")
    session.status = "running"
    db.commit()
    return {"ok": True, "mode": session.mode}


@router.post("/{candidate_id}/suggestions")
def act_suggestion(candidate_id: int, body: SuggestionAction, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    if body.action not in {"adopted", "edited", "ignored"}:
        raise HTTPException(422, "动作必须为 adopted、edited 或 ignored")
    session = find_session(db, candidate_id)
    prepared = body.source == "prepared"
    # 准备好的提问在开始旁听前就可以取舍；现场补充提问只在旁听进行中处理。
    if not session or session.status == "completed" or (not prepared and session.status != "running"):
        raise HTTPException(409, "旁听未开始或已结束")
    if body.action == "edited":
        allowed, reason = filter_sensitive(body.edited_text)
        if not body.edited_text.strip():
            raise HTTPException(422, "请填写修改后的问题")
        if not allowed:
            db.add(SensitiveBlock(content=body.edited_text, reason=reason, source_type="listening_edited_suggestion"))
            audit(db, ctx, "sensitive_content_blocked", "listening", candidate_id, reason)
            db.commit()
            raise HTTPException(422, "编辑后的问题触发敏感过滤")
    items = loads(session.prepared_questions if prepared else session.suggestions, [])
    target = next((item for item in items if item["id"] == body.suggestion_id), None)
    if not target:
        raise HTTPException(404, "建议问题不存在")
    target["status"] = "adopted" if prepared and body.action == "edited" else body.action
    if prepared and body.action == "edited":
        target["text"] = body.edited_text.strip()
        target["edited"] = True
    else:
        target["edited_text"] = body.edited_text if body.action == "edited" else ""
    if prepared:
        session.prepared_questions = json.dumps(items, ensure_ascii=False)
    else:
        session.suggestions = json.dumps(items, ensure_ascii=False)
    audit(db, ctx, "listening_suggestion_updated", "listening", candidate_id,
          f"{'准备的提问' if prepared else '补充问题'} {body.suggestion_id} 执行 {body.action}")
    db.commit()
    return {"ok": True, "suggestions": loads(session.suggestions, []), "prepared_questions": loads(session.prepared_questions, [])}


@router.post("/{candidate_id}/capture")
def attach_capture(candidate_id: int, body: CaptureReference, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    session = find_session(db, candidate_id)
    if not session or session.status != "running":
        raise HTTPException(409, "旁听未开始")
    capture = own_capture(db, ctx, candidate_id, body.capture_id)
    if capture and capture.status == "linked":
        return {"ok": True}
    capture = get_capture(db, body.capture_id, ctx, "listening", candidate_id)
    lines = loads(session.transcript, [])
    lines.append(f"[录音 {capture.id}] {capture.transcript}")
    session.transcript = json.dumps(lines, ensure_ascii=False)
    session.transcript_index = len(lines)
    capture.status = "linked"
    audit(db, ctx, "listening_transcribed", "speech_capture", capture.id, "真实旁听原文已关联")
    db.commit()
    # 说话人分离服务可用时才运行；服务故障不影响已保存的录音和转写，只记录失败。
    if capture.audio_path and speaker_services.MODE not in {"mock", "disabled"}:
        capture.speaker_status = "processing"
        db.commit()
        try:
            result = speaker_services.diarize(
                (DATA_DIR / capture.audio_path).resolve(),
                object_key=f"listening/{candidate_id}/{capture.id}.wav",
                meeting_id=f"candidate-{candidate_id}-listening-{session.id}",
                expected_speaker_count=2,
            )
            capture.speaker_status = "completed"
            capture.speaker_result = json.dumps(result, ensure_ascii=False)
            audit(db, ctx, "speaker_diarization_completed", "speech_capture", capture.id,
                  "3D-Speaker本地服务完成说话人分离，角色仍需结合语义人工核对")
        except Exception as exc:  # noqa: BLE001 - 分离服务的任何故障都只记录，不影响旁听
            capture.speaker_status = "failed"
            capture.speaker_result = json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False)
            audit(db, ctx, "speaker_diarization_failed", "speech_capture", capture.id, f"3D-Speaker未完成：{type(exc).__name__}")
        db.commit()
    return {"ok": True}


@router.post("/{candidate_id}/speaker")
def label_speaker(candidate_id: int, body: SpeakerLabel, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    session = find_session(db, candidate_id)
    capture = own_capture(db, ctx, candidate_id, body.capture_id)
    if not session or session.status != "running" or not capture:
        raise HTTPException(403, "无权标注此录音或旁听已结束")
    # dialogue：考官和候选人都有发言的连续对话，由系统按语境逐段区分。
    if body.speaker not in ("candidate", "interviewer", "unknown", "dialogue"):
        raise HTTPException(422, "无效发言人标签")
    context = listening_ai.context(db, session)
    labels = loads(context.speakers, {})
    kept = {key: value for key, value in (labels.get(capture.id) or {}).items() if key == "sentences"} \
        if body.speaker == "dialogue" else {}
    labels[capture.id] = {**kept, "speaker": body.speaker, "actor": ctx["user"], "time": now().isoformat()}
    context.speakers = json.dumps(labels, ensure_ascii=False)
    context.last_evidence_hash = ""
    audit(db, ctx, "speaker_labelled", "speech_capture", capture.id, body.speaker)
    db.commit()
    return {"ok": True}


@router.post("/{candidate_id}/roles")
def separate_speakers(candidate_id: int, body: CaptureReference | None = None, ctx=Depends(actor_context),
                      db: Session = Depends(get_db)):
    """按对话语境区分已保存录音里的发言人（考官、候选人）。结果是推断，页面标明待核对。"""
    require(ctx, "listening:use")
    session = running_session(db, candidate_id)
    if not listening_ai.consent_valid(db, session):
        raise HTTPException(409, "请先完成采集告知确认，再开始旁听分析")
    handled = listening_roles.ensure(db, session, finalized=True, capture_id=body.capture_id if body else None)
    context = listening_ai.context(db, session)
    db.refresh(context)
    return {"handled": handled, "speakers": listening_ai.speakers_view(db, context)}


@router.post("/{candidate_id}/turns")
def confirm_turn(candidate_id: int, body: TurnRole, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """面试官改正或确认连续对话中的一段话是谁说的。"""
    require(ctx, "listening:use")
    session = find_session(db, candidate_id)
    capture = own_capture(db, ctx, candidate_id, body.capture_id)
    if not session or session.status != "running" or not capture:
        raise HTTPException(403, "无权标注此录音或旁听已结束")
    if body.role not in listening_roles.ROLES:
        raise HTTPException(422, "无效发言人标签")
    label = loads(listening_ai.context(db, session).speakers, {}).get(capture.id)
    if not label or label.get("speaker") != "dialogue":
        raise HTTPException(409, "这段录音已经整段标注了发言人")
    try:
        turns = listening_roles.confirm(db, session, capture, body.first, body.last, body.role, ctx["user"])
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    audit(db, ctx, "speaker_turn_confirmed", "speech_capture", capture.id,
          f"第 {body.first + 1} 至 {body.last + 1} 句：{body.role}")
    db.commit()
    return {"ok": True, "turns": turns}


@router.post("/{candidate_id}/suggest")
def generate_suggestion(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "listening:use")
    return listening_ai.generate(db, running_session(db, candidate_id), ctx)


def generating(session: ListeningSession, operation: dict | None = None) -> dict:
    return {"status": "generating", "operation": operation, "report": listening_tasks.report_state(session)}


@router.post("/{candidate_id}/finish")
def finish_listening(candidate_id: int, body: BackgroundOption | None = None, ctx=Depends(actor_context),
                     db: Session = Depends(get_db)):
    """结束本场旁听并生成综合报告。

    默认等报告生成后返回报告内容；background 为真时立即结束本场，综合报告在后台生成，
    面试官可以接着旁听下一位候选人。
    """
    require(ctx, "listening:use")
    candidate_or_404(db, candidate_id)
    session = find_session(db, candidate_id)
    in_background = bool(body and body.background)
    if not session:
        raise HTTPException(409, "旁听尚未开始")
    if session.status == "completed":
        if in_background and comprehensive_state(session) in ("generating", "generation_failed"):
            return generating(session)
        return listening_report_payload(session)["current_content"]
    if session.status != "running":
        raise HTTPException(409, "旁听尚未开始")
    if db.scalar(select(SpeechCapture.id).where(SpeechCapture.kind == "listening", SpeechCapture.target_id == candidate_id,
                                                SpeechCapture.status == "recording")):
        raise HTTPException(409, "请先停止录音并保存最终转写")
    if not in_background:
        return listening_ai.generate(db, session, ctx, finish=True)
    listening_ai.check_ready(db, session)
    session.status = "completed"
    session.comprehensive_status = "generating"
    session.comprehensive_error = ""
    audit(db, ctx, "listening_finished", "listening", candidate_id, "结束本场旁听，综合报告在后台生成")
    db.commit()
    return generating(session, listening_tasks.start_report(session, ctx))


@router.post("/{candidate_id}/report/regenerate")
def regenerate_report(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """重新生成综合报告：用于没有生成出来，或只得到“证据保全”版本的情况。人工修改或确认过的报告不能重新生成。"""
    if not (allowed(ctx, "listening:use") or allowed(ctx, "report:edit")):
        raise HTTPException(403, "当前角色不能重新生成综合报告")
    candidate_or_404(db, candidate_id)
    session = find_session(db, candidate_id)
    if not session or session.status != "completed":
        raise HTTPException(409, "本场旁听尚未结束")
    if listening_tasks.running("report", session.id):
        raise HTTPException(409, listening_tasks.BUSY["report"])
    if session.comprehensive_status == "confirmed":
        raise HTTPException(409, "综合报告已经人工确认，不能重新生成")
    if any(item.get("version_type") != "ai_original" for item in loads(session.comprehensive_versions, [])):
        raise HTTPException(409, "综合报告已有人工修改，不能重新生成；需要调整时请在报告中修改")
    session.comprehensive_status = "generating"
    session.comprehensive_error = ""
    audit(db, ctx, "combined_report_regenerate", "listening", candidate_id, "重新生成综合报告")
    db.commit()
    return generating(session, listening_tasks.start_report(session, ctx))
