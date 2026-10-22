"""批次题目：生成、人工维护、审核、发布和停用。同批次同岗位的主体题保持一致。"""
from __future__ import annotations

import json
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core import background
from ...core.database import SessionLocal, get_db
from ...core.deps import actor_context, audit, require
from ..common import loads, now, question_dict
from ..standards import DISCLAIMER, filter_sensitive
from ..models import Answer, Batch, EvaluationDimension, Interview, Job, JobMaterial, Question, SensitiveBlock
from ..text_models import generate_questions as model_questions

router = APIRouter(tags=["AI面试·题目"])

# 同步方式沿用原有的单次模型调用超时；后台方式不占用请求，放宽超时，
# 遇到超时或模型服务暂时异常时每批自动重试一次。
SYNC_MODEL_TIMEOUT = 45
BACKGROUND_MODEL_TIMEOUT = 90
BACKGROUND_MODEL_RETRIES = 1
GENERATION_BUSY = "该批次正在生成题目，请等待完成"

# 各批次最近一次后台生成的状态，只保存在进程内存中：服务重启后丢失“进行中”的提示，
# 已生成的题目在数据库里不受影响。
_generations: dict[int, dict] = {}
_generations_lock = threading.Lock()


class QuestionUpdate(BaseModel):
    content: str
    time_limit: int = Field(ge=30, le=600)
    change_reason: str


class QuestionGenerateRequest(BaseModel):
    count: int = Field(default=6, ge=1, le=30)
    # 为真时生成在后台进行，接口立即返回后台作业记录；默认同步返回生成结果。
    background: bool = False


class ManualQuestionCreate(BaseModel):
    dimension: str = Field(min_length=1, max_length=64)
    content: str = Field(min_length=4, max_length=2000)
    time_limit: int = Field(default=90, ge=30, le=600)


class ReviewRequest(BaseModel):
    approved: bool
    comment: str


