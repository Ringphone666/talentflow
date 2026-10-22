"""进程内后台作业：把耗时的模型调用移出请求线程，页面轮询作业状态。

单进程部署足够使用；作业状态只保存在内存中，业务结果由各自的处理函数写入数据库，
因此进程重启只会丢失“进行中”的提示，不会丢失已完成的业务数据。
"""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from fastapi import HTTPException

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="talentflow-job")
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_KEEP_SECONDS = 60 * 60


def _forget_finished() -> None:
    limit = time.time() - _KEEP_SECONDS
    for job_id in [key for key, job in _jobs.items() if job["finished_at"] and job["finished_at"] < limit]:
        _jobs.pop(job_id, None)


def failure_message(error: BaseException) -> str:
    """只向页面返回业务可读的原因，不暴露堆栈、路径或凭据。"""
    if isinstance(error, HTTPException):
        return str(error.detail)
    if isinstance(error, (ValueError, PermissionError)):
        return str(error)
    if isinstance(error, KeyError):
        return str(error.args[0]) if error.args else "记录不存在"
    return f"处理未完成（{type(error).__name__}），请稍后重试"


def submit(kind: str, owner: str, work: Callable[[Callable[[str], None]], Any], *, label: str = "") -> dict:
    """提交作业。work 接收一个更新进度说明的回调，返回可序列化的结果。"""
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "kind": kind, "owner": owner, "label": label, "status": "running",
           "progress": "", "result": None, "error": "", "created_at": time.time(), "finished_at": None}
    with _lock:
        _forget_finished()
        _jobs[job_id] = job

    def run():
        try:
            job["result"] = work(lambda text: job.__setitem__("progress", text))
            job["status"] = "completed"
        except BaseException as error:  # noqa: BLE001 - 后台线程的异常必须落到作业状态里
            job["status"] = "failed"
            job["error"] = failure_message(error)
        finally:
            job["finished_at"] = time.time()

    _executor.submit(run)
    return public(job)


def run_later(work: Callable[[], Any]) -> None:
    """不需要页面轮询的后台处理（结果由处理函数自行落库）。"""
    _executor.submit(work)


def public(job: dict) -> dict:
    return {key: job[key] for key in ("id", "kind", "label", "status", "progress", "result", "error")}


def get(job_id: str, owner: str) -> dict:
    job = _jobs.get(job_id)
    if not job or job["owner"] != owner:
        raise HTTPException(404, "处理记录不存在或已过期，请重新发起")
    return public(job)
