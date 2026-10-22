"""人岗匹配：岗位选才（岗找人）与人才适岗（人找岗）。

两种任务都从人员库取人：直接上传的简历先进入人员库，再参与匹配。任务在后台分析，
页面按任务查看排序、依据、人工复核和报告，业务侧关心的最终产出是匹配报告。
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from matching_core.services import batch_reports, batches, task_queue, workflow
from matching_core.services.auth import operator_name

from ..core.database import get_db
from ..core.deps import actor_context, allowed, audit, matching_operator, require
from ..library.jobs import business_error
from . import evidence
from .views import (DECISIONS, FIT_DECISIONS, MODE_LABELS, TASK_MODES, assessment_view, material_view, person_rows,
                    readiness, task_view)

router = APIRouter(prefix="/api/matching", tags=["人岗匹配"])
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


MAX_TASK_JOBS = 20


class TaskCreate(BaseModel):
    mode: str = Field(pattern="^(job_to_people|people_to_jobs)$")
    job_ids: list[str] = Field(min_length=1, max_length=MAX_TASK_JOBS)
    person_batch_id: str = Field(min_length=1)
    person_ids: list[str] = Field(min_length=1)
    name: str = Field(default="", max_length=100)


class MaterialUpdate(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)
    full_name: str | None = Field(default=None, max_length=100)
    confirmed: bool = False
    expected_material_version: int | None = None


class ReviewRequest(BaseModel):
    decision: str
    comment: str = Field(min_length=2, max_length=2000)
    # 复核人确认已核对本人资料和评分依据；资料未确认时随结论一并确认。
    material_checked: bool
    expected_material_version: int | None = None
    job_id: str | None = None


def download_headers(name: str) -> dict:
    return {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}", "X-Download-Name": quote(name)}


def snapshot_of(task_id: str) -> dict:
    try:
        return batches.batch_snapshot(task_id)
    except KeyError:
        raise HTTPException(404, "匹配任务不存在") from None


def ids_of(value: str) -> list[str]:
    return [item for item in (part.strip() for part in value.split(",")) if item]


@router.get("/options")
def options(ctx=Depends(actor_context)):
    require(ctx, "matching:view")
    return {
        "max_people": workflow.MAX_TASK_PEOPLE, "max_jobs": MAX_TASK_JOBS,
        "decisions": [{"value": "进入下一轮", "label": "通过 · 进入下一轮"}, {"value": "保留", "label": "保留 · 待进一步核验"},
                      {"value": "淘汰", "label": "未通过"}],
        "fit_decisions": [{"value": "推荐至该岗位", "label": "通过 · 推荐至该岗位"},
                          {"value": "作为备选岗位", "label": "保留 · 作为备选岗位"},
                          {"value": "暂不推荐", "label": "未通过 · 暂不推荐"}],
        "can_create": allowed(ctx, "matching:create"), "can_review": allowed(ctx, "matching:review"),
        "can_export": allowed(ctx, "matching:export"), "can_delete": allowed(ctx, "matching:delete"),
    }


@router.get("/tasks")
def list_tasks(mode: str | None = Query(default=None, pattern="^(job_to_people|people_to_jobs)$"),
               limit: int = Query(default=200, ge=1, le=500), ctx=Depends(actor_context)):
    require(ctx, "matching:view")
    jobs = {job["id"]: job for job in workflow.get_jobs(include_inactive=True)}
    result = []
    for task in workflow.get_tasks():
        if mode and task["task_mode"] != TASK_MODES[mode]:
            continue
        summary = None if task["status"] in ("待处理",) else batches.batch_snapshot(task["id"])["summary"]
        result.append(task_view(task, jobs, summary))
        if len(result) >= limit:
            break
    return result


@router.post("/tasks")
def create_task(body: TaskCreate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "matching:create")
    operator = matching_operator(ctx)
    fit = body.mode == "people_to_jobs"
    try:
        task_id = workflow.prepare_talent_task(body.job_ids, body.person_ids, body.person_batch_id, operator,
                                               fit=fit, batch_name=body.name)
        task_queue.enqueue_talent_task(task_id, list(dict.fromkeys(body.person_ids)), operator)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_task_created", "matching_task", task_id,
          f"{MODE_LABELS[body.mode]}：{len(set(body.person_ids))} 人 × {len(set(body.job_ids))} 个岗位")
    db.commit()
    jobs = {job["id"]: job for job in workflow.get_jobs(include_inactive=True)}
    task = next(item for item in workflow.get_tasks() if item["id"] == task_id)
    return task_view(task, jobs)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, ctx=Depends(actor_context)):
    require(ctx, "matching:view")
    snapshot = snapshot_of(task_id)
    jobs = snapshot["jobs"]
    view = task_view(snapshot["task"], jobs, snapshot["summary"])
    job_ids = [item["id"] for item in view["jobs"]]
    view["job_standards"] = [{
        "id": job_id, "name": jobs[job_id]["name"], "level": jobs[job_id]["level"], "sequence": jobs[job_id]["sequence"],
        "weight_version": jobs[job_id]["weight_version"],
        "dimensions": [{"name": name, "weight": weight} for name, weight in jobs[job_id]["weights"].items()],
        "hard_conditions": [item["name"] for item in jobs[job_id]["hard_conditions"]],
    } for job_id in job_ids if job_id in jobs]
    view["people"] = person_rows(snapshot)
    return view


@router.post("/tasks/{task_id}/retry")
def retry_task(task_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "matching:create")
    try:
        task_queue.enqueue_failed_retry(task_id, matching_operator(ctx))
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_task_retried", "matching_task", task_id, "重试未完成的解析与分析")
    db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/reanalyze")
def reanalyze_task(task_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """用已保存的材料和当前岗位标准重新分析；人工意见保留，分析后需再次核对。"""
    require(ctx, "matching:review")
    try:
        task_queue.enqueue_task_analysis(task_id, matching_operator(ctx))
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_task_reanalyzed", "matching_task", task_id, "重新分析本任务")
    db.commit()
    return {"ok": True}


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "matching:delete")
    try:
        workflow.delete_task(task_id, matching_operator(ctx))
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_task_deleted", "matching_task", task_id, "删除任务及其匹配结果、报告")
    db.commit()
    return {"ok": True}


def candidate_in_task(snapshot: dict, candidate_id: str) -> dict:
    candidate = next((item for item in snapshot["candidates"] if item["id"] == candidate_id), None)
    if not candidate:
        raise HTTPException(404, "该人员不在本任务中，请刷新列表")
    return candidate


@router.get("/tasks/{task_id}/candidates/{candidate_id}")
def get_candidate(task_id: str, candidate_id: str, ctx=Depends(actor_context)):
    require(ctx, "matching:view")
    snapshot = snapshot_of(task_id)
    candidate = candidate_in_task(snapshot, candidate_id)
    task, jobs = snapshot["task"], snapshot["jobs"]
    fit = task.get("task_mode") == "人找岗位"
    task_jobs = {job_id: jobs[job_id] for job_id in (task.get("job_ids") or [task["job_id"]]) if job_id in jobs}
    own = workflow.get_ranked_job_matches(candidate_id) if fit else []
    row = next((item for item in person_rows(snapshot) if item["candidate_id"] == candidate_id), {})
    subjects = own if fit else [candidate]
    return {
        "task": {"id": task["id"], "name": batches.batch_title(task, jobs), "mode": "people_to_jobs" if fit else "job_to_people",
                 "running": task["status"] in ("待处理", "处理中")},
        "candidate_id": candidate_id, "code": candidate["parsed"].get("candidate_code", candidate_id),
        "name": candidate["full_name"], "person_id": candidate.get("source_candidate_id") or "",
        "rank": row.get("rank"), "review_status": row.get("review_status"),
        "reviewer": operator_name(row.get("reviewer", "")), "reviewed_at": row.get("reviewed_at", ""),
        "material": material_view(candidate),
        "redaction": {"status": candidate["redaction_status"], "types": candidate["sensitive_types"]},
        "assessments": [{"job_id": subject["job_id"], "job_name": jobs.get(subject["job_id"], {}).get("name", ""),
                         "decision": subject.get("decision"), "review_comment": subject.get("review_comment", ""),
                         **assessment_view(subject["score"], jobs.get(subject["job_id"]))} for subject in subjects],
        "missing_jobs": [jobs[job_id]["name"] for job_id in task_jobs
                         if fit and job_id not in {m["job_id"] for m in own}],
        "report": readiness(candidate, own, task_jobs, fit),
        "reports": [{"id": item["id"], "file": Path(item["path"]).name, "generated_at": item["generated_at"],
                     "operator": operator_name(item["operator"])} for item in workflow.get_reports(candidate_id)],
        "evidence": [{"text": item.get("text", ""), "file": item.get("file", ""), "location": item.get("location", "")}
                     for item in (candidate["parsed"].get("raw_evidence") or [])
                     if item.get("text") and item.get("origin") != "human_review"][:400],
    }


@router.put("/candidates/{candidate_id}/material")
def update_material(candidate_id: str, body: MaterialUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """修改或确认本任务内的人员资料。内容有改动时，原评分和人工结论失效，需重新分析。"""
    require(ctx, "matching:review")
    try:
        candidate = workflow.update_candidate_material(
            candidate_id, body.fields, matching_operator(ctx), full_name=body.full_name, confirmed=body.confirmed,
            expected_material_version=body.expected_material_version)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_material_confirmed" if body.confirmed else "matching_material_updated",
          "matching_candidate", candidate_id, f"资料版本 {candidate['parsed'].get('material_version', 0)}")
    db.commit()
    return {"material": material_view(candidate),
            "requires_reanalysis": bool(candidate["score"].get("requires_reassessment")),
            "warning": candidate.get("material_snapshot_warning", "")}


@router.post("/candidates/{candidate_id}/review")
def save_review(candidate_id: str, body: ReviewRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """保存人工复核结论。一次提交完成三件事：确认已核对资料、填写复核意见、给出结论。"""
    require(ctx, "matching:review")
    operator = matching_operator(ctx)
    if not body.material_checked:
        raise HTTPException(422, "请先确认已核对本人资料和评分依据")
    try:
        candidate = workflow.get_candidate(candidate_id)
        task = next((item for item in workflow.get_tasks() if item["id"] == candidate["task_id"]), None)
        fit = bool(task and task.get("task_mode") == "人找岗位")
        if body.decision not in (FIT_DECISIONS if fit else DECISIONS):
            raise HTTPException(422, "请选择有效的复核结论")
        if fit and not body.job_id:
            raise HTTPException(422, "请选择要确认的岗位")
        # 先确认结论能够保存，再把资料记为已核对；否则被拒绝的复核也会改动资料状态。
        if task and task["status"] in ("待处理", "处理中"):
            raise ValueError("任务正在处理中，请等待完成后审核")
        if fit:
            match = next((item for item in workflow.get_candidate_job_matches(candidate_id=candidate_id)
                          if item["job_id"] == body.job_id), None)
            if not match:
                raise KeyError("候选人与岗位的匹配结果不存在")
            score = match["score"]
        else:
            score = candidate["score"]
        if score.get("requires_reassessment"):
            raise ValueError("人员资料已修改，请先重新分析，再提交人工审核结论")
        if candidate["parse_status"] != "人工已复核":
            workflow.update_candidate_material(candidate_id, {}, operator, confirmed=True,
                                               expected_material_version=body.expected_material_version)
        if fit:
            workflow.save_fit_decision(candidate_id, body.job_id, body.comment.strip(), body.decision, operator)
        else:
            workflow.save_review(candidate_id, body.comment.strip(), body.decision, operator)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_review_saved", "matching_candidate", candidate_id,
          f"{body.decision}" + (f"（岗位 {body.job_id}）" if body.job_id else ""))
    db.commit()
    return {"ok": True}


@router.delete("/candidates/{candidate_id}")
def delete_candidate(candidate_id: str, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "matching:delete")
    try:
        candidate = workflow.get_candidate(candidate_id)
        task = next((item for item in workflow.get_tasks() if item["id"] == candidate["task_id"]), None)
        if task and task["status"] in ("待处理", "处理中"):
            raise HTTPException(409, "任务正在分析，完成后才能删除人员")
        workflow.delete_candidate(candidate_id, matching_operator(ctx))
    except (ValueError, KeyError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_candidate_deleted", "matching_candidate", candidate_id, "从任务中删除人员及其匹配结果")
    db.commit()
    return {"ok": True}


@router.get("/tasks/{task_id}/report")
def export_report(task_id: str, kind: str = Query(pattern="^(single|package|comparison)$"),
                  candidate_ids: str = Query(default=""), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """导出匹配报告：single 单人正式报告；package 多人正式报告包；comparison 多人对比报告。"""
    require(ctx, "matching:export")
    operator = matching_operator(ctx)
    selected = ids_of(candidate_ids)
    try:
        if not selected:
            selected = [row["candidate_id"] for row in person_rows(snapshot_of(task_id)) if row["candidate_id"]]
        if kind == "single":
            if len(selected) != 1:
                raise HTTPException(422, "单人报告请选择一名人员")
            path = batch_reports.export_single_report(task_id, selected[0], operator)
        elif kind == "package":
            result = batch_reports.export_batch_reports(task_id, selected, operator)
            if not result["path"]:
                reasons = "；".join(f"{item['name']}：{'、'.join(item['reasons'])}" for item in result["blocked"][:5])
                raise HTTPException(409, "所选人员均未完成人工复核，暂不能导出正式报告。" + reasons)
            path = result["path"]
        else:
            if len(selected) < 2:
                raise HTTPException(422, "对比报告请至少选择两名人员")
            path = batch_reports.export_comparison_report(task_id, selected, operator)
    except (ValueError, KeyError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_report_exported", "matching_task", task_id,
          f"{ {'single': '单人报告', 'package': '报告包', 'comparison': '多人对比报告'}[kind] }，{len(selected)} 人")
    db.commit()
    path = Path(path)
    media = "application/zip" if path.suffix == ".zip" else DOCX
    return FileResponse(path, media_type=media, headers=download_headers(path.name))


@router.get("/tasks/{task_id}/review-sheet")
def review_sheet(task_id: str, candidate_ids: str = Query(default=""), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """审核明细表（CSV）。"""
    require(ctx, "matching:export")
    snapshot = snapshot_of(task_id)
    selected = set(ids_of(candidate_ids))
    records = [{key: value for key, value in row.items() if key != "candidate_id"}
               for row in snapshot["rows"] if not selected or row["candidate_id"] in selected]
    for record in records:
        record["审核人"] = operator_name(record.get("审核人", ""))
    audit(db, ctx, "matching_review_sheet_exported", "matching_task", task_id, f"导出审核明细 {len(records)} 行")
    db.commit()
    return Response(content=batches.safe_csv(records), media_type="text/csv; charset=utf-8",
                    headers=download_headers(f"{task_id}_审核明细.csv"))


@router.get("/tasks/{task_id}/results")
def task_results(task_id: str, candidate_ids: str = Query(default=""), ctx=Depends(actor_context),
                 db: Session = Depends(get_db)):
    """结构化匹配结果（JSON），供业务系统取数留存。可用 candidate_ids 只取部分人员。"""
    require(ctx, "matching:export")
    try:
        result = evidence.task_results(task_id, ids_of(candidate_ids) or None)
    except KeyError:
        raise HTTPException(404, "匹配任务不存在") from None
    audit(db, ctx, "matching_results_exported", "matching_task", task_id, f"输出结构化结果 {len(result['people'])} 人")
    db.commit()
    return result


@router.get("/tasks/{task_id}/evidence-package")
def evidence_package(task_id: str, candidate_ids: str = Query(default=""), include_originals: bool = False,
                     ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """佐证数据包（ZIP）：评分依据、脱敏材料、结构化资料、操作记录和已导出的报告。"""
    require(ctx, "matching:export")
    try:
        content, name = evidence.build_package(task_id, ids_of(candidate_ids) or None, matching_operator(ctx), include_originals)
    except KeyError:
        raise HTTPException(404, "匹配任务不存在") from None
    except (ValueError, PermissionError) as error:
        raise business_error(error) from None
    audit(db, ctx, "matching_evidence_exported", "matching_task", task_id,
          f"导出佐证数据包；包含原始材料：{'是' if include_originals else '否'}")
    db.commit()
    return Response(content=content, media_type="application/zip", headers=download_headers(name))
