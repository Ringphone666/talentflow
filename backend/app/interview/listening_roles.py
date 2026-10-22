"""人工面试的录音里通常有考官和候选人两个人，语音转写不区分发言人。

这里按对话的上下文逐句判断是谁说的，供补充提问和综合报告只引用候选人的话。判断结果是推断：
页面和报告里都标明待核对，面试官可以逐段改正，改正过的记为已确认。
"""
import json
import re
import threading
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select

from . import text_models
from .models import ListeningContext, SpeechCapture

Role = Literal['interviewer', 'candidate', 'unknown']
ROLES = ('interviewer', 'candidate', 'unknown')
# inferred：按语境推断；confirmed：面试官改正或确认；pending：还没有判断。
JUDGED = ('inferred', 'confirmed')
SENTENCE = re.compile(r'[^。！？!?；;\n]+[。！？!?；;]*')
# 判断新的句子时，附带前面已经判断过的几句，便于衔接。
CONTEXT_SENTENCES = 8
# 一次最多判断的句数；更长的对话分几次判断，避免单次等待过久。
BATCH = 60
TIMEOUT = 40
# 逐句判断是分类任务，用响应较快的模型（2026-09-29 实测 16 句约 4 秒，结果与生成用的模型一致）。
MODEL = 'chat-evaluation'
TASK = ('这是一场人工面试的录音转写，按句编号，录音里有考官和候选人。请判断每一句是谁说的：'
        'interviewer（考官）、candidate（候选人）、unknown（无法判断）。'
        '考官提问、追问、说明流程和要求；候选人回答问题、讲述自己的经历和想法。只根据对话的上下文判断，拿不准的标unknown，不要猜。'
        'sentences中已经带有role的句子是此前判断过的，只用来衔接上下文，不要返回；没有role的句子每一句都要返回index和role，不要遗漏。'
        'questions是面试官准备的问题，和其中某个问题意思相同的句子是考官说的。不要改写或返回句子的文字。')
_lock = threading.Lock()
# 写入发言人标注时使用，避免后台判断和页面操作互相覆盖。
labels_lock = _lock
_sessions: dict[int, threading.Lock] = {}


def session_lock(session_id: int) -> threading.Lock:
    """同一场旁听同时只做一次判断：页面和后台同时发起时，后到的等前一个做完，不重复请求模型。"""
    with _lock:
        return _sessions.setdefault(session_id, threading.Lock())


class SentenceRole(BaseModel):
    index: int
    role: Role


class SentenceRoles(BaseModel):
    sentences: list[SentenceRole]


def spans(transcript: str) -> list[tuple[int, int, str]]:
    """转写按句切分，返回每句在原文中的起止位置和文字。"""
    result = []
    for match in SENTENCE.finditer(transcript or ''):
        text = match.group().strip()
        if text:
            start = match.start() + (len(match.group()) - len(match.group().lstrip()))
            result.append((start, start + len(text), text))
    return result


def aligned(transcript: str, stored: list[dict]) -> list[dict]:
    """与当前转写逐句对应的判断。文字有变化或还没判断过的句子记为 pending。"""
    result = []
    for index, (_, _, text) in enumerate(spans(transcript)):
        known = stored[index] if index < len(stored) else None
        if known and known.get('text') == text and known.get('basis') in JUDGED and known.get('role') in ROLES:
            result.append({'text': text, 'role': known['role'], 'basis': known['basis'],
                           **({'actor': known['actor']} if known.get('actor') else {})})
        else:
            result.append({'text': text, 'role': 'unknown', 'basis': 'pending'})
    return result


def turns(transcript: str, stored: list[dict], *, keep_basis: bool = False) -> list[dict]:
    """同一个人连着说的几句合成一段。text 取自转写原文，可以直接用来核对引用。

    keep_basis：页面显示用。面试官确认或改正过的句子单独成段，不和相邻的推断结果合在一起，改错了还能单独改回来。
    不加这一项时只按发言人合并，供分析和报告使用；一段里的句子全部确认过，这一段才算已确认。
    """
    located, sentences, result = spans(transcript), aligned(transcript, stored), []
    for index, sentence in enumerate(sentences):
        start, end, _ = located[index]
        last = result[-1] if result else None
        pending = sentence['basis'] == 'pending'
        together = (last['basis'] == sentence['basis']) if last and keep_basis else (
            last is not None and (last['basis'] == 'pending') == pending)
        if last and last['role'] == sentence['role'] and together:
            last.update(last=index, end=end)
            if sentence['basis'] == 'inferred':
                last['basis'] = 'inferred'
        else:
            result.append({'role': sentence['role'], 'basis': sentence['basis'], 'first': index, 'last': index,
                           'start': start, 'end': end})
    return [{'role': item['role'], 'basis': item['basis'], 'first': item['first'], 'last': item['last'],
             'text': transcript[item['start']:item['end']]} for item in result]


def complete(transcript: str, stored: list[dict]) -> bool:
    return all(item['basis'] != 'pending' for item in aligned(transcript, stored))


def fixed_roles(texts: list[str]) -> list[str]:
    """测试环境的固定规则：提问是考官说的，其余是候选人说的。"""
    return ['interviewer' if text.rstrip().endswith(('？', '?')) or text.lstrip().startswith(('请', '那请'))
            else 'candidate' for text in texts]


