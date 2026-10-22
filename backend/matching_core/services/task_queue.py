"""进程内的匹配任务队列。

任务进度由处理函数写入 SQLite，页面轮询数据库即可；队列载荷保存在 ``data/matching/queue``，
服务重启后由 ``recover_pending_tasks`` 继续处理。只适用于单进程部署，多实例部署时应替换为
独立的任务平台。
"""
from __future__ import annotations

import os
import json
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import RLock

from matching_core.config import DB_PATH, QUEUE_DIR, ensure_directories, portable_path
from matching_core.db import row, connect, now_iso


_executor = ThreadPoolExecutor(max_workers=max(1, int(os.getenv("MATCHING_TASK_WORKERS", "2"))),
                               thread_name_prefix="matching-task")
_futures: dict[str, Future] = {}
_lock = RLock()
TALENT_KINDS = {"人员库匹配", "人才库匹配"}  # 后者是旧版载荷使用的名称


def _remember(task_id: str, future: Future) -> None:
    with _lock:
        _futures[task_id] = future


def _write_payload(task_id: str, payload: dict) -> None:
    ensure_directories()
    path = QUEUE_DIR / f"{task_id}.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _guarded(task_id, db_path, work, *args, **kwargs):
    """处理函数之外的异常也要落到任务记录上，避免任务一直停在“处理中”。"""
    try:
        return work(*args, **kwargs)
    except Exception as exc:
        failure = [{"file": "任务分析", "stage": "task", "reason": f"{type(exc).__name__}: {exc}"}]
        try:
            with connect(db_path) as conn:
                conn.execute("UPDATE tasks SET status='部分失败',failure_count=1,failure_reasons_json=?,updated_at=? WHERE id=?",
                             (json.dumps(failure, ensure_ascii=False), now_iso(), task_id))
        except Exception:
            pass
        raise


def enqueue_task(
    task_id: str,
    job_id: str,
    resume_paths: list[str | Path],
    operator: str,
    minutes_map: dict[str, str | Path] | None = None,
    db_path: Path | str = DB_PATH,
    allow_ocr: bool = False,
) -> Future:
    from matching_core.services.workflow import process_task

    _write_payload(task_id, {
        "kind": "岗位选才", "task_id": task_id, "job_id": job_id,
        "resume_paths": [str(path) for path in resume_paths],
        "minutes_map": {key: str(value) for key, value in (minutes_map or {}).items()},
        "operator": operator, "allow_ocr": allow_ocr,
    })
    future = _executor.submit(
        _guarded, task_id, db_path, process_task, task_id, job_id, resume_paths, operator, minutes_map, db_path, allow_ocr
    )
    _remember(task_id, future)
    return future


def enqueue_fit_task(
    task_id: str,
    resume_paths: list[str | Path],
    operator: str,
    minutes_map: dict[str, str | Path] | None = None,
    db_path: Path | str = DB_PATH,
    allow_ocr: bool = False,
) -> Future:
    from matching_core.services.workflow import process_fit_task

    _write_payload(task_id, {
        "kind": "人才适岗", "task_id": task_id,
        "resume_paths": [str(path) for path in resume_paths],
        "minutes_map": {key: str(value) for key, value in (minutes_map or {}).items()},
        "operator": operator, "allow_ocr": allow_ocr,
    })
    future = _executor.submit(
        _guarded, task_id, db_path, process_fit_task, task_id, resume_paths, operator, minutes_map, db_path, allow_ocr
    )
    _remember(task_id, future)
    return future


def task_future(task_id: str) -> Future | None:
    with _lock:
        return _futures.get(task_id)


def enqueue_talent_task(task_id, entry_ids, operator, db_path=DB_PATH):
    """保存人员库选择并在后台完成匹配分析。"""
    from matching_core.services.workflow import _reuse_candidates_in_task
    from matching_core.services.auth import can
    if not can(operator, 'create_task'):
        raise PermissionError('当前账号无权创建匹配任务')
    with _lock:
        running = _futures.get(task_id)
        if running is not None and not running.done():
            return running
        _write_payload(task_id, {'kind': '人员库匹配', 'task_id': task_id,
            'source_entry_ids': list(entry_ids), 'operator': operator})
        future = _executor.submit(_guarded, task_id, db_path, _reuse_candidates_in_task, task_id, list(entry_ids), operator, db_path)
        _remember(task_id, future)
        return future


