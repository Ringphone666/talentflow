"""岗位库：两个业务模块共用的岗位资料。

岗位说明、硬性条件、能力标签与权重保存在人岗匹配核心的 jobs 表；
面试评价标准（六维行为要求与评分锚点）是岗位的补充材料，保存在面试库的 jobs 表并通过
``library_job_id`` 关联。业务页面只面对“岗位库”一个入口。
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from matching_core.config import DATA_DIR as MATCHING_DATA_DIR
from matching_core.services import workflow
from matching_core.services.job_scorecard import generate_job_scorecard

from ..core import background
from ..core.database import get_db
from ..core.deps import actor_context, audit, matching_operator, require
from ..interview.models import Batch, Candidate, EvaluationDimension, Job, JobMaterial
from ..interview.text_models import generate_scoring_advice

router = APIRouter(prefix="/api/library", tags=["岗位库"])

JD_UPLOAD_DIR = MATCHING_DATA_DIR / "uploads" / "job_descriptions"
JD_TYPES = {".pdf", ".docx", ".txt"}
MAX_JD_BYTES = 20 * 1024 * 1024
DEFAULT_LEVELS = {"1": "缺少相关证据", "3": "能够完成基本要求", "5": "能够稳定完成并形成可复用方法"}


class DimensionPayload(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    keywords: list[str] = Field(default_factory=list, max_length=32)
    negative_keywords: list[str] = Field(default_factory=list, max_length=32)


class JobPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sequence: str = Field(min_length=1, max_length=120)
    level: str = Field(min_length=1, max_length=60)
    jd_version: str = Field(default="", max_length=60)
    responsibilities: list[str] = Field(min_length=1)
    requirements: list[str] = Field(min_length=1)
    hard_conditions: list[str] = Field(default_factory=list)
    dimensions: list[DimensionPayload] = Field(min_length=1, max_length=12)
    weights: dict[str, float]
    scope: str = Field(default="", max_length=500)
    extra_sections: dict[str, str] = Field(default_factory=dict)
    # 同名岗位覆盖需要再次确认：首次提交返回 409 和版本指纹，确认后带回。
    overwrite_job_id: str | None = None
    overwrite_revision: str | None = None


class InterviewStandardPayload(BaseModel):
    professional_requirements: str = Field(default="", max_length=12000)
    competency_model: list[dict] = Field(min_length=1, max_length=20)
    material_version: str = Field(min_length=1, max_length=32)
    audit_status: str = Field(pattern="^(draft|approved)$")


def business_error(error: Exception) -> HTTPException:
    if isinstance(error, HTTPException):
        return error
    if isinstance(error, PermissionError):
        return HTTPException(403, str(error))
    if isinstance(error, KeyError):
        return HTTPException(404, str(error.args[0]) if error.args else "记录不存在")
    if isinstance(error, workflow.JobNameConflict):
        return HTTPException(409, {"message": str(error), "conflict": {
            "job_id": error.job["id"], "name": error.job["name"], "revision": error.revision}})
    if isinstance(error, ValueError):
        return HTTPException(422, str(error))
    raise error


def lines(value: str | list[str]) -> str:
    return "\n".join(value) if isinstance(value, list) else str(value or "")


def default_competency_model(db: Session) -> list[dict]:
    rows = db.scalars(select(EvaluationDimension).order_by(EvaluationDimension.id)).all()
    return [{"dimension": item.name, "behavior": item.definition, "levels": dict(DEFAULT_LEVELS)} for item in rows]


def interview_job_for(db: Session, library_job_id: str) -> Job | None:
    return db.scalar(select(Job).where(Job.library_job_id == library_job_id))


def sync_interview_job(db: Session, job: dict, interview_job: Job) -> None:
    """岗位说明以岗位库为准，面试侧只读引用。"""
    interview_job.name = job["name"][:120]
    interview_job.duties = lines(job["responsibilities"])
    hard = [item["name"] for item in job["hard_conditions"]]
    interview_job.requirements = lines(job["requirements"]) + ("\n岗位硬性条件：\n" + "\n".join(hard) if hard else "")


def ensure_interview_job(db: Session, library_job_id: str) -> Job:
    """取得岗位对应的面试评价标准记录；没有时按六维默认标准建立草稿。"""
    try:
        job = workflow.get_job(library_job_id)
    except KeyError:
        raise HTTPException(404, "岗位不存在，请在岗位库中确认") from None
    if not job["is_active"]:
        raise HTTPException(409, "该岗位已删除，请先在岗位库恢复")
    interview_job = interview_job_for(db, library_job_id)
    if interview_job:
        return interview_job
    code = library_job_id[:32]
    if db.scalar(select(Job.id).where(Job.code == code)):
        code = f"{library_job_id[:23]}-{uuid.uuid4().hex[:8]}"
    interview_job = Job(
        library_job_id=library_job_id, code=code, name=job["name"][:120], duties="", requirements="",
        professional_requirements="；".join(item["name"] for item in job["dimensions"]),
        competency_model=json.dumps(default_competency_model(db), ensure_ascii=False),
        material_version=(job["jd_version"] or "v1.0")[:32], audit_status="draft",
    )
    sync_interview_job(db, job, interview_job)
    db.add(interview_job)
    db.flush()
    return interview_job


def interview_standard(db: Session, interview_job: Job | None) -> dict:
    if not interview_job:
        return {"configured": False, "interview_job_id": None, "audit_status": "not_configured",
                "material_version": "", "professional_requirements": "", "competency_model": [],
                "materials": [], "batch_count": 0}
    materials = db.scalars(select(JobMaterial).where(JobMaterial.job_id == interview_job.id).order_by(JobMaterial.id)).all()
    try:
        model = json.loads(interview_job.competency_model)
    except (TypeError, json.JSONDecodeError):
        model = []
    return {
        "configured": True, "interview_job_id": interview_job.id, "code": interview_job.code,
        "audit_status": interview_job.audit_status, "material_version": interview_job.material_version,
        "professional_requirements": interview_job.professional_requirements, "competency_model": model,
        "materials": [{"id": m.id, "original_name": m.original_name, "size": m.size, "ocr_status": m.ocr_status,
                       "ocr_text_preview": m.ocr_text[:240] if m.ocr_text else "", "ocr_at": m.ocr_at} for m in materials],
        "batch_count": db.scalar(select(func.count(Batch.id)).where(Batch.job_id == interview_job.id)) or 0,
        "updated_at": interview_job.updated_at,
    }


def job_view(db: Session, job: dict, usage: dict[str, int] | None = None, *, detail: bool = False) -> dict:
    interview_job = interview_job_for(db, job["id"])
    standard = interview_standard(db, interview_job)
    view = {
        "id": job["id"], "name": job["name"], "sequence": job["sequence"], "level": job["level"],
        "jd_version": job["jd_version"], "weight_version": job["weight_version"], "scope": job["scope"],
        "is_active": bool(job["is_active"]), "updated_at": job["updated_at"],
        "dimension_count": len(job["dimensions"]), "hard_condition_count": len(job["hard_conditions"]),
        "matching_task_count": (usage or {}).get(job["id"], 0),
        "interview": {key: standard[key] for key in ("configured", "interview_job_id", "audit_status", "batch_count")},
    }
    if detail:
        view.update(
            responsibilities=job["responsibilities"], requirements=job["requirements"],
            hard_conditions=[item["name"] for item in job["hard_conditions"]],
            dimensions=[{"name": item["name"], "keywords": item.get("keywords", []),
                         "negative_keywords": item.get("negative_keywords", []),
                         "weight": job["weights"].get(item["name"], 0)} for item in job["dimensions"]],
            weights=job["weights"], extra_sections=job["extra_sections"], interview_standard=standard,
        )
    return view


def matching_usage() -> dict[str, int]:
    usage: dict[str, int] = {}
    for task in workflow.get_tasks():
        for job_id in task["job_ids"]:
            usage[job_id] = usage.get(job_id, 0) + 1
    return usage


@router.get("/jobs")
def list_jobs(include_archived: bool = False, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:read")
    usage = matching_usage()
    jobs = workflow.get_jobs(include_inactive=include_archived)
    return [job_view(db, job, usage) for job in sorted(jobs, key=lambda item: item["updated_at"], reverse=True)]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:read")
    try:
        job = workflow.get_job(job_id)
    except KeyError as error:
        raise business_error(error) from None
    return job_view(db, job, matching_usage(), detail=True)


def job_arguments(body: JobPayload) -> dict:
    return dict(
        name=body.name, sequence=body.sequence, level=body.level, jd_version=body.jd_version,
        responsibilities=body.responsibilities, requirements=body.requirements,
        hard_conditions=body.hard_conditions,
        dimensions=[item.model_dump() for item in body.dimensions], weights=body.weights,
        scope=body.scope, extra_sections=body.extra_sections,
    )


@router.post("/jobs")
def create_job(body: JobPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:edit")
    operator = matching_operator(ctx)
    try:
        job_id = workflow.create_job(**job_arguments(body), operator=operator,
                                     overwrite_job_id=body.overwrite_job_id, overwrite_revision=body.overwrite_revision)
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    job = workflow.get_job(job_id)
    linked = interview_job_for(db, job_id)
    if linked:
        sync_interview_job(db, job, linked)
    audit(db, ctx, "library_job_saved", "job", job_id, f"{'覆盖' if body.overwrite_job_id else '新增'}岗位 {job['name']}")
    db.commit()
    return job_view(db, job, detail=True)


@router.put("/jobs/{job_id}")
def update_job(job_id: str, body: JobPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """保存岗位说明和能力标签。影响评分的改动会把已有匹配结果标记为“需重新分析”。"""
    require(ctx, "job:edit")
    operator = matching_operator(ctx)
    dimensions = [item.model_dump() for item in body.dimensions]
    try:
        before = workflow.get_job(job_id)
        # 先校验能力标签和权重；岗位说明的校验在写库之前完成。任何一项不通过，岗位都保持原样。
        workflow.normalize_scorecard(dimensions, body.weights)
        workflow.update_job_profile(
            job_id, body.name, body.sequence, body.level, body.jd_version, body.responsibilities,
            body.requirements, body.hard_conditions, body.scope, operator, extra_sections=body.extra_sections)
        scorecard = workflow.update_job_scorecard(job_id, dimensions, body.weights, operator)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    job = workflow.get_job(job_id)
    linked = interview_job_for(db, job_id)
    if linked:
        sync_interview_job(db, job, linked)
    audit(db, ctx, "library_job_saved", "job", job_id, f"修改岗位 {job['name']}")
    db.commit()
    # 岗位名称、职责、要求、硬性条件的改动同样会让已有匹配结果需要重新分析。
    changed = [key for key in ("name", "responsibilities", "requirements", "hard_conditions") if before[key] != job[key]]
    return {**job_view(db, job, matching_usage(), detail=True), "scorecard_change": scorecard,
            "profile_change": {"changed": bool(changed), "fields": changed}}


@router.post("/jobs/{job_id}/archive")
def archive_job(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:edit")
    linked = interview_job_for(db, job_id)
    if linked and db.scalar(select(Batch.id).where(Batch.job_id == linked.id, Batch.status != "closed").limit(1)):
        active = db.scalar(select(func.count(Candidate.id)).where(Candidate.job_id == linked.id)) or 0
        if active:
            raise HTTPException(409, "该岗位已有面试批次和候选人，删除后将无法新建任务；如确需停用，请先处理相关批次")
    try:
        workflow.archive_job(job_id, matching_operator(ctx))
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    audit(db, ctx, "library_job_archived", "job", job_id, "岗位移入已删除")
    db.commit()
    return {"ok": True}


@router.post("/jobs/{job_id}/restore")
def restore_job(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:edit")
    try:
        workflow.restore_job(job_id, matching_operator(ctx))
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    audit(db, ctx, "library_job_restored", "job", job_id, "恢复岗位")
    db.commit()
    return {"ok": True}


@router.delete("/jobs/{job_id}")
def purge_job(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """彻底删除已停用岗位及其匹配任务历史。有面试批次的岗位不允许彻底删除。"""
    require(ctx, "job:edit")
    try:
        workflow.get_job(job_id)
    except KeyError as error:
        raise business_error(error) from None
    linked = interview_job_for(db, job_id)
    if linked and (db.scalar(select(Batch.id).where(Batch.job_id == linked.id).limit(1))
                   or db.scalar(select(Candidate.id).where(Candidate.job_id == linked.id).limit(1))):
        raise HTTPException(409, "该岗位已关联面试批次或候选人，不能彻底删除")
    try:
        workflow.permanently_delete_job(job_id, matching_operator(ctx))
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    if linked:
        for material in db.scalars(select(JobMaterial).where(JobMaterial.job_id == linked.id)).all():
            db.delete(material)
        db.delete(linked)
    audit(db, ctx, "library_job_purged", "job", job_id, "彻底删除岗位及其匹配任务历史")
    db.commit()
    return {"ok": True}


def safe_upload_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(name or "").name).strip() or "岗位说明书"
    return cleaned[-120:]


@router.post("/jobs/import")
async def import_job_descriptions(
    files: list[UploadFile] = File(...),
    reference_job_id: str = Form(default=""),
    ctx=Depends(actor_context),
):
    """解析岗位说明书，识别岗位职责、任职要求、硬性条件和能力标签，返回待核对草稿（不直接入库）。"""
    require(ctx, "job:edit")
    matching_operator(ctx)
    if not 1 <= len(files) <= 10:
        raise HTTPException(422, "每次请上传 1 至 10 份岗位说明书")
    JD_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    staged: list[tuple[str, Path]] = []
    for upload in files:
        name = safe_upload_name(upload.filename or "")
        if Path(name).suffix.lower() not in JD_TYPES:
            raise HTTPException(422, f"{name}：请上传 PDF、Word（.docx）或 TXT 文件")
        data = await upload.read(MAX_JD_BYTES + 1)
        if len(data) > MAX_JD_BYTES:
            raise HTTPException(413, f"{name}：岗位说明书不能超过 20MB")
        path = JD_UPLOAD_DIR / f"{uuid.uuid4().hex[:8]}_{name}"
        path.write_bytes(data)
        staged.append((name, path))
    reference = reference_job_id.strip() or None

    def work(progress):
        drafts = []
        for index, (name, path) in enumerate(staged, start=1):
            progress(f"正在识别第 {index}/{len(staged)} 份：{name}")
            try:
                for item in workflow.prepare_job_imports(path, reference):
                    draft = item.get("draft")
                    drafts.append({"source_file": name, "index": item["index"], "error": item.get("error", ""),
                                   "draft": None if not draft else {
                                       key: draft[key] for key in (
                                           "name", "sequence", "level", "jd_version", "responsibilities", "requirements",
                                           "hard_conditions", "dimensions", "weights", "scope", "extra_sections",
                                           "warning", "model_source", "scorecard_basis", "scorecard_error")}})
            except (ValueError, KeyError) as error:
                drafts.append({"source_file": name, "index": 1, "error": str(error), "draft": None})
        return {"drafts": drafts}

    return background.submit("job_import", ctx["user"], work, label=f"识别 {len(staged)} 份岗位说明书")


@router.post("/jobs/scorecard-suggestion")
async def scorecard_suggestion(body: dict, ctx=Depends(actor_context)):
    """根据岗位职责和任职要求生成能力标签与权重建议，仅返回建议，不改动岗位。"""
    require(ctx, "job:edit")
    job = {key: body.get(key) or ([] if key != "name" and key != "weights" else ({} if key == "weights" else ""))
           for key in ("name", "responsibilities", "requirements", "dimensions", "weights")}
    try:
        return await asyncio.to_thread(generate_job_scorecard, job)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.get("/jobs/{job_id}/capability-tags")
def capability_tags(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """岗位能力标签的结构化输出，供业务系统存储和做横向对比（数据回流）。"""
    require(ctx, "job:read")
    try:
        job = workflow.get_job(job_id)
    except KeyError as error:
        raise business_error(error) from None
    audit(db, ctx, "capability_tags_exported", "job", job_id, "输出岗位能力标签")
    db.commit()
    return {
        "job_id": job["id"], "job_name": job["name"], "sequence": job["sequence"], "level": job["level"],
        "jd_version": job["jd_version"], "weight_version": job["weight_version"], "updated_at": job["updated_at"],
        "required_tags": [{"name": item["name"], "type": "硬性条件"} for item in job["hard_conditions"]],
        "capability_tags": [{"name": item["name"], "weight": job["weights"].get(item["name"], 0),
                             "keywords": item.get("keywords", [])} for item in job["dimensions"]],
        "source": job["scope"],
        "notice": "能力标签由AI根据岗位说明书识别并经人工维护，仅供业务参考。",
    }


# ---- 面试评价标准（岗位的补充材料） ------------------------------------------------

@router.get("/jobs/{job_id}/interview-standard")
def get_interview_standard(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:read")
    try:
        workflow.get_job(job_id)
    except KeyError as error:
        raise business_error(error) from None
    return {**interview_standard(db, interview_job_for(db, job_id)), "default_model": default_competency_model(db)}


@router.put("/jobs/{job_id}/interview-standard")
def save_interview_standard(job_id: str, body: InterviewStandardPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:edit")
    names = {item.name for item in db.scalars(select(EvaluationDimension)).all()}
    seen = set()
    for item in body.competency_model:
        dimension = str(item.get("dimension", "")).strip()
        levels = item.get("levels") or {}
        if dimension not in names:
            raise HTTPException(422, f"评价维度“{dimension or '未填写'}”不在六维评价体系内")
        if dimension in seen:
            raise HTTPException(422, f"评价维度“{dimension}”重复")
        seen.add(dimension)
        if not str(item.get("behavior", "")).strip():
            raise HTTPException(422, f"请填写“{dimension}”的考察要求")
        if any(not str(levels.get(score, "")).strip() for score in ("1", "3", "5")):
            raise HTTPException(422, f"请填写“{dimension}”的 1、3、5 分评分描述")
    interview_job = ensure_interview_job(db, job_id)
    interview_job.professional_requirements = body.professional_requirements.strip()
    interview_job.competency_model = json.dumps(body.competency_model, ensure_ascii=False)
    interview_job.material_version = body.material_version.strip()
    interview_job.audit_status = body.audit_status
    audit(db, ctx, "job_material_updated", "job", interview_job.id, f"面试评价标准版本 {body.material_version}")
    db.commit()
    return interview_standard(db, interview_job)


@router.post("/jobs/{job_id}/interview-standard/advice")
async def interview_standard_advice(job_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """根据岗位资料生成六维评分标准建议；建议须人工确认后保存。"""
    require(ctx, "job:edit")
    interview_job = ensure_interview_job(db, job_id)
    db.commit()
    try:
        model = json.loads(interview_job.competency_model)
    except (TypeError, json.JSONDecodeError):
        model = []
    payload = {
        "id": interview_job.id, "code": interview_job.code, "name": interview_job.name,
        "duties": interview_job.duties, "requirements": interview_job.requirements,
        "professional_requirements": interview_job.professional_requirements, "competency_model": model,
        "material_version": interview_job.material_version,
        "materials_text": "\n\n".join(m.ocr_text for m in db.scalars(select(JobMaterial).where(
            JobMaterial.job_id == interview_job.id, JobMaterial.ocr_status == "completed")).all()),
    }
    advice = await asyncio.to_thread(generate_scoring_advice, payload)
    audit(db, ctx, "job_scoring_advice_generated", "job", interview_job.id, f"岗位 {interview_job.code} 生成面试评分标准建议")
    db.commit()
    return advice


@router.get("/operations/{job_id}")
def operation_status(job_id: str, ctx=Depends(actor_context)):
    """查询耗时处理（岗位说明书识别、人员导入等）的进度。"""
    return background.get(job_id, ctx["user"])
