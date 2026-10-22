import asyncio
import json
import logging
import secrets
import time
import wave
from contextlib import suppress
from fastapi import Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from ..core.database import DATA_DIR, SessionLocal, get_db
from .models import SpeechCapture, Interview, Question, ListeningSession, AuditLog, Candidate, Answer
from .common import candidate_id_of
from ..core.deps import allowed
from ..core.settings import allowed_web_origins
from . import doubao_asr as asr
from . import forced_aligner
from .text_models import key_configured

TICKETS = {}
# 与服务启动日志写在同一处，便于现场排查语音转写的问题。
log = logging.getLogger('uvicorn.error')

# 连接语音服务：单次最多等 7 秒，最多 3 次；总时长要短于页面等待就绪的 30 秒。
HANDSHAKE_ATTEMPTS = 3
HANDSHAKE_SECONDS = 7
HANDSHAKE_PAUSE = 0.4
# 停止录音后等实时转写返回最终结果的时间；超过后改用已保存的录音重新转写。
FINAL_WAIT_SECONDS = 20
LIVE_LOST = '实时转写暂时中断，录音仍在保存；停止录音后会用录音重新转写，请继续。'
RECOVERING = '正在用已保存的录音重新转写，请稍候…'
FAILED = '语音转写没有完成，已收到的录音已保留。请重新录制；多次出现时请联系工作人员。'
UNREACHABLE = '暂时连接不上语音转写服务，请稍后重新录制；多次出现时请联系工作人员。'


def reason_of(exc: BaseException) -> str:
    """失败原因的简短说明，写入服务日志和操作记录；不含密钥和请求头。"""
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return '等待语音服务响应超时'
    text = ' '.join(str(exc).split())[:120]
    return f'{type(exc).__name__}：{text}' if text else type(exc).__name__


async def open_remote(capture_id: str):
    """连接语音服务并完成握手；偶发的连接失败自动重试。返回（连接上下文，连接）。"""
    failure = None
    for attempt in range(1, HANDSHAKE_ATTEMPTS + 1):
        link = None
        try:
            async with asyncio.timeout(HANDSHAKE_SECONDS):
                link = await asyncio.to_thread(asr.connection)
                remote = await link.__aenter__()
            try:
                async with asyncio.timeout(HANDSHAKE_SECONDS):
                    await remote.send(asr.initial_packet())
                    asr.parse_packet(await remote.recv())
            except BaseException:
                with suppress(Exception):
                    await link.__aexit__(None, None, None)
                raise
            if attempt > 1:
                log.warning('语音转写：第 %s 次连接语音服务成功 capture=%s', attempt, capture_id)
            return link, remote
        except Exception as exc:
            failure = exc
            log.warning('语音转写：第 %s 次连接语音服务失败 capture=%s 原因=%s', attempt, capture_id, reason_of(exc))
            if attempt < HANDSHAKE_ATTEMPTS:
                await asyncio.sleep(HANDSHAKE_PAUSE * attempt)
    raise failure


def saved_audio(path) -> bytes:
    with wave.open(str(path), 'rb') as audio:
        return audio.readframes(audio.getnframes())


async def align_capture(capture_id: str):
    """Persist alignment independently; ASR completion must never be rolled back."""
    if not forced_aligner.enabled():
        return
    db = SessionLocal()
    try:
        capture = db.get(SpeechCapture, capture_id)
        if not capture or not capture.audio_path or not capture.transcript.strip():
            return
        capture.alignment_status = 'processing'
        db.commit()
        path = (DATA_DIR / capture.audio_path).resolve()
        result = await asyncio.to_thread(forced_aligner.request_alignment, path, capture.transcript)
        capture.alignment_status = 'completed'
        capture.alignment_result = json.dumps(result, ensure_ascii=False)
        db.add(AuditLog(actor=capture.owner, role=capture.role, action='speech_aligned',
                        target_type='speech_capture', target_id=capture.id,
                        detail='Qwen3-ForcedAligner字词时间戳生成完成'))
        db.commit()
    except Exception as exc:
        db.rollback()
        capture = db.get(SpeechCapture, capture_id)
        if capture:
            capture.alignment_status = 'failed'
            capture.alignment_result = json.dumps({'error': type(exc).__name__}, ensure_ascii=False)
            db.commit()
    finally:
        db.close()

