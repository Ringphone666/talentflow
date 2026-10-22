import asyncio
import gzip
import json
import struct
import wave
import pytest
from fastapi import HTTPException
from starlette.websockets import WebSocketDisconnect
from backend.app.core.database import SessionLocal
from backend.app.interview import doubao_asr, speech_routes
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview.models import (
    AuditLog, Candidate, SpeechCapture, ListeningSession, ListeningContext, Interview, User,
)

# 语音测试使用的虚构候选人编号，远离测试数据初始化写入的编号。
LISTENING, ANSWERING, LEGACY = 90401, 90402, 90403


def response(text='', final=False):
    body = gzip.compress(json.dumps({'result': {'text': text, 'utterances': [
        {'text': text, 'start_time': 0, 'end_time': 100, 'definite': final}
    ]}}).encode())
    return bytes([0x11, 0x92 if final else 0x90, 0x11, 0]) + struct.pack('>I', len(body)) + body


class FakeRemote:
    async def __aenter__(self):
        self.queue = asyncio.Queue()
        return self

    async def __aexit__(self, *args):
        pass

    async def send(self, frame):
        if frame[1] == 0x22:
            await self.queue.put(response('我先记录异常并向班组长报告。', True))
        elif frame[1] == 0x20:
            await self.queue.put(response('我先记录异常'))

    async def recv(self):
        return response()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()


def remove_speech_rows():
    with SessionLocal() as db:
        for candidate_id in (LISTENING, ANSWERING, LEGACY):
            for old in db.query(ListeningSession).filter_by(candidate_id=candidate_id).all():
                db.query(ListeningContext).filter_by(session_id=old.id).delete()
            db.query(ListeningSession).filter_by(candidate_id=candidate_id).delete()
            db.query(SpeechCapture).filter_by(kind='listening', target_id=candidate_id).delete()
            for interview in db.query(Interview).filter_by(candidate_id=candidate_id).all():
                db.query(SpeechCapture).filter_by(kind='interview', target_id=interview.id).delete()
                db.delete(interview)
            db.query(Candidate).filter_by(id=candidate_id).delete()
        db.query(SpeechCapture).filter_by(owner='speech-test').delete()
        db.query(User).filter_by(username='speech-test').delete()
        db.commit()


@pytest.fixture
def real_speech(client, monkeypatch, tmp_path):
    # 语音转写已启用并配置了密钥（测试用的假密钥）；与语音服务的连接换成本地替身。
    monkeypatch.setenv('TALENTFLOW_ASR_MODE', 'doubao')
    monkeypatch.setenv('DOUBAO_ASR_API_KEY', 'synthetic-test')
    monkeypatch.setattr(doubao_asr, 'connection', lambda: FakeRemote())
    monkeypatch.setattr(speech_routes, 'DATA_DIR', tmp_path)
    remove_speech_rows()
    with SessionLocal() as db:
        db.add(Interview(candidate_id=LISTENING, job_id=1, batch_id=1, question_version=1, consented=True,
                         consent_version=intelligence.current_notice()[0]))
        session = ListeningSession(candidate_id=LISTENING, status='running', source_mode='doubao')
        db.add(session)
        db.flush()
        db.add(ListeningContext(session_id=session.id, consent='{"accepted":true}'))
        db.commit()
    yield
    remove_speech_rows()


def ticket(client, headers, **extra):
    body = {'kind': 'listening', 'target_id': LISTENING, 'consented': True, **extra}
    return client.post('/api/speech/tickets', headers=headers('interviewer', 'speech-test'), json=body)


def test_protocol_round_trip_and_invalid_frame():
    data, final = doubao_asr.parse_packet(response('测试', True))
    assert final and data['result']['text'] == '测试'
    init = doubao_asr.initial_packet()
    assert json.loads(gzip.decompress(init[8:]))['audio']['rate'] == 16000
    for broken in (b'', b'12345678', response()[:-1]):
        with pytest.raises((ValueError, struct.error)):
            doubao_asr.parse_packet(broken)


def test_speech_requires_consent_permission_and_scope(real_speech, client, headers):
    assert ticket(client, headers, consented=False).status_code == 409
    assert ticket(client, headers, target_id=99999).status_code == 409
    denied = client.post('/api/speech/tickets', headers=headers('hr_admin', 'hr'),
                         json={'kind': 'listening', 'target_id': LISTENING, 'consented': True})
    assert denied.status_code == 403
    assert ticket(client, headers, phase='followup').status_code == 409
    assert ticket(client, headers, question_id=1).status_code == 409


