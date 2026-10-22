"""AI旁听里耗时的处理放到后台：准备提问建议、生成综合报告。

页面发起后立即返回，之后从旁听状态里读取进度，面试官不用停在页面上等。结果写入数据库；
进行中的状态只保存在内存里，服务重启后：提问建议可以重新生成，综合报告停在“生成中”的由页面提示重新生成。
"""
from __future__ import annotations

import logging
import threading

from fastapi import HTTPException

from ..core import background
from ..core.database import SessionLocal
from . import listening_intelligence as listening_ai
from .common import now
from .models import AuditLog, ListeningSession

log = logging.getLogger('uvicorn.error')

# 后台生成时单次模型调用的超时秒数；页面不再等这一次请求，可以比同步方式放宽。
PREPARE_TIMEOUT = 90
REPORT_TIMEOUT = 150
RETRIES = 1
# 结束本场时，可能还有一次补充提问没有生成完；综合报告最多等它这么久。
REPORT_WAIT = 60

_tasks: dict[tuple[str, int], dict] = {}
_lock = threading.Lock()
LABELS = {'prepare': '生成提问建议', 'report': '生成综合报告'}
BUSY = {'prepare': '提问建议正在生成，请等待完成', 'report': '综合报告正在生成，请等待完成'}


def running(kind: str, session_id: int) -> bool:
    with _lock:
        return bool((_tasks.get((kind, session_id)) or {}).get('running'))


def view(kind: str, session_id: int | None) -> dict | None:
    """页面看到的处理状态。已用时间由服务端计算。"""
    with _lock:
        state = dict(_tasks.get((kind, session_id)) or {})
    if not state:
        return None
    status = 'running' if state['running'] else 'failed' if state['error'] else 'completed'
    return {'status': status, 'progress': state['progress'], 'error': state['error'],
            'started_at': state['started'].isoformat(), 'started_by': state['started_by'],
            'elapsed_seconds': max(0, int(((state['finished'] or now()) - state['started']).total_seconds())),
            'operation_id': state['operation']['id']}


def start(kind: str, session_id: int, ctx: dict, work, first_progress: str) -> dict:
    """登记并提交后台处理。同一场旁听的同一种处理同时只进行一个。"""
    state = {'running': True, 'operation': None, 'started': now(), 'started_by': ctx['user'], 'finished': None,
             'progress': first_progress, 'error': ''}

    def run(progress):
        def report(text: str):
            state['progress'] = text
            progress(text)

        report(first_progress)
        try:
            result = work(report)
        except BaseException as error:  # noqa: BLE001 - 无论什么原因中断，都要结束“进行中”的状态
            with _lock:
                state.update(running=False, finished=now(), error=background.failure_message(error))
            raise
        with _lock:
            state.update(running=False, finished=now(), progress='')
        return result

    with _lock:
        if (_tasks.get((kind, session_id)) or {}).get('running'):
            raise HTTPException(409, BUSY[kind])
        state['operation'] = background.submit(f'listening_{kind}', ctx['user'], run, label=LABELS[kind])
        _tasks[(kind, session_id)] = state
    return state['operation']


def forget(kind: str, session_id: int) -> None:
    """同步方式处理成功后，此前后台处理留下的结果（含失败原因）已经过时。"""
    with _lock:
        state = _tasks.get((kind, session_id))
        if state and not state['running']:
            del _tasks[(kind, session_id)]


def reset(session_id: int) -> None:
    """新建旁听记录时调用：记录被删除后编号可能重新使用，此前那条记录的处理状态不算在新记录上。"""
    with _lock:
        for kind in LABELS:
            _tasks.pop((kind, session_id), None)


def start_prepare(session: ListeningSession, ctx: dict, basis: str = '简历和岗位要求') -> dict:
    """后台生成提问建议。basis 是本次生成的依据，写在进度说明里（没有简历时只依据岗位要求）。"""
    session_id, actor = session.id, {'user': ctx['user'], 'role': ctx['role']}

    def work(progress):
        with SessionLocal() as db:
            current = db.get(ListeningSession, session_id)
            if not current or current.status == 'completed':
                raise HTTPException(409, '本场旁听已结束')
            questions = listening_ai.prepare_questions(db, current, actor, timeout=PREPARE_TIMEOUT, retries=RETRIES,
                                                       progress=progress)
            return {'prepared_questions': questions}

    return start('prepare', session_id, actor, work, f'正在依据{basis}向模型请求提问建议')


def start_report(session: ListeningSession, ctx: dict) -> dict:
    """后台生成综合报告。调用前本场已经结束（或已有一份AI生成、尚未人工修改的报告需要重新生成）。"""
    session_id, actor = session.id, {'user': ctx['user'], 'role': ctx['role']}

    def work(progress):
        with SessionLocal() as db:
            current = db.get(ListeningSession, session_id)
            try:
                progress('正在区分对话中的发言人并汇总本场记录')
                content = listening_ai.generate(db, current, actor, finish=True, timeout=REPORT_TIMEOUT,
                                                wait=REPORT_WAIT, background=True)
                return {'generation_mode': content['generation_mode'], 'findings': len(content['findings'])}
            except Exception as error:  # noqa: BLE001 - 没有生成出来时记下原因，页面提示重新生成
                db.rollback()
                reason = background.failure_message(error)[:500]
                log.warning('AI旁听：综合报告没有生成 session=%s 原因=%s', session_id, reason)
                current = db.get(ListeningSession, session_id)
                current.comprehensive_status = 'generation_failed' if not current.comprehensive_report else 'pending_review'
                current.comprehensive_error = reason
                db.add(AuditLog(actor=actor['user'], role=actor['role'], action='combined_report_failed',
                                target_type='listening', target_id=str(session_id), detail=reason))
                db.commit()
                raise

    return start('report', session_id, actor, work, '正在准备生成综合报告')


def report_state(session: ListeningSession | None) -> dict | None:
    """综合报告的生成状态。数据库里停在“生成中”而后台已经没有在处理的，说明服务中途重启过。"""
    if not session:
        return None
    current = view('report', session.id)
    if session.comprehensive_status == 'generating' and not (current and current['status'] == 'running'):
        return {**(current or {}), 'status': 'interrupted', 'progress': '',
                'error': (current or {}).get('error') or '综合报告生成被中断，请重新生成'}
    if session.comprehensive_status == 'generation_failed':
        return {**(current or {}), 'status': 'failed', 'progress': '',
                'error': session.comprehensive_error or (current or {}).get('error') or '综合报告没有生成出来，请重新生成'}
    return current
