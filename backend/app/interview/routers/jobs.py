"""面试侧读取岗位：岗位资料在岗位库维护，这里只提供面试使用的视图和补充材料上传。"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core.database import DATA_DIR, get_db
from ...core.deps import actor_context, audit, require
from ...library.jobs import ensure_interview_job
from .. import ocr_service
from ..common import loads, now
from ..models import EvaluationDimension, Job, JobMaterial

router = APIRouter(prefix="/api", tags=["AI面试·岗位"])


def material_view(material: JobMaterial) -> dict:
    return {"id": material.id, "original_name": material.original_name, "size": material.size,
            "ocr_status": material.ocr_status, "ocr_provider": material.ocr_provider,
            "ocr_text_preview": material.ocr_text[:240] if material.ocr_text else "", "ocr_at": material.ocr_at}


@router.get("/jobs")
def list_jobs(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """已配置面试评价标准的岗位，供批次、报告、对比等页面筛选。"""
    require(ctx, "job:read")
    return [{
        "id": j.id, "code": j.code, "name": j.name, "library_job_id": j.library_job_id,
        "duties": j.duties, "requirements": j.requirements, "professional_requirements": j.professional_requirements,
        "competency_model": loads(j.competency_model, []), "material_version": j.material_version,
        "audit_status": j.audit_status, "updated_at": j.updated_at,
    } for j in db.scalars(select(Job).order_by(Job.id)).all()]


@router.get("/dimensions")
def list_dimensions(ctx=Depends(actor_context), db: Session = Depends(get_db)):
    if ctx["role"] != "candidate":
        require(ctx, "job:read")
    rows = db.scalars(select(EvaluationDimension).order_by(EvaluationDimension.id)).all()
    return [{"id": d.id, "name": d.name, "definition": d.definition, "weight": d.weight,
             "rubric": loads(d.rubric, {})} for d in rows]


@router.post("/library/jobs/{library_job_id}/materials")
async def upload_job_material(library_job_id: str, file: UploadFile = File(...), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """上传岗位补充资料（PDF），识别出的文字用于面试出题和评价参考。"""
    require(ctx, "job:edit")
    job = ensure_interview_job(db, library_job_id)
    original_name = Path(file.filename or "job-material.pdf").name
    if not original_name.lower().endswith(".pdf"):
        raise HTTPException(422, "岗位资料目前只支持 PDF")
    data = await file.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "岗位资料不能超过 20MB")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "文件内容不是有效的 PDF")
    material_dir = DATA_DIR / "job-materials"
    material_dir.mkdir(parents=True, exist_ok=True)
    stored_path = material_dir / f"job-{job.id}-{uuid.uuid4().hex}.pdf"
    stored_path.write_bytes(data)
    material = JobMaterial(job_id=job.id, original_name=original_name[:255],
                           stored_path=str(stored_path.relative_to(DATA_DIR)), size=len(data),
                           ocr_status="processing", ocr_provider="paddleocr")
    db.add(material)
    db.flush()
    audit(db, ctx, "job_material_uploaded", "job_material", material.id, f"上传岗位资料 {original_name}")
    db.commit()
    try:
        extracted = await asyncio.to_thread(ocr_service.parse_document, stored_path, 0)
        material.ocr_status = "completed"
        material.ocr_text = extracted["text"]
        material.ocr_at = now()
        audit(db, ctx, "job_material_ocr_completed", "job_material", material.id, "PaddleOCR完成岗位资料抽取")
    except Exception as exc:
        material.ocr_status = "failed"
        material.ocr_error = f"{type(exc).__name__}: {str(exc)[:400]}"
        material.ocr_at = now()
        audit(db, ctx, "job_material_ocr_failed", "job_material", material.id, "PaddleOCR未完成，原始岗位资料仍已保存")
    db.commit()
    return {**material_view(material), "ocr_error": material.ocr_error}


@router.delete("/library/jobs/{library_job_id}/materials/{material_id}")
def delete_job_material(library_job_id: str, material_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "job:edit")
    job = db.scalar(select(Job).where(Job.library_job_id == library_job_id))
    material = db.scalar(select(JobMaterial).where(JobMaterial.id == material_id, JobMaterial.job_id == (job.id if job else -1)))
    if not material:
        raise HTTPException(404, "岗位资料不存在")
    stored_path = (DATA_DIR / material.stored_path).resolve()
    material_root = (DATA_DIR / "job-materials").resolve()
    original_name = material.original_name
    db.delete(material)
    audit(db, ctx, "job_material_deleted", "job_material", material_id, f"删除岗位资料 {original_name}")
    db.commit()
    if material_root in stored_path.parents and stored_path.is_file():
        stored_path.unlink()
    return {"ok": True}