def test_listening_ticket_needs_a_valid_consent_record(real_speech, client, headers):
    # 旁听录音既要本场的告知确认，也要候选人在系统内的同意仍然有效（或面试官现场确认）。
    assert ticket(client, headers).status_code == 200
    with SessionLocal() as db:
        db.query(Interview).filter_by(candidate_id=LISTENING).update({'consented': False})
        db.commit()
    assert ticket(client, headers).status_code == 409
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=LISTENING).one()
        db.get(ListeningContext, session.id).consent = json.dumps({'accepted': True, 'method': intelligence.ONSITE_METHOD})
        db.commit()
    assert ticket(client, headers).status_code == 200
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=LISTENING).one()
        db.get(ListeningContext, session.id).consent = '{}'
        db.commit()
    assert ticket(client, headers).status_code == 409


def test_stream_persists_final_audio_timestamps_and_single_use_ticket(real_speech, client, headers):
    t = ticket(client, headers).json()
    url = f"/api/speech/stream?ticket={t['ticket']}"
    with client.websocket_connect(url, headers={'origin': 'http://127.0.0.1:5173'}) as ws:
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(bytes(3200))
        assert ws.receive_json()['type'] == 'partial'
        ws.send_text('finish')
        assert ws.receive_json()['type'] == 'partial'
        assert ws.receive_json()['type'] == 'final'
    h = headers('interviewer', 'speech-test')
    saved = client.get(f"/api/speech/captures/{t['capture_id']}", headers=h).json()
    assert saved['status'] == 'completed'
    assert saved['transcript'] == '我先记录异常并向班组长报告。'
    assert saved['result']['result']['utterances'][0]['end_time'] == 100
    audio = client.get(f"/api/speech/captures/{t['capture_id']}/audio", headers=h)
    assert audio.status_code == 200 and audio.content[:4] == b'RIFF'
    assert len(audio.content) == 3244
    # 复核和旁听人员可以回听录音核对评价依据；候选人和没有报告、旁听权限的角色不能读取。
    for role in ('report_reviewer', 'interviewer'):
        assert client.get(f"/api/speech/captures/{t['capture_id']}", headers=headers(role, role)).status_code == 200
        assert client.get(f"/api/speech/captures/{t['capture_id']}/audio", headers=headers(role, role)).status_code == 200
    for role in ('candidate', 'question_reviewer'):
        assert client.get(f"/api/speech/captures/{t['capture_id']}", headers=headers(role, role)).status_code == 403
        assert client.get(f"/api/speech/captures/{t['capture_id']}/audio", headers=headers(role, role)).status_code == 403
    assert client.get('/api/speech/captures/not-a-capture', headers=h).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(url, headers={'origin': 'http://127.0.0.1:5173'}):
            pass
    attach = f'/api/listening/{LISTENING}/capture'
    for _ in range(2):
        assert client.post(attach, headers=h, json={'capture_id': t['capture_id']}).status_code == 200
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=LISTENING).one()
        assert len(json.loads(session.transcript)) == 1
        assert db.get(SpeechCapture, t['capture_id']).status == 'linked'
    # 其他面试官采集的录音不能关联到自己的旁听记录里。
    other = headers('interviewer', 'another-interviewer')
    assert client.post(attach, headers=other, json={'capture_id': t['capture_id']}).status_code == 403


def test_stream_disconnect_keeps_audio_and_partial(real_speech, client, headers):
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers={'origin': 'http://localhost:5173'}) as ws:
        ws.receive_json()
        ws.send_bytes(bytes(3200))
        ws.receive_json()
    with SessionLocal() as db:
        c = db.get(SpeechCapture, t['capture_id'])
        assert c.status == 'interrupted' and c.transcript == '我先记录异常'
        with wave.open(str(speech_routes.DATA_DIR / c.audio_path)) as wav:
            assert wav.getnframes() == 1600
        with pytest.raises(HTTPException):
            speech_routes.get_capture(db, c.id, {'user': c.owner, 'role': c.role}, 'listening', c.target_id)


RECOVERED_TEXT = '我先记录异常，再向班组长报告，最后复核处理结果。'
ORIGIN = {'origin': 'http://127.0.0.1:5173'}


class DroppingRemote(FakeRemote):
    """握手和第一包音频正常，之后与语音服务的连接中断。"""

    async def __aenter__(self):
        self.packets = 0
        return await super().__aenter__()

    async def send(self, frame):
        if frame[1] == 0x20:
            self.packets += 1
            if self.packets > 1:
                raise ConnectionError('connection to provider lost')
        await super().send(frame)


class RejectingRemote(FakeRemote):
    """停止录音时语音服务返回错误，没有给出最终结果。"""

    async def send(self, frame):
        if frame[1] == 0x22:
            await self.queue.put(bytes([0x11, 0xF0, 0x10, 0]) + struct.pack('>I', 45000081))
        else:
            await super().send(frame)