def infer(transcript: str, stored: list[dict], questions: list[str], *, timeout: float = TIMEOUT) -> list[dict]:
    """补齐还没有判断的句子，返回与当前转写逐句对应的完整判断。已判断的句子保持不变。"""
    sentences = aligned(transcript, stored)
    while True:
        missing = [index for index, item in enumerate(sentences) if item['basis'] == 'pending'][:BATCH]
        if not missing:
            return sentences
        if text_models.enabled():
            window = range(max(0, missing[0] - CONTEXT_SENTENCES), missing[-1] + 1)
            data = {'sentences': [
                {'index': index, 'text': sentences[index]['text'],
                 **({} if index in missing else {'role': sentences[index]['role']})} for index in window],
                'questions': questions[:20]}
            answer = text_models.request_json(MODEL, TASK, data, SentenceRoles, timeout=timeout, max_tokens=4000)
            roles = {item.index: item.role for item in answer.sentences}
        else:
            text_models.require_live_or_test_mock()
            roles = dict(zip(missing, fixed_roles([sentences[index]['text'] for index in missing])))
        for index in missing:
            # 模型漏掉的句子记为无法判断，不再反复请求。
            sentences[index].update(role=roles.get(index, 'unknown'), basis='inferred')


def save(db, session_id: int, capture_id: str, sentences: list[dict] | None, error: str = '') -> None:
    """写入判断结果。其他请求可能同时在改发言人标注，写入前重新读取最新内容。"""
    with _lock:
        context = db.get(ListeningContext, session_id)
        if not context:
            return
        db.refresh(context)
        labels = json.loads(context.speakers)
        label = labels.get(capture_id)
        if not label:
            return
        if sentences is not None:
            # 判断期间面试官确认过的句子以面试官的为准。
            fresh = label.get('sentences') or []
            label['sentences'] = [
                fresh[index] if index < len(fresh) and fresh[index].get('basis') == 'confirmed'
                and fresh[index].get('text') == item['text'] else item for index, item in enumerate(sentences)]
        label['roles_status'] = 'failed' if error else 'completed'
        label['roles_error'] = error
        context.speakers = json.dumps(labels, ensure_ascii=False)
        db.commit()


def questions_of(session) -> list[str]:
    """面试官手里的问题：准备的提问和已采用的补充提问。"""
    prepared = [item.get('text', '') for item in json.loads(session.prepared_questions or '[]') if item.get('status') != 'ignored']
    adopted = [item.get('edited_text') or item.get('text', '') for item in json.loads(session.suggestions or '[]')
               if item.get('status') in ('adopted', 'edited')]
    return [text for text in [*prepared, *adopted] if text]


def ensure(db, session, *, finalized: bool, capture_id: str | None = None, timeout: float = TIMEOUT) -> int:
    """给本场还没有区分发言人的连续对话补上判断，返回处理的录音数。

    单段录音判断失败只记录原因，不影响其余录音，也不影响后面的提问建议和综合报告。
    """
    from ..core.background import failure_message
    states = ('completed', 'linked') if finalized else ('recording', 'completed', 'linked')
    handled = 0
    with session_lock(session.id):
        context = db.get(ListeningContext, session.id)
        if not context:
            return 0
        db.refresh(context)
        labels = json.loads(context.speakers)
        captures = db.scalars(select(SpeechCapture).where(
            SpeechCapture.kind == 'listening', SpeechCapture.target_id == session.candidate_id,
        ).order_by(SpeechCapture.created_at)).all()
        for capture in captures:
            label = labels.get(capture.id)
            if not label or label.get('speaker') != 'dialogue' or capture.status not in states:
                continue
            if capture_id and capture.id != capture_id:
                continue
            db.refresh(capture)
            transcript = capture.transcript or ''
            stored = label.get('sentences') or []
            if not transcript.strip() or complete(transcript, stored):
                continue
            try:
                save(db, session.id, capture.id, infer(transcript, stored, questions_of(session), timeout=timeout))
            except Exception as error:  # noqa: BLE001 - 判断不出来时保持“未区分”，如实记录原因
                db.rollback()
                save(db, session.id, capture.id, None, failure_message(error)[:300])
            handled += 1
    return handled


def confirm(db, session, capture, first: int, last: int, role: str, actor: str) -> list[dict]:
    """面试官改正或确认一段话是谁说的。"""
    context = db.get(ListeningContext, session.id)
    labels = json.loads(context.speakers)
    label = labels[capture.id]
    sentences = aligned(capture.transcript or '', label.get('sentences') or [])
    if not (0 <= first <= last < len(sentences)):
        raise ValueError('这段话的位置已经变化，请刷新后重试')
    for index in range(first, last + 1):
        sentences[index].update(role=role, basis='confirmed', actor=actor)
    label['sentences'] = sentences
    label['roles_status'] = 'completed'
    label['roles_error'] = ''
    context.speakers = json.dumps(labels, ensure_ascii=False)
    context.last_evidence_hash = ''
    return turns(capture.transcript or '', sentences, keep_basis=True)