def _run_existing_task(task_id, operator, db_path, kind):
    from matching_core.services.workflow import reanalyze_task, retry_failed_task
    if kind == "重新分析":
        return reanalyze_task(task_id, operator, db_path)
    return retry_failed_task(task_id, operator, db_path, _queued=True)


def _enqueue_existing_task(task_id, operator, db_path, kind):
    with _lock:
        return _enqueue_existing_task_locked(task_id, operator, db_path, kind)


def _enqueue_existing_task_locked(task_id, operator, db_path, kind):
    from matching_core.services.auth import can
    # 能修改人员资料的角色也要能发起重新分析，否则资料改动后评分无法恢复可用。
    if not can(operator, "review" if kind == "重新分析" else "create_task"):
        raise PermissionError("当前账号无权重新分析任务" if kind == "重新分析" else "当前账号无权重试任务")
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise KeyError("任务不存在")
        if task["status"] in {"待处理", "处理中"}:
            raise ValueError("任务已在队列中或正在处理中，请等待完成")
        if kind == "失败重试" and not json.loads(task["failure_reasons_json"]):
            raise ValueError("当前没有需要重试的记录")
        if kind == "重新分析" and not conn.execute("SELECT 1 FROM candidates WHERE task_id=? LIMIT 1", (task_id,)).fetchone():
            raise ValueError("任务没有已解析材料，请先重试失败文件")
        conn.execute("UPDATE tasks SET status='待处理',updated_at=? WHERE id=?", (now_iso(), task_id))
    previous_payload = {}
    payload_path = QUEUE_DIR / f"{task_id}.json"
    try:
        if payload_path.exists():
            previous_payload = json.loads(payload_path.read_text(encoding="utf-8"))
        previous_payload.pop("db_path", None)
        payload = {**previous_payload, "kind": kind, "task_id": task_id, "operator": operator}
        _write_payload(task_id, payload)
        future = _executor.submit(_guarded, task_id, db_path, _run_existing_task, task_id, operator, db_path, kind)
    except Exception:
        with connect(db_path) as conn:
            conn.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", (task["status"], now_iso(), task_id))
        raise
    _remember(task_id, future)
    return future


def enqueue_task_analysis(task_id: str, operator: str, db_path: Path | str = DB_PATH) -> Future:
    """用已保存的脱敏材料和当前岗位标准重新分析，保留人工结论。"""
    return _enqueue_existing_task(task_id, operator, db_path, "重新分析")


def enqueue_failed_retry(task_id: str, operator: str, db_path: Path | str = DB_PATH) -> Future:
    """只重试解析或分析未完成的人员。"""
    return _enqueue_existing_task(task_id, operator, db_path, "失败重试")


def recover_pending_tasks(db_path: Path | str = DB_PATH) -> list[str]:
    with _lock:
        return _recover_pending_tasks_locked(db_path)


def _recover_pending_tasks_locked(db_path: Path | str = DB_PATH) -> list[str]:
    """服务重启后继续处理仍在“待处理/处理中”的任务。"""
    ensure_directories()
    recovered: list[str] = []
    for path in QUEUE_DIR.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            task_id = payload["task_id"]
            status = (row("SELECT status FROM tasks WHERE id=?", (task_id,), db_path) or {}).get("status")
            if status not in {"待处理", "处理中"} or task_future(task_id) is not None:
                continue
            # 载荷里的路径可能来自迁移前的目录，统一换算到当前数据目录；数据库始终使用当前库。
            resumes = [portable_path(item) for item in payload.get("resume_paths", [])]
            minutes = {key: portable_path(value) for key, value in (payload.get("minutes_map") or {}).items()}
            if payload.get("kind") in {"重新分析", "失败重试"}:
                future = _executor.submit(_guarded, task_id, db_path, _run_existing_task, task_id, payload["operator"], db_path, payload["kind"])
                _remember(task_id, future)
            elif payload.get("kind") in TALENT_KINDS:
                enqueue_talent_task(task_id, payload['source_entry_ids'], payload['operator'], db_path)
            elif payload.get("kind") == "岗位选才":
                enqueue_task(task_id, payload["job_id"], resumes, payload["operator"], minutes, db_path, payload.get("allow_ocr", False))
            else:
                enqueue_fit_task(task_id, resumes, payload["operator"], minutes, db_path, payload.get("allow_ocr", False))
            recovered.append(task_id)
        except Exception:
            # 单个损坏的载荷不能阻止服务启动；该任务仍显示在任务列表中，可人工处理。
            continue
    return recovered