class SavedAudioRemote(FakeRemote):
    """整段录音补转写：收完音频后才返回结果。"""
    received = 0

    async def send(self, frame):
        if frame[1] == 0x22:
            await self.queue.put(response(RECOVERED_TEXT, True))
        elif frame[1] == 0x20:
            SavedAudioRemote.received += len(gzip.decompress(frame[8:]))


def use_remotes(monkeypatch, live, saved=SavedAudioRemote):
    """实时转写和整段补转写分别连接到指定的替身；返回每次连接使用的接口地址。"""
    calls = []

    def connect(endpoint=None):
        calls.append(endpoint or doubao_asr.ENDPOINT)
        return (saved if endpoint == doubao_asr.SAVED_AUDIO_ENDPOINT else live)()

    SavedAudioRemote.received = 0
    monkeypatch.setattr(doubao_asr, 'connection', connect)
    monkeypatch.setattr(speech_routes, 'HANDSHAKE_PAUSE', 0)
    return calls


def unreachable():
    raise OSError('network unreachable')


def saved_capture(capture_id):
    with SessionLocal() as db:
        capture = db.get(SpeechCapture, capture_id)
        with wave.open(str(speech_routes.DATA_DIR / capture.audio_path)) as wav:
            frames = wav.getnframes()
        notes = [(row.action, row.detail) for row in db.query(AuditLog).filter_by(
            target_type='speech_capture', target_id=capture_id).order_by(AuditLog.id)]
        return capture.status, capture.transcript, frames, notes


def test_connecting_to_the_speech_service_is_retried(real_speech, client, headers, monkeypatch):
    attempts = []

    def connect(endpoint=None):
        attempts.append(endpoint)
        if len(attempts) < 3:
            unreachable()
        return FakeRemote()

    monkeypatch.setattr(doubao_asr, 'connection', connect)
    monkeypatch.setattr(speech_routes, 'HANDSHAKE_PAUSE', 0)
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers=ORIGIN) as ws:
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(bytes(3200))
        assert ws.receive_json()['type'] == 'partial'
        ws.send_text('finish')
        assert ws.receive_json()['type'] == 'partial'
        final = ws.receive_json()
    assert final['type'] == 'final' and final['recovered'] is False
    assert len(attempts) == 3
    status, transcript, _, notes = saved_capture(t['capture_id'])
    assert (status, transcript) == ('completed', '我先记录异常并向班组长报告。')
    assert [action for action, _ in notes] == ['speech_consent', 'speech_transcribed']


def test_unreachable_speech_service_is_reported_with_its_reason(real_speech, client, headers, monkeypatch):
    calls = use_remotes(monkeypatch, unreachable)
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers=ORIGIN) as ws:
        failed = ws.receive_json()
    assert failed['type'] == 'error' and '连接不上语音转写服务' in failed['message']
    assert len(calls) == speech_routes.HANDSHAKE_ATTEMPTS
    status, transcript, frames, notes = saved_capture(t['capture_id'])
    assert (status, transcript, frames) == ('interrupted', '', 0)
    # 失败原因写进操作记录，便于事后排查；页面上只给候选人看得懂的说明。
    action, detail = notes[-1]
    assert action == 'speech_interrupted' and '连接语音服务' in detail and 'OSError' in detail
    assert 'OSError' not in failed['message']


def test_recording_continues_and_is_transcribed_from_saved_audio_when_live_transcription_drops(
        real_speech, client, headers, monkeypatch):
    calls = use_remotes(monkeypatch, DroppingRemote)
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers=ORIGIN) as ws:
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(bytes(3200))
        assert ws.receive_json()['type'] == 'partial'
        ws.send_bytes(bytes(3200))
        notice = ws.receive_json()
        assert notice['type'] == 'notice' and '录音仍在保存' in notice['message']
        ws.send_bytes(bytes(3200))
        ws.send_text('finish')
        assert ws.receive_json()['type'] == 'recovering'
        final = ws.receive_json()
    assert final == {'type': 'final', 'text': RECOVERED_TEXT, 'capture_id': t['capture_id'], 'recovered': True}
    assert calls == [doubao_asr.ENDPOINT, doubao_asr.SAVED_AUDIO_ENDPOINT]
    # 中断之后的录音没有丢：三包音频都保存了，也都交给了补转写。
    status, transcript, frames, notes = saved_capture(t['capture_id'])
    assert (status, transcript, frames) == ('completed', RECOVERED_TEXT, 4800)
    assert SavedAudioRemote.received == 9600
    action, detail = notes[-1]
    assert action == 'speech_transcribed' and '用保存的录音重新转写' in detail and 'ConnectionError' in detail
    h = headers('interviewer', 'speech-test')
    assert client.post(f'/api/listening/{LISTENING}/capture', headers=h, json={'capture_id': t['capture_id']}).status_code == 200