@router.get("/api/questions")
def list_questions(batch_id: int | None = None, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:read")
    query = select(Question).order_by(Question.version.desc(), Question.sequence)
    if batch_id:
        query = query.where(Question.batch_id == batch_id)
    return [question_dict(q) for q in db.scalars(query).all()]


def generation_target(db: Session, batch_id: int) -> tuple[Batch, Job]:
    """生成题目的前置校验：批次存在、需要AI面试题目、岗位的面试评价标准已审核。按数据库当前的内容判断。"""
    batch = db.scalar(select(Batch).where(Batch.id == batch_id).execution_options(populate_existing=True))
    if not batch:
        raise HTTPException(404, "批次不存在")
    if (batch.mode or "ai_interview") == "listening_only":
        raise HTTPException(409, "本批次仅做人工面试旁听，不需要AI面试题目")
    job = db.scalar(select(Job).where(Job.id == batch.job_id).execution_options(populate_existing=True))
    if not job or job.audit_status != "approved":
        raise HTTPException(409, "岗位的面试评价标准尚未审核，请先在岗位库中确认后再生成题目")
    return batch, job


def batch_identity(batch: Batch) -> tuple:
    """批次删除后，编号可能被新建的批次重新使用；连同建立时间和岗位一起，才能确认还是同一个批次。"""
    return batch.id, batch.job_id, batch.created_at.replace(tzinfo=None) if batch.created_at else None


def create_question_version(db: Session, actor: dict, batch_id: int, count: int, *, timeout: float = SYNC_MODEL_TIMEOUT,
                            retries: int = 0, progress=None) -> dict:
    """生成一版题目草稿，同步和后台两种方式共用。

    全部题目生成成功后才写入，模型调用中途失败时不留下不完整的题目版本。事务由调用方提交。
    """
    batch, job = generation_target(db, batch_id)
    identity = batch_identity(batch)
    job_input = {column.name: getattr(job, column.name) for column in Job.__table__.columns if column.name not in {'created_at', 'updated_at'}}
    job_input['materials_text'] = '\n\n'.join(m.ocr_text for m in db.scalars(select(JobMaterial).where(JobMaterial.job_id == job.id, JobMaterial.ocr_status == 'completed')).all())
    generated = model_questions(job_input, count, timeout=timeout, retries=retries, progress=progress)
    # 生成可能持续几分钟：写入前按数据库当前的内容重新确认批次，并在这时确定版本号。
    batch, job = generation_target(db, batch_id)
    if batch_identity(batch) != identity:
        raise HTTPException(409, "批次在生成期间已被删除或更换岗位，题目未保存，请重新生成")
    next_version = (db.scalar(select(func.max(Question.version)).where(Question.batch_id == batch_id)) or 0) + 1
    created = []
    for sequence, (dimension, content) in enumerate(generated, start=1):
        allowed, reason = filter_sensitive(content)
        if not allowed:
            block = SensitiveBlock(content=content, reason=reason, source_type="main_question")
            db.add(block)
            audit(db, actor, "sensitive_content_blocked", "question", "new", reason)
            continue
        q = Question(
            batch_id=batch.id, job_id=batch.job_id, sequence=sequence, dimension=dimension,
            content=content, time_limit=90, version=next_version, status="draft",
            change_log=json.dumps([{"version": next_version, "action": "AI生成", "actor": actor["user"]}], ensure_ascii=False),
        )
        db.add(q)
        created.append(q)
    audit(db, actor, "question_generated", "batch", batch.id, f"题目版本 {next_version}，共 {len(created)} 道")
    return {"version": next_version, "count": len(created), "message": DISCLAIMER}


def current_generation(batch: Batch) -> dict | None:
    """该批次最近一次后台生成的状态；编号被新批次重新使用时，旧批次的状态不算在新批次上。调用时须持有锁。"""
    state = _generations.get(batch.id)
    return state if state and state["batch"] == batch_identity(batch) else None


def generation_running(batch: Batch) -> bool:
    with _generations_lock:
        return bool((current_generation(batch) or {}).get("running"))


def finish_generation(state: dict, *, result: dict | None = None, error: str = "") -> None:
    with _generations_lock:
        state.update(running=False, finished=now(), result=result, error=error)


def forget_finished_generation(batch_id: int) -> None:
    """同步方式生成成功后，此前后台生成留下的结果（含失败原因）已经过时，不再提示。"""
    with _generations_lock:
        state = _generations.get(batch_id)
        if state and not state["running"]:
            del _generations[batch_id]


def generate_in_background(batch_id: int, count: int, actor: dict, progress) -> dict:
    """后台线程中的生成：使用独立的数据库会话；失败时不保存任何题目，只记录失败原因。"""
    with SessionLocal() as db:
        try:
            result = create_question_version(db, actor, batch_id, count, timeout=BACKGROUND_MODEL_TIMEOUT,
                                             retries=BACKGROUND_MODEL_RETRIES, progress=progress)
            db.commit()
            return result
        except Exception as error:
            db.rollback()
            try:
                audit(db, actor, "question_generation_failed", "batch", batch_id, background.failure_message(error)[:500])
                db.commit()
            except Exception:  # noqa: BLE001 - 审计写不进去时，仍要把生成失败的原因交给页面
                db.rollback()
            raise


def start_generation(batch: Batch, count: int, actor: dict) -> dict:
    """登记并提交后台生成，返回后台作业记录。同一个批次同时只允许一个生成在进行。"""
    batch_id = batch.id
    state = {"batch": batch_identity(batch), "running": True, "operation": None, "count": count,
             "started": now(), "started_by": actor["user"], "finished": None,
             "progress": f"正在准备生成（共 {count} 道）", "result": None, "error": ""}

    def work(progress):
        def report(text: str):
            # 作业记录只有发起人能查询；同批次的其他工作人员从批次的生成状态里看进度。
            state["progress"] = text
            progress(text)

        try:
            result = generate_in_background(batch_id, count, actor, report)
        except BaseException as error:  # noqa: BLE001 - 无论什么原因中断，都要结束“进行中”的状态
            finish_generation(state, error=background.failure_message(error))
            raise
        finish_generation(state, result=result)
        return result

    with _generations_lock:
        if (current_generation(batch) or {}).get("running"):
            raise HTTPException(409, GENERATION_BUSY)
        state["operation"] = background.submit("question_generation", actor["user"], work, label=f"生成 {count} 道主体题")
        _generations[batch_id] = state
    return state["operation"]


def generation_view(state: dict | None) -> dict:
    """页面看到的生成状态。已用时间由服务端计算，页面不必依赖本机时钟。"""
    if not state:
        return {"running": False}
    status = "running" if state["running"] else "failed" if state["error"] else "completed"
    view = {
        "running": state["running"],
        "operation": {**state["operation"], "status": status, "progress": state["progress"],
                      "result": state["result"], "error": state["error"]},
        "count": state["count"], "started_at": state["started"].isoformat(), "started_by": state["started_by"],
        "elapsed_seconds": max(0, int(((state["finished"] or now()) - state["started"]).total_seconds())),
    }
    if not state["running"]:
        view["finished_at"] = state["finished"].isoformat()
        if state["error"]:
            view["last_error"] = state["error"]
        else:
            view["last_result"] = state["result"]
    return view


@router.post("/api/batches/{batch_id}/questions/generate")
def generate_questions(batch_id: int, body: QuestionGenerateRequest = QuestionGenerateRequest(), ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """生成一版题目草稿。默认同步返回结果；background 为真时在后台生成，立即返回后台作业记录。"""
    require(ctx, "question:generate")
    batch, _ = generation_target(db, batch_id)
    if body.background:
        return start_generation(batch, body.count, {"role": ctx["role"], "user": ctx["user"]})
    if generation_running(batch):
        raise HTTPException(409, GENERATION_BUSY)
    result = create_question_version(db, ctx, batch_id, body.count)
    db.commit()
    forget_finished_generation(batch_id)
    return result


@router.get("/api/batches/{batch_id}/questions/generation")
def question_generation_status(batch_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    """批次当前的题目生成状态，供页面打开或刷新时恢复显示；同批次的工作人员都能看到进度。"""
    require(ctx, "question:read")
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "批次不存在")
    with _generations_lock:
        state = dict(current_generation(batch) or {})
    return generation_view(state)


@router.post("/api/batches/{batch_id}/questions/manual")
def create_question_manually(batch_id: int, body: ManualQuestionCreate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:edit")
    batch = db.get(Batch, batch_id)
    if not batch:
        raise HTTPException(404, "批次不存在")
    if not db.scalar(select(EvaluationDimension.id).where(EvaluationDimension.name == body.dimension)):
        raise HTTPException(422, "评价维度不存在")
    allowed, reason = filter_sensitive(body.content)
    if not allowed:
        db.add(SensitiveBlock(content=body.content, reason=reason, source_type="main_question"))
        audit(db, ctx, "sensitive_content_blocked", "question", "new", reason)
        db.commit()
        raise HTTPException(422, f"敏感内容已拦截：{reason}")

    latest_version = db.scalar(select(func.max(Question.version)).where(Question.batch_id == batch_id)) or 0
    latest_rows = db.scalars(
        select(Question).where(Question.batch_id == batch_id, Question.version == latest_version).order_by(Question.sequence)
    ).all() if latest_version else []
    editable = bool(latest_rows) and all(item.status in {"draft", "returned"} for item in latest_rows)
    target_version = latest_version if editable else latest_version + 1
    target_rows = list(latest_rows) if editable else []
    cloned = 0
    if not editable and batch.question_version:
        published_rows = db.scalars(
            select(Question).where(Question.batch_id == batch_id, Question.version == batch.question_version).order_by(Question.sequence)
        ).all()
        for item in published_rows:
            clone = Question(
                batch_id=batch.id, job_id=batch.job_id, sequence=item.sequence, dimension=item.dimension,
                content=item.content, time_limit=item.time_limit, version=target_version, status="draft",
                change_log=json.dumps([{"version": target_version, "action": "从已发布版本复制为草稿", "actor": ctx["user"]}], ensure_ascii=False),
            )
            db.add(clone)
            target_rows.append(clone)
            cloned += 1

    sequence = len(target_rows) + 1
    question = Question(
        batch_id=batch.id, job_id=batch.job_id, sequence=sequence, dimension=body.dimension,
        content=body.content, time_limit=body.time_limit, version=target_version, status="draft",
        change_log=json.dumps([{"version": target_version, "action": "HR手动新增", "actor": ctx["user"]}], ensure_ascii=False),
    )
    db.add(question)
    db.flush()
    audit(db, ctx, "question_created", "question", question.id,
          f"手动新增至版本 {target_version}，序号 {sequence}，复制既有题目 {cloned} 道")
    db.commit()
    return {**question_dict(question), "cloned_count": cloned}


@router.post("/api/batches/{batch_id}/questions/{version}/submit-review")
def submit_questions_for_review(batch_id: int, version: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:submit")
    batch = db.get(Batch, batch_id)
    rows = db.scalars(
        select(Question).where(Question.batch_id == batch_id, Question.version == version).order_by(Question.sequence)
    ).all()
    if not batch or not rows:
        raise HTTPException(404, "题目版本不存在")
    if any(q.status not in {"draft", "returned", "approved"} for q in rows) or not any(q.status in {"draft", "returned"} for q in rows):
        raise HTTPException(409, "当前版本没有可提交审核的草稿或退回题目")
    for q in rows:
        if q.status == "approved":
            continue
        history = loads(q.change_log, [])
        history.append({"version": q.version, "action": "提交审核", "actor": ctx["user"]})
        q.change_log = json.dumps(history, ensure_ascii=False)
        q.status = "pending_review"
    batch.status = "active" if batch.question_version else "reviewing"
    audit(db, ctx, "question_submitted", "batch", batch.id, f"题目版本 {version}，共 {len(rows)} 道")
    db.commit()
    return {"ok": True, "version": version, "count": sum(q.status == "pending_review" for q in rows)}


@router.post("/api/batches/{batch_id}/questions/{version}/review-all")
def review_question_version(batch_id: int, version: int, body: ReviewRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:review")
    batch = db.get(Batch, batch_id)
    rows = db.scalars(select(Question).where(Question.batch_id == batch_id, Question.version == version).order_by(Question.sequence)).all()
    if not batch or not rows:
        raise HTTPException(404, "题目版本不存在")
    pending = [q for q in rows if q.status == "pending_review"]
    if not body.approved or not pending or any(q.status not in {"pending_review", "approved"} for q in rows):
        raise HTTPException(409, "请先将本版本全部草稿或退回题目提交审核")
    if not body.comment.strip():
        raise HTTPException(422, "请确认整套题目的审核意见")
    # 全部内容校验成功后才修改，避免批量操作只通过部分题目。
    for q in rows:
        allowed, reason = filter_sensitive(q.content)
        if not allowed:
            db.add(SensitiveBlock(content=q.content, reason=reason, source_type="main_question"))
            audit(db, ctx, "sensitive_content_blocked", "question", q.id, reason)
            db.commit()
            raise HTTPException(422, f"Q{q.sequence} 敏感内容已拦截：{reason}，本次未审核通过任何题目")
    for q in pending:
        q.status = "approved"
        q.review_comment = body.comment.strip()
        history = loads(q.change_log, [])
        history.append({"version": version, "action": "一键审核通过", "actor": ctx["user"], "comment": q.review_comment})
        q.change_log = json.dumps(history, ensure_ascii=False)
        audit(db, ctx, "question_reviewed", "question", q.id, "approved，一键审核")
    batch.status = "active" if batch.question_version else "approved"
    audit(db, ctx, "question_version_reviewed", "batch", batch_id, f"题目版本 {version}，本次通过 {len(pending)} 道")
    db.commit()
    return {"ok": True, "version": version, "count": len(pending)}


@router.delete("/api/batches/{batch_id}/questions/{version}")
def delete_question_version(batch_id: int, version: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:edit")
    batch = db.get(Batch, batch_id)
    rows = db.scalars(select(Question).where(Question.batch_id == batch_id, Question.version == version)).all()
    if not batch or not rows:
        raise HTTPException(404, "题目版本不存在")
    if batch.question_version == version or any(q.status not in {"draft", "returned", "pending_review", "approved"} for q in rows):
        raise HTTPException(409, "已发布或已停用的历史题目版本不能删除")
    assigned = db.scalar(select(Interview.id).where(Interview.batch_id == batch_id, Interview.question_version == version).limit(1))
    answered = db.scalar(select(Answer.id).where(Answer.question_id.in_([q.id for q in rows])).limit(1))
    if assigned is not None or answered is not None:
        raise HTTPException(409, "该版本已关联面试记录，不能删除")
    for q in rows:
        db.delete(q)
    db.flush()
    remaining = db.scalars(select(Question).where(Question.batch_id == batch_id)).all()
    remaining_versions = {q.version for q in remaining}
    if batch.question_version:
        batch.status = "active"
    elif any(all(q.status == "approved" for q in remaining if q.version == v) for v in remaining_versions):
        batch.status = "approved"
    elif any(q.status == "pending_review" for q in remaining):
        batch.status = "reviewing"
    else:
        batch.status = "draft"
    audit(db, ctx, "question_version_deleted", "batch", batch_id, f"删除未启用题目版本 {version}，共 {len(rows)} 道")
    db.commit()
    return {"ok": True, "version": version, "count": len(rows)}


@router.put("/api/questions/{question_id}")
def update_question(question_id: int, body: QuestionUpdate, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:edit")
    q = db.get(Question, question_id)
    if not q:
        raise HTTPException(404, "题目不存在")
    if q.status not in {"draft", "returned"}:
        raise HTTPException(409, "仅草稿或已退回的题目可以编辑")
    allowed, reason = filter_sensitive(body.content)
    if not allowed:
        db.add(SensitiveBlock(content=body.content, reason=reason, source_type="main_question"))
        audit(db, ctx, "sensitive_content_blocked", "question", q.id, reason)
        db.commit()
        raise HTTPException(422, f"敏感内容已拦截：{reason}")
    history = loads(q.change_log, [])
    history.append({"version": q.version, "action": "编辑", "actor": ctx["user"], "reason": body.change_reason, "previous": q.content})
    q.content = body.content
    q.time_limit = body.time_limit
    q.status = "draft"
    q.change_log = json.dumps(history, ensure_ascii=False)
    audit(db, ctx, "question_updated", "question", q.id, body.change_reason)
    db.commit()
    return question_dict(q)


@router.delete("/api/questions/{question_id}")
def delete_question(question_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:edit")
    q = db.get(Question, question_id)
    if not q:
        raise HTTPException(404, "题目不存在")
    if q.status not in {"draft", "returned"}:
        raise HTTPException(409, "仅草稿或已退回的题目可以删除")
    batch_id, version, deleted_sequence = q.batch_id, q.version, q.sequence
    db.delete(q)
    db.flush()
    remaining = db.scalars(
        select(Question).where(Question.batch_id == batch_id, Question.version == version).order_by(Question.sequence)
    ).all()
    for sequence, item in enumerate(remaining, start=1):
        item.sequence = sequence
    audit(db, ctx, "question_deleted", "question", question_id,
          f"删除版本 {version} 的原第 {deleted_sequence} 题，剩余 {len(remaining)} 道")
    db.commit()
    return {"ok": True, "version": version, "count": len(remaining)}


@router.post("/api/questions/{question_id}/review")
def review_question(question_id: int, body: ReviewRequest, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:review")
    q = db.get(Question, question_id)
    if not q:
        raise HTTPException(404, "题目不存在")
    if q.status in {"published", "disabled"}:
        # 已发布的题目是候选人实际作答的版本，不能再改动审核状态；要调整请新建题目版本。
        raise HTTPException(409, "已发布或已停用的题目不能再审核，请新建题目版本")
    allowed, reason = filter_sensitive(q.content)
    if not allowed:
        db.add(SensitiveBlock(content=q.content, reason=reason, source_type="main_question"))
        audit(db, ctx, "sensitive_content_blocked", "question", q.id, reason)
        db.commit()
        raise HTTPException(422, f"敏感内容已拦截：{reason}")
    q.status = "approved" if body.approved else "returned"
    q.review_comment = body.comment
    history = loads(q.change_log, [])
    history.append({"version": q.version, "action": "审核通过" if body.approved else "退回", "actor": ctx["user"], "comment": body.comment})
    q.change_log = json.dumps(history, ensure_ascii=False)
    audit(db, ctx, "question_reviewed", "question", q.id, q.status)
    version_rows = db.scalars(select(Question).where(Question.batch_id == q.batch_id, Question.version == q.version)).all()
    batch = db.get(Batch, q.batch_id)
    if batch:
        if not body.approved:
            batch.status = "active" if batch.question_version else "draft"
        elif version_rows and all(item.status == "approved" for item in version_rows):
            batch.status = "active" if batch.question_version else "approved"
    db.commit()
    return question_dict(q)


@router.post("/api/batches/{batch_id}/questions/{version}/publish")
def publish_questions(batch_id: int, version: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:publish")
    batch = db.get(Batch, batch_id)
    rows = db.scalars(select(Question).where(Question.batch_id == batch_id, Question.version == version).order_by(Question.sequence)).all()
    if not batch or not rows:
        raise HTTPException(409, "该版本没有可发布的主体题")
    if any(q.status != "approved" for q in rows):
        raise HTTPException(409, "所有题目审核通过后才能发布")
    for old in db.scalars(select(Question).where(Question.batch_id == batch_id, Question.status == "published")).all():
        old.status = "disabled"
    for q in rows:
        q.status = "published"
    batch.question_version = version
    batch.status = "active"
    audit(db, ctx, "question_published", "batch", batch_id, f"题目版本 {version}")
    db.commit()
    return {"ok": True, "version": version}


@router.post("/api/questions/{question_id}/disable")
def disable_question(question_id: int, ctx=Depends(actor_context), db: Session = Depends(get_db)):
    require(ctx, "question:disable")
    q = db.get(Question, question_id)
    if not q:
        raise HTTPException(404, "题目不存在")
    q.status = "disabled"
    audit(db, ctx, "question_disabled", "question", q.id, f"版本 {q.version}")
    db.commit()
    return {"ok": True}
