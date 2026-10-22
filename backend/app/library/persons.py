"""人员库：按批次管理人员简历资料，人岗匹配和AI面试共用。"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from matching_core.services import batches as matching_batches
from matching_core.services import talent_library, workflow
from matching_core.services.material_review import MATERIAL_FIELD_LABELS, effective_material_evidence
from matching_core.services.scoring import assessment_summary_data, score_value

from ..core import background
from ..core.database import get_db
from ..core.deps import actor_context, allowed, audit, matching_operator, require
from ..interview.models import Batch as InterviewBatch, Candidate, Interview, Report
from . import uploads
from .jobs import business_error
from .profile import person_profile

router = APIRouter(prefix="/api/library", tags=["人员库"])

# 新建批次时可选的分类；“未分类”只用于历史数据。
SELECTABLE_CATEGORIES = ("社招", "校招", "内聘")


class BatchPayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    category: str


class BatchDelete(BaseModel):
    batch_ids: list[str] = Field(min_length=1, max_length=50)


class MaterialPayload(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)
    full_name: str | None = Field(default=None, max_length=100)
    confirmed: bool = False
    expected_material_version: int | None = None


SUMMARY_LENGTH = 120


def import_limit() -> int:
    """一次导入的简历份数上限：单个匹配任务人数上限的 5 倍。"""
    return workflow.MAX_TASK_PEOPLE * 5


def batch_view(batch: dict) -> dict:
    total = batch.get("total_count") or 0
    parsed = batch.get("parsed_count") or 0
    failed = batch.get("failed_count") or 0
    return {"id": batch["id"], "name": batch["name"], "category": batch["category"],
            "created_by": batch.get("operator", ""), "created_at": batch["created_at"], "updated_at": batch["updated_at"],
            "total_count": total, "parsed_count": parsed, "failed_count": failed,
            "pending_count": max(0, total - parsed - failed)}


def person_row(entry: dict) -> dict:
    profile = person_profile(entry)
    summary = {item["key"]: item["value"] for item in profile["fields"]}
    return {"id": entry["id"], "batch_id": entry["batch_id"], "name": entry["full_name"],
            "source_filename": entry["source_filename"], "status": entry["status"],
            "parse_status": entry["parse_status"], "confirmed": profile["confirmed"],
            "error_message": entry.get("error_message", ""), "created_at": entry["created_at"],
            "updated_at": entry["updated_at"], "material_version": entry["material_version"],
            # 列表只放摘要，完整内容在人员详情中；被截短时明确告诉页面。
            "education": summary.get("education", "")[:SUMMARY_LENGTH],
            "work_experience": summary.get("work_experience", "")[:SUMMARY_LENGTH],
            "education_truncated": len(summary.get("education", "")) > SUMMARY_LENGTH,
            "work_experience_truncated": len(summary.get("work_experience", "")) > SUMMARY_LENGTH}


@router.get("/person-categories")
def person_categories(ctx=Depends(actor_context)):
    require(ctx, "person:read")
    return {"selectable": list(SELECTABLE_CATEGORIES), "all": list(talent_library.CATEGORIES),
            "import_limit": import_limit()}


@router.get("/person-batches")
def list_person_batches(ctx=Depends(actor_context)):
    require(ctx, "person:read")
    return [batch_view(item) for item in talent_library.list_batches()]


@router.post("/person-batches")
def create_person_batch(body: BatchPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "person:edit")
    if body.category not in SELECTABLE_CATEGORIES:
        raise HTTPException(422, "请选择社招、校招或内聘")
    try:
        batch_id = talent_library.create_batch(body.name, body.category, matching_operator(ctx))
    except (ValueError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "person_batch_created", "person_batch", batch_id, f"{body.category} · {body.name.strip()}")
    db.commit()
    return batch_view(talent_library.get_batch(batch_id))


@router.put("/person-batches/{batch_id}")
def update_person_batch(batch_id: str, body: BatchPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "person:edit")
    try:
        current = talent_library.get_batch(batch_id)
        # “未分类”只属于历史数据：原来就是未分类的批次可以保持，不能把其他批次改成未分类。
        if body.category not in SELECTABLE_CATEGORIES and body.category != current["category"]:
            raise HTTPException(422, "请选择社招、校招或内聘")
        batch = talent_library.update_batch(batch_id, body.name, body.category, matching_operator(ctx))
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "person_batch_updated", "person_batch", batch_id, f"{body.category} · {body.name.strip()}")
    db.commit()
    return batch_view(batch)


@router.post("/person-batches/delete")
def delete_person_batches(body: BatchDelete, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "person:edit")
    linked = db.scalar(select(Candidate.id).where(Candidate.library_person_id.in_(
        [entry["id"] for batch_id in body.batch_ids for entry in talent_library.list_entries(batch_id)])).limit(1))
    if linked:
        raise HTTPException(409, "所选批次中有人员已关联AI面试候选人，不能删除；已建立的匹配任务和面试记录需要这些资料")
    try:
        result = talent_library.delete_batches(body.batch_ids, matching_operator(ctx))
    except (ValueError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "person_batch_deleted", "person_batch", ",".join(body.batch_ids),
          f"删除 {result['deleted_batches']} 个批次、{result['deleted_entries']} 份人员资料")
    db.commit()
    return result


@router.get("/person-batches/{batch_id}")
def get_person_batch(batch_id: str, ctx=Depends(actor_context)):
    require(ctx, "person:read")
    try:
        batch = talent_library.get_batch(batch_id)
    except KeyError as error:
        raise business_error(error) from None
    return {**batch_view(batch), "persons": [person_row(entry) for entry in talent_library.list_entries(batch_id)]}


@router.post("/uploads/preflight")
async def preflight(files: list[UploadFile] = File(...), ctx=Depends(actor_context)):
    """上传前检查：文件是否可用、哪些扫描页需要文字识别（需授权后才会发送到识别服务）。"""
    require(ctx, "person:edit")
    loaded = await uploads.read_uploads(files)
    return uploads.scan_report(loaded)


@router.post("/person-batches/{batch_id}/import")
async def import_persons(
    batch_id: str,
    files: list[UploadFile] = File(...),
    minutes: list[UploadFile] = File(default=[]),
    minute_assignments: str = Form(default=""),
    allow_ocr: bool = Form(default=False),
    ctx=Depends(actor_context),
    db: Session = Depends(get_db),
):
    """导入简历（可附带每人一份面试纪要或补充材料）。解析在后台进行，返回可轮询的处理编号。"""
    require(ctx, "person:edit")
    operator = matching_operator(ctx)
    try:
        batch = talent_library.get_batch(batch_id)
    except KeyError as error:
        raise business_error(error) from None
    limit = import_limit()
    if not 1 <= len(files) <= limit:
        raise HTTPException(422, f"每次请上传 1 至 {limit} 份简历")
    resumes = await uploads.read_uploads(files)
    attachments = await uploads.read_uploads(minutes, label="面试纪要或补充材料") if minutes else []
    report = uploads.scan_report(resumes + attachments)
    if report["errors"]:
        raise HTTPException(422, "；".join(report["errors"]))
    if report["scans"] and not allow_ocr:
        raise HTTPException(409, {"message": "文件包含扫描页，需确认已获识别服务处理授权后才能导入", "scans": report["scans"]})
    folder, resume_paths, minutes_map = uploads.stage(resumes, attachments, uploads.parse_assignments(minute_assignments))
    audit(db, ctx, "person_import_started", "person_batch", batch_id,
          f"导入 {len(resume_paths)} 份简历、{len(minutes_map)} 份附加材料；扫描页识别授权：{'是' if allow_ocr else '否'}")
    db.commit()

    def work(progress):
        try:
            result = talent_library.import_files(batch_id, resume_paths, operator, allow_ocr=allow_ocr,
                                                 minutes_map=minutes_map, progress=progress)
        finally:
            uploads.discard(folder)
        return {"batch_id": batch_id, "batch_name": batch["name"],
                "imported": [person_row(item) for item in result["imported"]],
                "failed": [person_row(item) for item in result["failed"]]}

    return background.submit("person_import", ctx["user"], work, label=f"导入 {len(resume_paths)} 份简历")


def interview_records(db: Session, person_id: str) -> list[dict]:
    records = []
    for candidate in db.scalars(select(Candidate).where(Candidate.library_person_id == person_id)).all():
        interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
        report = db.scalar(select(Report).where(Report.candidate_id == candidate.id))
        batch = db.get(InterviewBatch, candidate.batch_id)
        records.append({"candidate_id": candidate.id, "candidate_code": candidate.code,
                        "batch_name": batch.name if batch else "", "job_name": batch.job.name if batch else "",
                        "interview_status": interview.status if interview else "not_created",
                        "report_status": report.status if report else "not_generated",
                        "match_score": report.match_score if report and report.current_version else None})
    return records


def match_history(person_id: str) -> list[dict]:
    jobs = {job["id"]: job for job in workflow.get_jobs(include_inactive=True)}
    history = []
    for candidate in workflow.get_talent_match_history(person_id):
        job = jobs.get(candidate["job_id"])
        summary = assessment_summary_data(candidate["score"], job)
        history.append({"task_id": candidate["task_id"], "task_name": candidate["task_name"],
                        "mode": "people_to_jobs" if candidate["task_mode"] == "人找岗位" else "job_to_people",
                        "candidate_id": candidate["id"], "job_name": job["name"] if job else "",
                        "total": score_value(candidate["score"]), "conclusion": summary["conclusion"],
                        "review_status": matching_batches.review_status(candidate),
                        "decision": candidate["decision"], "updated_at": candidate["updated_at"]})
    return history


@router.get("/persons/{person_id}")
def get_person(person_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "person:read")
    try:
        entry = talent_library.get_entry(person_id)
    except KeyError as error:
        raise business_error(error) from None
    evidence = [item for item in effective_material_evidence(entry["parsed"]) if item.get("text")]
    return {
        **person_row(entry), "profile": person_profile(entry),
        "editable_fields": [{"key": key, "label": "面试评价与纪要" if key == "interview_evaluation" else label}
                            for key, label in MATERIAL_FIELD_LABELS.items()],
        "warning": entry["parsed"].get("warning", ""),
        "evidence": [{"text": item["text"], "file": item.get("file", ""), "location": item.get("location", ""),
                      "origin": item.get("origin", "")} for item in evidence[:400]],
        "evidence_total": len(evidence),
        "can_edit": allowed(ctx, "matching:review") or allowed(ctx, "person:edit"),
        "matching_history": match_history(person_id),
        "interviews": interview_records(db, person_id),
    }


@router.put("/persons/{person_id}/material")
def update_person_material(person_id: str, body: MaterialPayload, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """修改或确认人员资料。已建立的匹配任务保留各自的资料快照，不受影响。"""
    if not (allowed(ctx, "matching:review") or allowed(ctx, "person:edit")):
        raise HTTPException(403, "当前角色无权修改人员资料")
    try:
        entry = talent_library.update_entry_material(
            person_id, body.fields, matching_operator(ctx), full_name=body.full_name, confirmed=body.confirmed,
            expected_material_version=body.expected_material_version)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "person_material_confirmed" if body.confirmed else "person_material_updated", "person", person_id,
          f"资料版本 {entry['material_version']}")
    db.commit()
    return {**person_row(entry), "profile": person_profile(entry)}


@router.post("/persons/{person_id}/retry")
def retry_person(person_id: str, allow_ocr: bool = False, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "person:edit")
    operator = matching_operator(ctx)
    try:
        talent_library.get_entry(person_id)
    except KeyError as error:
        raise business_error(error) from None

    def work(progress):
        progress("正在重新解析简历")
        return person_row(talent_library.retry_entry(person_id, operator, allow_ocr=allow_ocr))

    audit(db, ctx, "person_reparse_started", "person", person_id, "重新解析简历")
    db.commit()
    return background.submit("person_retry", ctx["user"], work, label="重新解析简历")


@router.get("/persons/{person_id}/file")
def person_file(person_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """查看人员的原始简历。原件含未脱敏个人信息，仅限有人员库权限的工作人员。"""
    require(ctx, "person:read")
    try:
        entry = talent_library.get_entry(person_id)
    except KeyError as error:
        raise business_error(error) from None
    path = Path(entry.get("original_path") or "")
    if not entry.get("original_path") or not path.is_file():
        raise HTTPException(404, "原始简历文件缺失，请重新导入")
    audit(db, ctx, "person_file_viewed", "person", person_id, "查看原始简历")
    db.commit()
    media = {".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8"}.get(
        path.suffix.lower(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return FileResponse(path, media_type=media, filename=entry["source_filename"])


@router.get("/person-batches/{batch_id}/export")
def export_persons(
    batch_id: str,
    kind: str = Query(pattern="^(resumes|profiles|csv)$"),
    ids: str = Query(default=""),
    ctx=Depends(actor_context),
    db: Session = Depends(get_db),
):
    require(ctx, "person:read")
    require(ctx, "matching:export")
    operator = matching_operator(ctx)
    try:
        entries = talent_library.list_entries(batch_id)
        batch = talent_library.get_batch(batch_id)
        selected = [value for value in ids.split(",") if value] or [entry["id"] for entry in entries]
        if kind == "csv":
            chosen = [entry for entry in entries if entry["id"] in set(selected)]
            records = [{"姓名": e["full_name"], "简历文件": e["source_filename"], "解析状态": e["status"],
                        "资料确认": "已确认" if e["parse_status"] == "人工已复核" else "待确认",
                        "导入时间": e["created_at"], "处理说明": e.get("error_message", "")} for e in chosen]
            audit(db, ctx, "person_list_exported", "person_batch", batch_id, f"导出 {len(records)} 人明细")
            db.commit()
            return Response(content=matching_batches.safe_csv(records), media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": 'attachment; filename="person-list.csv"',
                                     "X-Download-Name": _header_name(f"{batch['name']}_人员明细.csv")})
        exporter = talent_library.export_resumes if kind == "resumes" else talent_library.export_profiles
        path = exporter(batch_id, selected, operator)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "person_files_exported", "person_batch", batch_id,
          f"导出{'简历原件' if kind == 'resumes' else '简历资料报告'} {len(selected)} 份")
    db.commit()
    return FileResponse(path, filename=f"export{path.suffix}",
                        headers={"X-Download-Name": _header_name(path.name)})


def _header_name(name: str) -> str:
    """响应头只能是 ASCII；中文文件名做百分号编码，由前端还原。"""
    from urllib.parse import quote
    return quote(name)
