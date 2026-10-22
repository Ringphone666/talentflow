"""候选人管理：建立候选人与面试记录，生成登录凭据，关联人员库简历。"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from matching_core.services import talent_library

from ...core import background, security
from ...core.database import DATA_DIR, SessionLocal, get_db
from ...core.deps import actor_context, audit, matching_operator, require, require_any
from ...library import uploads
from ...library.persons import SELECTABLE_CATEGORIES
from ..common import loads, now
from ..interview_context import library_resume
from ..models import Answer, Batch, Candidate, Interview, ListeningContext, ListeningSession, Report, User
from .batches import batch_accepts_candidates

router = APIRouter(prefix="/api", tags=["AI面试·候选人"])

CATEGORY_OF = {"社会招聘": "社招", "校园招聘": "校招", "内部竞聘": "内聘"}


class CandidateCreate(BaseModel):
    code: str = Field(default="", max_length=32)
    name: str = Field(min_length=1, max_length=64)
    batch_id: int
    library_person_id: str | None = None
    profile: dict = Field(default_factory=dict)
    create_login: bool | None = None


class CandidateImport(BaseModel):
    batch_id: int
    person_ids: list[str] = Field(min_length=1, max_length=200)
    create_login: bool | None = None


class CandidateUpdate(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=64)
    batch_id: int
    profile: dict = Field(default_factory=dict)


def login_user(db: Session, candidate_id: int) -> User | None:
    return db.scalar(select(User).where(User.candidate_id == candidate_id, User.role == "candidate"))


def resume_view(candidate: Candidate) -> dict:
    linked = library_resume(candidate.library_person_id)
    if linked:
        return {"uploaded": True, "original_name": linked["source"], "size": linked["size"], "uploaded_at": linked["uploaded_at"],
                "ocr_status": linked["status"], "source": "library", "library_person_id": candidate.library_person_id,
                "text_preview": linked["text"][:240]}
    return {"uploaded": bool(candidate.resume_path) or candidate.resume_ocr_status == "processing",
            "original_name": candidate.resume_original_name, "size": candidate.resume_size,
            "uploaded_at": candidate.resume_uploaded_at, "ocr_status": candidate.resume_ocr_status,
            "ocr_error": candidate.resume_ocr_error, "source": "candidate", "library_person_id": None,
            "text_preview": candidate.resume_ocr_text[:240] if candidate.resume_ocr_text else ""}


def candidate_view(db: Session, candidate: Candidate) -> dict:
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
    report = db.scalar(select(Report).where(Report.candidate_id == candidate.id))
    listening = db.scalar(select(ListeningSession).where(ListeningSession.candidate_id == candidate.id)
                          .order_by(ListeningSession.id.desc()))
    batch = db.get(Batch, candidate.batch_id)
    user = login_user(db, candidate.id)
    return {
        "id": candidate.id, "code": candidate.code, "name": candidate.name,
        "profile": loads(candidate.profile_json, {}),
        "batch_id": candidate.batch_id, "batch_name": batch.name if batch else "",
        "batch_mode": (batch.mode or "ai_interview") if batch else "ai_interview",
        "job_id": candidate.job_id, "job_name": batch.job.name if batch else "",
        "library_person_id": candidate.library_person_id,
        "interview_status": interview.status if interview else "not_required",
        "entry_mode": interview.entry_mode if interview else "",
        "report_status": report.status if report else "not_generated",
        "listening_status": listening.status if listening else "not_started",
        "resume": resume_view(candidate),
        "login_username": user.username if user else "",
        "has_login": bool(user and user.password_hash),
        "password_set_at": user.password_changed_at if user else None,
        "login_locked": bool(user and user.locked_until and security_aware(user.locked_until) > now()),
    }


def listening_started(db: Session, candidate_id: int) -> bool:
    """旁听已经开始，或已有综合报告。只准备了提问建议、还没开始的不算。"""
    return db.scalar(select(ListeningSession.id).where(
        ListeningSession.candidate_id == candidate_id,
        (ListeningSession.status != "ready") | (ListeningSession.comprehensive_report != ""),
    ).limit(1)) is not None


def listening_drafts(db: Session, candidate_id: int) -> list[ListeningSession]:
    return db.scalars(select(ListeningSession).where(ListeningSession.candidate_id == candidate_id,
                                                     ListeningSession.status == "ready")).all()


def security_aware(value):
    from datetime import timezone
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def next_code(db: Session, batch: Batch) -> str:
    """候选人编号同时是登录账号：批次编号 + 三位流水号。"""
    used = {value for value in db.scalars(select(Candidate.code)).all()} | {value for value in db.scalars(select(User.username)).all()}
    prefix = batch.code[:26]
    index = 1
    while f"{prefix}-{index:03d}" in used:
        index += 1
    return f"{prefix}-{index:03d}"


def set_password(db: Session, candidate: Candidate) -> dict:
    """生成随机强密码。明文只在本次响应中返回一次，库中只保存摘要。"""
    password = security.generate_password(candidate.code)
    user = login_user(db, candidate.id)
    if user:
        user.username = candidate.code
        user.display_name = candidate.name
    else:
        user = User(username=candidate.code, display_name=candidate.name, role="candidate", candidate_id=candidate.id)
        db.add(user)
    user.password_hash = security.hash_password(password)
    user.initial_password = ""
    user.failed_logins = 0
    user.locked_until = None
    user.password_changed_at = now()
    return {"candidate_id": candidate.id, "name": candidate.name, "username": candidate.code, "password": password}


def create_one(db: Session, ctx: dict, batch: Batch, name: str, code: str, person_id: str | None,
               profile: dict, create_login: bool | None) -> tuple[Candidate, dict | None]:
    code = code.strip() or next_code(db, batch)
    if db.scalar(select(Candidate).where(Candidate.code == code)):
        raise HTTPException(409, f"候选人编号 {code} 已存在")
    if db.scalar(select(User).where(User.username == code)):
        raise HTTPException(409, f"候选人编号 {code} 已被账号占用")
    if person_id:
        try:
            talent_library.get_entry(person_id)
        except KeyError:
            raise HTTPException(404, "人员库中未找到所选人员") from None
        if db.scalar(select(Candidate.id).where(Candidate.batch_id == batch.id, Candidate.library_person_id == person_id)):
            raise HTTPException(409, f"{name} 已在本批次中，不能重复添加")
    candidate = Candidate(code=code, name=name.strip(), is_fictional=False, batch_id=batch.id, job_id=batch.job_id,
                          library_person_id=person_id, profile_json=json.dumps(profile, ensure_ascii=False))
    db.add(candidate)
    db.flush()
    listening_only = (batch.mode or "ai_interview") == "listening_only"
    if not listening_only:
        db.add(Interview(candidate_id=candidate.id, batch_id=batch.id, job_id=batch.job_id,
                         question_version=batch.question_version, status="consent_pending", current_question=1))
    wants_login = (not listening_only) if create_login is None else (create_login and not listening_only)
    credentials = set_password(db, candidate) if wants_login else None
    audit(db, ctx, "candidate_created", "candidate", candidate.id,
          f"关联批次 {batch.code}" + ("，仅人工面试旁听" if listening_only else f"，题目版本 v{batch.question_version}")
          + ("；已生成登录凭据" if credentials else "") + (f"；关联人员库 {person_id}" if person_id else ""))
    return candidate, credentials


def batch_for_candidates(db: Session, batch_id: int) -> Batch:
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "招聘批次不存在")
    if not batch_accepts_candidates(batch):
        raise HTTPException(409, "招聘批次未发布有效题目，不能创建面试记录")
    return batch


@router.get("/candidates")
def list_candidates(batch_id: int | None = Query(default=None, ge=1), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    if ctx["role"] == "candidate":
        raise HTTPException(403, "候选人不能查看候选人列表")
    require_any(ctx, "candidate:read", "report:read", "listening:use")
    query = select(Candidate).order_by(Candidate.id.desc())
    if batch_id:
        query = query.where(Candidate.batch_id == batch_id)
    return [candidate_view(db, candidate) for candidate in db.scalars(query).all()]


@router.post("/candidates")
def create_candidate(body: CandidateCreate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "candidate:create")
    batch = batch_for_candidates(db, body.batch_id)
    candidate, credentials = create_one(db, ctx, batch, body.name, body.code, body.library_person_id,
                                        body.profile, body.create_login)
    db.commit()
    db.refresh(candidate)
    return {**candidate_view(db, candidate), "credentials": credentials}


@router.post("/candidates/import")
def import_candidates(body: CandidateImport, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """从人员库选择人员加入面试批次，复用其简历解析结果。"""
    require(ctx, "candidate:create")
    batch = batch_for_candidates(db, body.batch_id)
    created, credentials, skipped = [], [], []
    for person_id in dict.fromkeys(body.person_ids):
        try:
            entry = talent_library.get_entry(person_id)
        except KeyError:
            skipped.append({"person_id": person_id, "reason": "人员库中未找到该人员"})
            continue
        if db.scalar(select(Candidate.id).where(Candidate.batch_id == batch.id, Candidate.library_person_id == person_id)):
            skipped.append({"person_id": person_id, "name": entry["full_name"], "reason": "已在本批次中"})
            continue
        if entry["status"] != "已解析":
            skipped.append({"person_id": person_id, "name": entry["full_name"], "reason": "简历尚未解析完成，请先在人员库处理"})
            continue
        name = entry["full_name"] if entry["full_name"] and entry["full_name"] != "待人工确认" else Path(entry["source_filename"]).stem
        candidate, item = create_one(db, ctx, batch, name[:64], "", person_id, {}, body.create_login)
        created.append(candidate.id)
        if item:
            credentials.append(item)
    db.commit()
    return {"created": len(created), "skipped": skipped, "credentials": credentials,
            "candidates": [candidate_view(db, db.get(Candidate, candidate_id)) for candidate_id in created]}


@router.post("/candidates/{candidate_id}/password")
def reset_password(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """重新生成随机密码（候选人遗失凭据或账号被锁定时使用），同样只显示一次。"""
    require(ctx, "candidate:edit")
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    batch = db.get(Batch, candidate.batch_id)
    if batch and (batch.mode or "ai_interview") == "listening_only":
        raise HTTPException(409, "本批次仅做人工面试旁听，候选人无需登录")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    if interview and interview.status == "completed":
        raise HTTPException(409, "该候选人的面试已提交，无需再生成登录凭据")
    credentials = set_password(db, candidate)
    audit(db, ctx, "candidate_password_reset", "candidate", candidate.id, "重新生成随机登录密码")
    db.commit()
    return {"credentials": credentials}


@router.put("/candidates/{candidate_id}")
def update_candidate(candidate_id: int, body: CandidateUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "candidate:edit")
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    code = body.code.strip()
    if db.scalar(select(Candidate).where(Candidate.code == code, Candidate.id != candidate_id)):
        raise HTTPException(409, "候选人编号已存在")
    user = login_user(db, candidate_id)
    if db.scalar(select(User).where(User.username == code, User.id != (user.id if user else -1))):
        raise HTTPException(409, "候选人编号已被账号占用")
    batch = db.get(Batch, body.batch_id)
    if not batch:
        raise HTTPException(404, "招聘批次不存在")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    if body.batch_id != candidate.batch_id:
        current = db.get(Batch, candidate.batch_id)
        if (batch.mode or "ai_interview") != ((current.mode if current else None) or "ai_interview"):
            raise HTTPException(409, "不能在不同面试方式的批次之间调整候选人，请删除后重新创建")
        if interview and interview.status != "consent_pending":
            raise HTTPException(409, "面试已开始或完成，不能更换候选人所属批次")
        if listening_started(db, candidate_id):
            raise HTTPException(409, "已有旁听记录，不能更换候选人所属批次")
        if not batch_accepts_candidates(batch):
            raise HTTPException(409, "目标批次未发布有效题目")
        candidate.batch_id = batch.id
        candidate.job_id = batch.job_id
        for draft in listening_drafts(db, candidate_id):
            draft.batch_id = batch.id
        if interview:
            interview.batch_id = batch.id
            interview.job_id = batch.job_id
            interview.question_version = batch.question_version
            interview.current_question = 1
    candidate.code = code
    candidate.name = body.name.strip()
    candidate.profile_json = json.dumps(body.profile, ensure_ascii=False)
    if user:
        user.username = code
        user.display_name = candidate.name
    audit(db, ctx, "candidate_updated", "candidate", candidate.id, f"修改候选人 {candidate.code}，关联批次 {batch.code}")
    db.commit()
    return {"ok": True, **candidate_view(db, candidate)}


@router.delete("/candidates/{candidate_id}")
def delete_candidate(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "candidate:delete")
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    started = interview and (interview.status != "consent_pending" or db.scalar(select(Answer).where(Answer.interview_id == interview.id)))
    if started or db.scalar(select(Report).where(Report.candidate_id == candidate_id)) or listening_started(db, candidate_id):
        raise HTTPException(409, "面试已进入流程或已有报告，不能删除；请保留记录或先走数据清理流程")
    for draft in listening_drafts(db, candidate_id):
        context = db.get(ListeningContext, draft.id)
        if context:
            db.delete(context)
        db.delete(draft)
    user = login_user(db, candidate_id)
    code = candidate.code
    if candidate.resume_path:
        resume_path = (DATA_DIR / candidate.resume_path).resolve()
        resume_root = (DATA_DIR / "resumes").resolve()
        if resume_root in resume_path.parents and resume_path.is_file():
            resume_path.unlink()
    if interview:
        db.delete(interview)
    if user:
        db.delete(user)
    db.delete(candidate)
    audit(db, ctx, "candidate_deleted", "candidate", candidate_id, f"删除候选人 {code}")
    db.commit()
    return {"ok": True}


def person_batch_for(db: Session, batch: Batch, operator: str) -> str:
    """面试批次直接上传的简历统一归入人员库的同名批次。"""
    if batch.library_person_batch_id:
        try:
            talent_library.get_batch(batch.library_person_batch_id)
            return batch.library_person_batch_id
        except KeyError:
            pass
    category = CATEGORY_OF.get(batch.recruitment_type, SELECTABLE_CATEGORIES[0])
    batch.library_person_batch_id = talent_library.create_batch(f"AI面试 · {batch.name}"[:100], category, operator)
    return batch.library_person_batch_id


@router.post("/candidates/{candidate_id}/resume")
async def upload_candidate_resume(candidate_id: int, file: UploadFile = File(...), allow_ocr: bool = Form(default=False),
                                  ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """上传候选人简历。简历进入人员库解析（与人岗匹配共用同一份资料），解析在后台进行。"""
    require(ctx, "candidate:create")
    operator = matching_operator(ctx)
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    if interview and interview.status == "in_progress":
        raise HTTPException(409, "面试进行中不能替换简历，请结束后再更新")
    loaded = await uploads.read_uploads([file])
    report = uploads.scan_report(loaded)
    if report["errors"]:
        raise HTTPException(422, "；".join(report["errors"]))
    if report["scans"] and not allow_ocr:
        raise HTTPException(409, {"message": "简历包含扫描页，需确认已获识别服务处理授权后才能上传", "scans": report["scans"]})
    batch = db.get(Batch, candidate.batch_id)
    person_batch_id = person_batch_for(db, batch, operator)
    folder, paths, _ = uploads.stage(loaded, [], {})
    candidate.resume_original_name = loaded[0].name[:255]
    candidate.resume_size = len(loaded[0].getvalue())
    candidate.resume_uploaded_at = now()
    candidate.resume_ocr_status = "processing"
    candidate.resume_ocr_error = ""
    candidate.library_person_id = None
    audit(db, ctx, "candidate_resume_uploaded", "candidate", candidate.id, f"上传简历 {loaded[0].name}，进入人员库解析")
    db.commit()
    actor = {"role": ctx["role"], "user": ctx["user"]}

    def work(progress):
        progress("正在解析简历")
        try:
            result = talent_library.import_files(person_batch_id, paths, operator, allow_ocr=allow_ocr)
        finally:
            uploads.discard(folder)
        with SessionLocal() as session:
            target = session.get(Candidate, candidate_id)
            if not target:
                return {"status": "failed", "message": "候选人已被删除"}
            entries = result["imported"] or result["failed"]
            entry = entries[0] if entries else None
            if result["imported"]:
                target.library_person_id = entry["id"]
                target.resume_ocr_status = "completed"
                target.resume_ocr_at = now()
                audit(session, actor, "candidate_resume_ocr_completed", "candidate", candidate_id, f"简历解析完成，人员库编号 {entry['id']}")
            else:
                target.library_person_id = entry["id"] if entry else None
                target.resume_ocr_status = "failed"
                target.resume_ocr_error = (entry or {}).get("error_message", "简历解析未完成")[:400]
                target.resume_ocr_at = now()
                audit(session, actor, "candidate_resume_ocr_failed", "candidate", candidate_id, "简历解析未完成，原件已保留在人员库")
            session.commit()
            return {"status": target.resume_ocr_status, "message": target.resume_ocr_error,
                    "library_person_id": target.library_person_id}

    return background.submit("candidate_resume", ctx["user"], work, label=f"解析 {candidate.name} 的简历")


@router.get("/candidates/{candidate_id}/resume")
def download_candidate_resume(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require_any(ctx, "candidate:read", "report:read", "listening:use")
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    if candidate.library_person_id:
        try:
            entry = talent_library.get_entry(candidate.library_person_id)
        except KeyError:
            raise HTTPException(404, "人员库中未找到该人员的简历") from None
        path = Path(entry.get("original_path") or "")
        if not path.is_file():
            raise HTTPException(404, "简历原件缺失，请重新上传")
        name = entry["source_filename"]
    else:
        if not candidate.resume_path:
            raise HTTPException(404, "该候选人尚未上传简历")
        resume_root = (DATA_DIR / "resumes").resolve()
        path = (DATA_DIR / candidate.resume_path).resolve()
        if resume_root not in path.parents or not path.is_file():
            raise HTTPException(404, "简历文件不存在")
        name = candidate.resume_original_name or "resume.pdf"
    audit(db, ctx, "candidate_resume_viewed", "candidate", candidate.id, "查看候选人简历")
    db.commit()
    media = {".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8"}.get(
        path.suffix.lower(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return FileResponse(path, media_type=media, filename="resume" + path.suffix, headers={"X-Download-Name": _quoted(name)})


@router.delete("/candidates/{candidate_id}/resume")
def unlink_candidate_resume(candidate_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """取消候选人与简历的关联。人员库中的资料保留，可在人员库中统一管理。"""
    require(ctx, "candidate:edit")
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(404, "候选人不存在")
    interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate_id))
    if interview and interview.status != "consent_pending":
        raise HTTPException(409, "面试已开始，不能移除简历")
    if listening_started(db, candidate_id):
        raise HTTPException(409, "已有旁听记录，不能移除简历")
    if not candidate.library_person_id and not candidate.resume_path:
        raise HTTPException(404, "该候选人尚未上传简历")
    if candidate.resume_path:
        resume_path = (DATA_DIR / candidate.resume_path).resolve()
        if (DATA_DIR / "resumes").resolve() in resume_path.parents and resume_path.is_file():
            resume_path.unlink()
    original = candidate.resume_original_name
    candidate.library_person_id = None
    candidate.resume_path = ""
    candidate.resume_original_name = ""
    candidate.resume_size = 0
    candidate.resume_uploaded_at = None
    candidate.resume_ocr_status = "not_requested"
    candidate.resume_ocr_text = ""
    candidate.resume_ocr_error = ""
    candidate.resume_ocr_at = None
    audit(db, ctx, "candidate_resume_deleted", "candidate", candidate.id, f"移除简历 {original}")
    db.commit()
    return {"ok": True}


def _quoted(name: str) -> str:
    from urllib.parse import quote
    return quote(name)