class TicketRequest(BaseModel):
    kind: str
    target_id: int
    question_id: int | None = None
    phase: str = 'main'
    consented: bool = False

def get_capture(db, capture_id, ctx, kind, target_id, question_id=None, phase='main'):
    capture = db.get(SpeechCapture, capture_id)
    if not capture or (capture.owner, capture.role, capture.kind, capture.target_id, capture.question_id, capture.phase) != (
        ctx['user'], ctx['role'], kind, target_id, question_id, phase):
        raise HTTPException(403, '录音不属于当前作答或操作者')
    if capture.status != 'completed' or not capture.transcript.strip():
        raise HTTPException(409, '尚未取得有效的最终转写，请停止录音等待结果或重新录制')
    return capture

def install(app, actor_context, require):
    """注册语音采集接口。app 可以是 FastAPI 应用或路由。"""
    @app.post('/api/speech/tickets')
    def ticket(body: TicketRequest, ctx=Depends(actor_context), db=Depends(get_db)):
        if not asr.enabled():
            raise HTTPException(409, '未启用真实语音识别')
        if not key_configured('doubao'):
            raise HTTPException(503, '语音识别密钥（DOUBAO_ASR_API_KEY）未配置，请在 .env 中填写后重启服务')
        if not body.consented:
            raise HTTPException(409, '请先确认音频将发送火山引擎进行转写并在本地留存')
        if body.kind == 'mic_check':
            require(ctx, 'interview:use')
            interview = db.get(Interview, body.target_id)
            if not interview or interview.candidate_id != candidate_id_of(db, ctx):
                raise HTTPException(403, '无权检测其他候选人的麦克风')
            if not interview.consented or interview.status not in ('mic_check', 'ready'):
                raise HTTPException(409, '请先完成采集告知并进入设备检测')
            if body.question_id is not None or body.phase != 'main':
                raise HTTPException(422, '设备检测不能关联面试题目或追问')
        elif body.kind == 'interview':
            require(ctx, 'interview:use')
            interview = db.get(Interview, body.target_id)
            q = db.get(Question, body.question_id)
            if ctx['role'] == 'candidate' and (not interview or interview.candidate_id != candidate_id_of(db, ctx)):
                raise HTTPException(403, '无权录制其他候选人')
            if not interview or not interview.consented or interview.status != 'in_progress':
                raise HTTPException(409, '未取得同意或面试未开始')
            if not q or (q.batch_id, q.job_id, q.version, q.sequence) != (interview.batch_id, interview.job_id, interview.question_version, interview.current_question):
                raise HTTPException(409, '非当前题目')
            if body.phase not in ('main', 'followup'):
                raise HTTPException(422, '无效作答阶段')
            if body.phase == 'followup':
                a = db.scalar(select(Answer).where(Answer.interview_id == interview.id, Answer.question_id == q.id))
                if not a or not a.followup_text or a.followup_answer:
                    raise HTTPException(409, '没有待回答的追问')
        elif body.kind == 'listening':
            require(ctx, 'listening:use')
            # 与旁听页面使用同一条记录：同一候选人有多条时取最新的。
            session = db.scalar(select(ListeningSession).where(
                ListeningSession.candidate_id == body.target_id, ListeningSession.source_mode == 'doubao',
            ).order_by(ListeningSession.id.desc()))
            if not session or session.status != 'running' or body.question_id is not None or body.phase != 'main':
                raise HTTPException(409, '旁听未开始或参数错误')
            from .listening_intelligence import consent_valid
            if not consent_valid(db, session):
                raise HTTPException(409, '本场旁听尚无有效的采集同意记录，请先完成告知确认')
        else:
            raise HTTPException(422, '无效录音类型')
        capture_id, token = secrets.token_hex(16), secrets.token_urlsafe(32)
        db.add(SpeechCapture(id=capture_id, owner=ctx['user'], role=ctx['role'], kind=body.kind,
                            target_id=body.target_id, question_id=body.question_id, phase=body.phase))
        db.add(AuditLog(actor=ctx['user'], role=ctx['role'], action='speech_consent', target_type='speech_capture',
                       target_id=capture_id, detail='同意音频发送至豆包语音识别并本地保存'))
        db.commit()
        if body.kind == 'listening':
            from .listening_intelligence import context as listening_context
            from .listening_roles import labels_lock
            value = listening_context(db, session)
            # 后台可能正在写入发言人的判断结果，登记新录音前读取最新内容。
            with labels_lock:
                db.refresh(value)
                labels = json.loads(value.speakers)
                labels[capture_id] = {'speaker': 'dialogue', 'actor': ctx['user'], 'time': time.time()}
                value.speakers = json.dumps(labels, ensure_ascii=False)
                db.commit()
        for old in list(TICKETS):
            if TICKETS[old][1] < time.monotonic():
                TICKETS.pop(old, None)
        TICKETS[token] = (capture_id, time.monotonic()+60)
        return {'capture_id': capture_id, 'ticket': token}

    def readable(c, ctx):
        """录音由采集人本人读取；复核和旁听人员可回听，用于核对评价依据和处理申诉。"""
        if not c:
            return False
        if (c.owner, c.role) == (ctx['user'], ctx['role']):
            return True
        return ctx['role'] != 'candidate' and (allowed(ctx, 'report:read') or allowed(ctx, 'listening:use'))

    @app.get('/api/speech/captures/{capture_id}')
    def get(capture_id: str, ctx=Depends(actor_context), db=Depends(get_db)):
        c = db.get(SpeechCapture, capture_id)
        if not readable(c, ctx):
            raise HTTPException(403, '无权读取录音')
        return {'id': c.id, 'status': c.status, 'transcript': c.transcript,
                'result': json.loads(c.provider_result), 'audio_available': bool(c.audio_path),
                'alignment_status': c.alignment_status,
                'alignment': json.loads(c.alignment_result or '{}')}

    @app.get('/api/speech/captures/{capture_id}/audio')
    def audio(capture_id: str, ctx=Depends(actor_context), db=Depends(get_db)):
        c = db.get(SpeechCapture, capture_id)
        if not readable(c, ctx) or not c.audio_path:
            raise HTTPException(403, '无权读取录音')
        path = (DATA_DIR / c.audio_path).resolve()
        if not path.is_relative_to((DATA_DIR/'recordings').resolve()) or not path.is_file():
            raise HTTPException(404, '录音不存在')
        return FileResponse(path, media_type='audio/wav', filename=f'{c.id}.wav')

    @app.websocket('/api/speech/stream')
    async def stream(ws: WebSocket):
        # 只接受本系统前端页面发起的语音连接；部署地址通过 TALENTFLOW_WEB_ORIGINS 配置。
        if (ws.headers.get('origin') or '').rstrip('/') not in allowed_web_origins():
            await ws.close(code=1008)
            return
        entry = TICKETS.pop(ws.query_params.get('ticket', ''), None)
        if not entry or entry[1] < time.monotonic():
            await ws.close(code=1008)
            return
        await ws.accept()
        capture_id = entry[0]
        db = SessionLocal()
        c = db.get(SpeechCapture, capture_id)
        writer, receiver, link = None, None, None
        stage = '准备录音'
        try:
            path = DATA_DIR/'recordings'/f'asr-{capture_id}.wav'
            path.parent.mkdir(parents=True, exist_ok=True)
            writer = wave.open(str(path), 'wb')
            writer.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            c.audio_path = f'recordings/{path.name}'
            c.status = 'recording'
            db.commit()
            stage = '连接语音服务'
            link, remote = await open_remote(capture_id)
            await ws.send_json({'type': 'ready', 'capture_id': capture_id})
            stage = '实时转写'

            async def receive():
                async for frame in remote:
                    data, final = asr.parse_packet(frame)
                    result = data.get('result') or {}
                    c.transcript = result.get('text', c.transcript)
                    c.provider_result = json.dumps(data, ensure_ascii=False)
                    db.commit()
                    await ws.send_json({'type': 'partial', 'text': c.transcript, 'utterances': result.get('utterances', [])})
                    if final:
                        return
                raise ValueError('No final ASR response')

            receiver = asyncio.create_task(receive())
            # live：实时转写是否仍在进行。中断后继续保存录音，结束时用录音重新转写。
            live, lost, count = True, '', 0

            async def live_lost(exc):
                nonlocal live, lost
                live, lost = False, reason_of(exc) if exc else '语音服务提前结束了本次转写'
                log.warning('语音转写：实时转写中断，继续保存录音 capture=%s 原因=%s', capture_id, lost)
                with suppress(Exception):
                    await ws.send_json({'type': 'notice', 'message': LIVE_LOST})

            while True:
                try:
                    event = await asyncio.wait_for(ws.receive(), 30)
                except asyncio.TimeoutError:
                    raise ValueError('页面 30 秒没有发来音频') from None
                if event['type'] == 'websocket.disconnect':
                    raise WebSocketDisconnect()
                if event.get('bytes') is not None:
                    chunk = event['bytes']
                    count += len(chunk)
                    if len(chunk) > 32000 or len(chunk) % 2 or count > 16000*2*3600:
                        raise ValueError('Audio limit exceeded')
                    writer.writeframesraw(chunk)
                    if live and receiver.done():
                        await live_lost(None if receiver.cancelled() else receiver.exception())
                    if live:
                        try:
                            await remote.send(asr.packet(chunk, audio=True))
                        except Exception as exc:
                            await live_lost(exc)
                elif event.get('text') == 'finish':
                    writer.close()
                    writer = None
                    if live:
                        try:
                            await remote.send(asr.packet(b'', audio=True, final=True))
                            await asyncio.wait_for(receiver, FINAL_WAIT_SECONDS)
                        except Exception as exc:
                            await live_lost(exc)
                    if not live:
                        stage = '用录音重新转写'
                        pcm = await asyncio.to_thread(saved_audio, path)
                        # 告诉页面最多要等多久，页面据此延长等待，不会提前判为超时。
                        await ws.send_json({'type': 'recovering', 'message': RECOVERING,
                                            'wait_seconds': int(asr.saved_audio_wait(len(pcm))) + 15})
                        text, data = await asr.transcribe_saved(pcm)
                        c.transcript = text
                        c.provider_result = json.dumps(data, ensure_ascii=False)
                        log.warning('语音转写：已用保存的录音重新转写 capture=%s 文字数=%s', capture_id, len(text))
                    break
                else:
                    raise ValueError('Invalid control message')
            c.status = 'completed'
            detail = (f'实时转写中断（{lost}），已用保存的录音重新转写；录音与原始结果已留存' if lost
                      else '豆包实时转写完成，录音与原始结果已留存')
            db.add(AuditLog(actor=c.owner, role=c.role, action='speech_transcribed', target_type='speech_capture',
                           target_id=c.id, detail=detail))
            db.commit()
            await ws.send_json({'type': 'final', 'text': c.transcript, 'capture_id': c.id, 'recovered': bool(lost)})
            if c.kind != 'mic_check':
                asyncio.create_task(align_capture(c.id))
        except Exception as exc:
            db.rollback()
            c.status = 'interrupted'
            if isinstance(exc, WebSocketDisconnect):
                # 页面关闭或网络断开：已收到的录音和转写保留。
                log.info('语音转写：页面断开连接 capture=%s 阶段=%s', capture_id, stage)
            else:
                reason = reason_of(exc)
                log.warning('语音转写：未完成 capture=%s 阶段=%s 原因=%s', capture_id, stage, reason)
                db.add(AuditLog(actor=c.owner, role=c.role, action='speech_interrupted', target_type='speech_capture',
                               target_id=c.id, detail=f'语音转写未完成（{stage}）：{reason}；已收到的录音保留'))
            db.commit()
            with suppress(Exception):
                await ws.send_json({'type': 'error', 'message': UNREACHABLE if stage == '连接语音服务' else FAILED})
        finally:
            if receiver:
                receiver.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await receiver
            if link:
                with suppress(Exception):
                    await link.__aexit__(None, None, None)
            if writer:
                writer.close()
            db.close()
            with suppress(Exception):
                await ws.close()
