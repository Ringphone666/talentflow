"""候选人端的第一阶段AI面试：准备、作答、追问、提交。

两种进入方式共用同一套流程：账号密码登录（保留），线下集中面试现场入口（免登录，跳过
个人信息填报；现场已告知并取得同意时一并跳过合规须知）。
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core.database import get_db
from ...core.deps import actor_context, audit, require
from .. import doubao_asr
from .. import listening_intelligence as listening_ai
from ..common import (INTERVIEW_NOTICE, asr_available_mode, get_candidate_interview, interview_is_preparing,
                      interview_questions, loads, now, profile_complete, profile_required, question_dict,
                      recording_manifest, require_interview_owner, require_interview_preparing,
                      require_speech_for_interview, save_recording_file)
from ..interview_context import resume_context
from ..standards import DISCLAIMER
from ..models import Answer, Interview, Question, SensitiveBlock
from ..report_builder import answer_payload, pending_report, schedule_report
from ..speech_routes import get_capture
from ..text_models import generate_followup

router = APIRouter(prefix="/api", tags=["AI面试·候选人端"])


class ConsentRequest(BaseModel):
    consented: bool
    notice_version: str = ""


class CandidateProfileUpdate(BaseModel):
    phone: str = Field(min_length=5, max_length=32)
    email: str = Field(min_length=3, max_length=128)
    education: str = Field(min_length=1, max_length=64)
    major: str = Field(min_length=1, max_length=128)
    years: str = Field(min_length=1, max_length=32)


class MicRequest(BaseModel):
    passed: bool
    peak_rms: float = Field(default=0, ge=0, le=1)
    speech_frames: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=0, ge=0, le=10000)
    speech_text: str = Field(default="", max_length=200)


class AudioPayload(BaseModel):
    data_url: str


class AnswerRequest(BaseModel):
    capture_id: str = ""
    question_id: int
    transcript: str = ""
    timed_out: bool = False
    generate_followup: bool = True


class FollowupAnswerRequest(BaseModel):
    capture_id: str = ""
    transcript: str = ""
    audio_data_url: str = ""
    timed_out: bool = False


def owned_interview(db: Session, ctx: dict, interview_id: int) -> Interview:
    interview = db.get(Interview, interview_id)
    if not interview:
        raise HTTPException(404, "面试记录不存在")
    require_interview_owner(db, ctx, interview)
    return interview


def profile_ready(interview: Interview) -> bool:
    return not profile_required(interview) or profile_complete(loads(interview.candidate.profile_json, {}))


def consent_current(interview: Interview) -> bool:
    return bool(interview.consented) and interview.consent_version == listening_ai.current_notice()[0]


def next_position(db: Session, interview: Interview, sequence: int) -> int:
    """下一题的序号；答完最后一题后等于题目数 + 1。"""
    total = len(interview_questions(db, interview))
    return min(sequence + 1, total + 1)


@router.get("/interviews/me")
def my_interview(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = get_candidate_interview(db, ctx)
    if not interview:
        raise HTTPException(404, "面试记录不存在")
    candidate_profile = loads(interview.candidate.profile_json, {})
    questions = interview_questions(db, interview)
    answers = db.scalars(select(Answer).where(Answer.interview_id == interview.id).order_by(Answer.id)).all()
    notice_version, notice_text = listening_ai.current_notice()
    return {
        "id": interview.id,
        "asr_mode": asr_available_mode(),
        "entry_mode": interview.entry_mode or "account",
        "candidate": {"code": interview.candidate.code, "name": interview.candidate.name},
        "status": interview.status,
        "consented": interview.consented,
        "consent_version": interview.consent_version,
        "consent_method": interview.consent_method or "online",
        "available_consent_version": notice_version,
        "consent_text": notice_text,
        "needs_consent": doubao_asr.enabled() and not consent_current(interview),
        "profile": candidate_profile,
        "profile_complete": profile_complete(candidate_profile),
        "needs_profile": profile_required(interview) and interview_is_preparing(interview) and not profile_complete(candidate_profile),
        "started_at": interview.started_at,
        "completed_at": interview.completed_at,
        "mic_checked": interview.mic_checked,
        "current_question": interview.current_question,
        "question_version": interview.question_version,
        "questions": [question_dict(q) for q in questions],
        "answers": [{"id": a.id, "question_id": a.question_id, "answer_code": a.answer_code, "transcript": a.transcript,
                     "followup_text": a.followup_text, "followup_answer": a.followup_answer, "timed_out": a.timed_out}
                    for a in answers],
        "notice": INTERVIEW_NOTICE,
    }


@router.put("/interviews/me/profile")
def update_candidate_profile(body: CandidateProfileUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = get_candidate_interview(db, ctx)
    if not interview:
        raise HTTPException(404, "面试记录不存在")
    require_interview_preparing(interview)
    interview.candidate.profile_json = json.dumps(body.model_dump(), ensure_ascii=False)
    audit(db, ctx, "candidate_profile_updated", "candidate", interview.candidate_id, "候选人完成面试前资料填写")
    db.commit()
    return {"ok": True, "profile": body.model_dump(), "profile_complete": True}


@router.post("/interviews/{interview_id}/consent")
def consent(interview_id: int, body: ConsentRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = owned_interview(db, ctx, interview_id)
    if body.consented and not profile_ready(interview):
        raise HTTPException(409, "请先完成个人信息填写，再确认合规告知")
    interview.consented = body.consented
    notice_version, notice_text = listening_ai.current_notice()
    if body.consented and body.notice_version == notice_version:
        interview.consent_version = notice_version
    interview.consented_at = now() if body.consented else None
    interview.consent_method = "online"
    interview.consent_recorded_by = ctx["user"]
    # 面试开始后更新或撤回同意不改变已保存的作答进度。
    if interview_is_preparing(interview):
        if not body.consented:
            interview.status = "consent_declined"
            interview.mic_checked = False
        elif interview.status in ("consent_pending", "consent_declined"):
            interview.status = "mic_check"
    audit(db, ctx, "candidate_consented" if body.consented else "candidate_declined", "interview", interview.id,
          json.dumps({"version": interview.consent_version,
                      "notice": notice_text if interview.consent_version == notice_version else "旧版采集告知"}, ensure_ascii=False))
    db.commit()
    return {"ok": True, "status": interview.status}


@router.post("/interviews/{interview_id}/mic-check")
def mic_check(interview_id: int, body: MicRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = owned_interview(db, ctx, interview_id)
    require_interview_preparing(interview)
    if not profile_ready(interview):
        raise HTTPException(409, "请先完成个人信息填写")
    if not interview.consented:
        raise HTTPException(409, "未同意采集告知，不能检测麦克风")
    require_speech_for_interview()
    normalized_phrase = re.sub(r"[\s，。、“”‘’！？!?：:；;,.，、]", "", body.speech_text).lower()
    normalized_phrase = normalized_phrase.replace("壹", "一").replace("贰", "二").replace("两", "二").replace("叁", "三")
    phrase_valid = normalized_phrase in {"麦克风测试一二三", "麦克风测试123"}
    if body.passed and (body.duration_ms < 2200 or body.peak_rms < 0.02 or body.speech_frames < 5):
        raise HTTPException(422, "未检测到持续有效的人声，请对着麦克风清晰说话后重试")
    if body.passed and not phrase_valid:
        raise HTTPException(422, "未识别到指定测试口令，请清晰说“麦克风测试，一二三”后重试")
    interview.mic_checked = body.passed
    interview.status = "ready" if body.passed else "mic_check"
    audit(db, ctx, "microphone_checked", "interview", interview.id,
          f"passed={body.passed}, peak_rms={body.peak_rms:.4f}, speech_frames={body.speech_frames}, duration_ms={body.duration_ms}, speech_text={body.speech_text[:80]}")
    db.commit()
    return {"ok": True, "status": interview.status}


@router.post("/interviews/{interview_id}/start")
def start_interview(interview_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = owned_interview(db, ctx, interview_id)
    require_interview_preparing(interview)
    if not profile_ready(interview):
        raise HTTPException(409, "请先完成个人信息填写")
    if not interview.consented:
        raise HTTPException(409, "未同意采集告知，不能开始面试")
    require_speech_for_interview()
    if doubao_asr.enabled() and not consent_current(interview):
        raise HTTPException(409, "请先确认最新的采集告知")
    if not interview.mic_checked:
        raise HTTPException(409, "请先完成麦克风检测")
    if interview.status != "ready":
        raise HTTPException(409, "请先完成面试前准备")
    interview.status = "in_progress"
    interview.started_at = interview.started_at or now()
    audit(db, ctx, "interview_started", "interview", interview.id,
          f"题目版本 {interview.question_version}；进入方式：{'线下集中面试入口' if interview.entry_mode == 'onsite' else '账号登录'}")
    db.commit()
    return {"ok": True, "status": interview.status}


@router.post("/interviews/{interview_id}/audio/{question_id}")
def save_audio(interview_id: int, question_id: int, body: AudioPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = db.get(Interview, interview_id)
    if not interview or interview.status != "in_progress":
        raise HTTPException(409, "面试未开始")
    require_interview_owner(db, ctx, interview)
    saved, byte_count = save_recording_file(body.data_url, f"interview-{interview_id}-question-{question_id}.webm")
    answer = db.scalar(select(Answer).where(Answer.interview_id == interview_id, Answer.question_id == question_id))
    if answer:
        manifest = recording_manifest(answer.recording_path)
        manifest["main"] = saved
        answer.recording_path = json.dumps(manifest, ensure_ascii=False)
        db.commit()
    return {"ok": True, "saved": saved, "bytes": byte_count}


@router.post("/interviews/{interview_id}/answers")
def submit_answer(interview_id: int, body: AnswerRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = db.get(Interview, interview_id)
    question = db.get(Question, body.question_id)
    if not interview or interview.status != "in_progress":
        raise HTTPException(409, "面试未开始或已结束")
    require_interview_owner(db, ctx, interview)
    if not question or question.batch_id != interview.batch_id or question.job_id != interview.job_id or question.version != interview.question_version:
        raise HTTPException(409, "题目不属于本面试固定题目版本")
    answer = db.scalar(select(Answer).where(Answer.interview_id == interview_id, Answer.question_id == question.id))
    if answer and answer.followup_generated:
        return {"answer_id": answer.id, "transcript": answer.transcript,
                "followup": answer.followup_text if not answer.followup_answer else None,
                "followup_basis": answer.transcript[:80], "current_question": interview.current_question,
                "message": DISCLAIMER}
    capture = None
    if doubao_asr.enabled() and (not body.timed_out or body.capture_id):
        capture = get_capture(db, body.capture_id, ctx, "interview", interview_id, question.id)
        transcript = capture.transcript
    else:
        transcript = body.transcript.strip()
    if answer:
        answer.transcript = transcript
        answer.timed_out = body.timed_out
    else:
        answer = Answer(interview_id=interview.id, question_id=question.id, answer_code=f"A{question.sequence}",
                        transcript=transcript, timed_out=body.timed_out)
        db.add(answer)
        db.flush()
    followup = None
    followup_basis = None
    if capture:
        paths = recording_manifest(answer.recording_path)
        paths["main_asr"] = capture.audio_path
        paths["main_capture_id"] = capture.id
        answer.recording_path = json.dumps(paths, ensure_ascii=False)
    # 超时只关闭录音窗口；已取得回答时仍生成一次追问，没有回答证据则直接进入下一题。
    if body.generate_followup and transcript.strip() and not answer.followup_generated:
        resume = resume_context(interview.candidate)
        candidate = generate_followup(question.sequence, transcript, resume=resume)
        answer.followup_generated = True
        if candidate["allowed"]:
            answer.followup_text = candidate["content"]
            followup = candidate["content"]
            followup_basis = candidate.get("basis")
            audit(db, ctx, "dynamic_followup_generated", "answer", answer.id,
                  f"主体题 {question.sequence}，依据回答生成并通过敏感过滤：{followup_basis}；简历版本：{resume.get('version', '')}；简历依据：{candidate.get('resume_excerpt', '未引用')}")
        else:
            block = SensitiveBlock(interview_id=interview.id, content=candidate["content"], reason=candidate["reason"], source_type="dynamic_followup")
            db.add(block)
            db.flush()
            audit(db, ctx, "sensitive_content_blocked", "sensitive_block", block.id, candidate["reason"])
    if not followup:
        interview.current_question = next_position(db, interview, question.sequence)
    audit(db, ctx, "answer_saved", "answer", answer.id, f"提交主体题 {question.sequence} 回答，超时={body.timed_out}")
    db.commit()
    return {"answer_id": answer.id, "transcript": answer.transcript, "followup": followup, "followup_basis": followup_basis,
            "current_question": interview.current_question, "message": DISCLAIMER}


@router.post("/interviews/{interview_id}/answers/{answer_id}/followup")
def submit_followup(interview_id: int, answer_id: int, body: FollowupAnswerRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    interview = db.get(Interview, interview_id)
    answer = db.get(Answer, answer_id)
    if not interview or not answer or answer.interview_id != interview.id:
        raise HTTPException(404, "回答不存在")
    require_interview_owner(db, ctx, interview)
    if interview.status != "in_progress":
        raise HTTPException(409, "面试未开始或已结束，不能修改追问回答")
    question = db.get(Question, answer.question_id)
    if body.timed_out and not (doubao_asr.enabled() and body.capture_id):
        answer.followup_answer = "追问超时未作答"
    elif doubao_asr.enabled():
        capture = get_capture(db, body.capture_id, ctx, "interview", interview_id, question.id, "followup")
        answer.followup_answer = capture.transcript
        paths = recording_manifest(answer.recording_path)
        paths["followup_asr"] = capture.audio_path
        paths["followup_capture_id"] = capture.id
        answer.recording_path = json.dumps(paths, ensure_ascii=False)
    else:
        answer.followup_answer = body.transcript.strip()
    saved = None
    if body.audio_data_url and not body.timed_out:
        saved, _ = save_recording_file(body.audio_data_url, f"interview-{interview_id}-answer-{answer_id}-followup.webm")
        manifest = recording_manifest(answer.recording_path)
        manifest["followup"] = saved
        answer.recording_path = json.dumps(manifest, ensure_ascii=False)
    interview.current_question = next_position(db, interview, question.sequence)
    audit(db, ctx, "followup_answer_saved", "answer", answer.id, f"提交主体题 {question.sequence} 动态追问回答，超时={body.timed_out}")
    db.commit()
    return {"ok": True, "current_question": interview.current_question, "audio_saved": saved}


@router.post("/interviews/{interview_id}/submit")
def complete_interview(interview_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """提交面试。候选人无需等待：回答立即归档，报告在后台生成后进入人工复核。"""
    require(ctx, "interview:use")
    interview = db.get(Interview, interview_id)
    if not interview or interview.status != "in_progress":
        raise HTTPException(409, "面试未处于进行中")
    require_interview_owner(db, ctx, interview)
    answer_payload(db, interview)  # 校验全部主体题均已作答或记录超时
    report = pending_report(db, interview)
    interview.status = "completed"
    interview.current_question = len(interview_questions(db, interview)) + 1
    interview.completed_at = now()
    audit(db, ctx, "interview_submitted", "interview", interview.id, "候选人提交面试，报告转入后台生成")
    db.commit()
    schedule_report(interview.id, ctx)
    db.refresh(report)
    return {"ok": True, "report_id": report.id, "status": report.status, "message": DISCLAIMER}


@router.post("/interviews/{interview_id}/reset")
def reset_interview(interview_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "interview:use")
    owned_interview(db, ctx, interview_id)
    # 旧客户端可能仍会调用；面试记录和作答时间一律不删除。
    raise HTTPException(409, "本次面试不支持重置或重新面试；未开始时可返回准备步骤修改信息")