def test_missing_final_result_is_recovered_from_saved_audio(real_speech, client, headers, monkeypatch):
    use_remotes(monkeypatch, RejectingRemote)
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers=ORIGIN) as ws:
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(bytes(3200))
        assert ws.receive_json()['type'] == 'partial'
        ws.send_text('finish')
        assert [ws.receive_json()['type'] for _ in range(2)] == ['notice', 'recovering']
        final = ws.receive_json()
    assert final['type'] == 'final' and final['text'] == RECOVERED_TEXT
    status, transcript, frames, notes = saved_capture(t['capture_id'])
    assert (status, transcript, frames) == ('completed', RECOVERED_TEXT, 1600)
    assert '45000081' in notes[-1][1]


def test_failed_recovery_keeps_the_audio_and_never_invents_a_transcript(real_speech, client, headers, monkeypatch):
    use_remotes(monkeypatch, RejectingRemote, saved=unreachable)
    t = ticket(client, headers).json()
    with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers=ORIGIN) as ws:
        assert ws.receive_json()['type'] == 'ready'
        ws.send_bytes(bytes(3200))
        assert ws.receive_json()['type'] == 'partial'
        ws.send_text('finish')
        assert [ws.receive_json()['type'] for _ in range(2)] == ['notice', 'recovering']
        failed = ws.receive_json()
    assert failed['type'] == 'error' and '重新录制' in failed['message']
    status, transcript, frames, notes = saved_capture(t['capture_id'])
    # 只保留语音服务实际返回过的文字；没有最终结果的录音不能作为回答提交。
    assert (status, transcript, frames) == ('interrupted', '我先记录异常', 1600)
    assert notes[-1][0] == 'speech_interrupted' and '用录音重新转写' in notes[-1][1]
    with SessionLocal() as db:
        capture = db.get(SpeechCapture, t['capture_id'])
        with pytest.raises(HTTPException):
            speech_routes.get_capture(db, capture.id, {'user': capture.owner, 'role': capture.role}, 'listening', LISTENING)


def test_stream_rejects_untrusted_origin(real_speech, client, headers):
    t = ticket(client, headers).json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/speech/stream?ticket={t['ticket']}", headers={'origin': 'https://evil.invalid'}):
            pass


def test_real_listening_excludes_legacy_simulated_transcripts(real_speech, client, headers):
    with SessionLocal() as db:
        db.add(Candidate(id=LEGACY, code='SPEECH-LEGACY', name='旧旁听记录', batch_id=1, job_id=1))
        db.add(ListeningSession(candidate_id=LEGACY, status='completed', source_mode='mock',
                                transcript=json.dumps(['旧模拟文本']), comprehensive_report='{"old":true}'))
        db.commit()
    state = client.get(f'/api/listening/{LEGACY}', headers=headers('interviewer', 'speech-test')).json()
    assert state['asr_mode'] == 'doubao' and state['transcript'] == [] and state['status'] == 'ready'
    assert state['comprehensive_report'] is None
    with SessionLocal() as db:
        old = db.query(ListeningSession).filter_by(candidate_id=LEGACY, source_mode='mock').one()
        assert json.loads(old.transcript) == ['旧模拟文本']
        assert json.loads(old.comprehensive_report) == {'old': True}


def test_listening_state_is_not_created_for_unknown_candidates(real_speech, client, headers):
    h = headers('interviewer', 'speech-test')
    assert client.get('/api/listening/99999', headers=h).status_code == 404
    assert client.post('/api/listening/99999/prepare', headers=h).status_code == 404
    assert client.post('/api/listening/99999/start', headers=h, json={'consented': True, 'candidate_confirmed': True}).status_code == 404
    with SessionLocal() as db:
        assert db.query(ListeningSession).filter_by(candidate_id=99999).count() == 0


def test_real_answers_use_only_final_server_transcript(real_speech, client, headers):
    with SessionLocal() as db:
        interview = Interview(candidate_id=ANSWERING, batch_id=1, job_id=1, question_version=1,
                              status='in_progress', consented=True, current_question=1)
        db.add(interview)
        db.flush()
        iid = interview.id
        db.add(User(username='speech-test', display_name='语音测试候选人', role='candidate', candidate_id=ANSWERING))
        db.add(SpeechCapture(id='test-real-answer', owner='speech-test', role='candidate',
                            kind='interview', target_id=iid, question_id=1,
                            status='completed', transcript='只保存这段真实回答', audio_path='recordings/test.wav'))
        db.commit()
    h = headers('candidate', 'speech-test')
    url = f'/api/interviews/{iid}/answers'
    body = {'question_id': 1, 'transcript': '客户端伪造文本', 'generate_followup': False}
    assert client.post(url, headers=h, json=body).status_code == 403
    saved = client.post(url, headers=h, json={**body, 'capture_id': 'test-real-answer', 'timed_out': True})
    assert saved.status_code == 200 and saved.json()['transcript'] == '只保存这段真实回答'
