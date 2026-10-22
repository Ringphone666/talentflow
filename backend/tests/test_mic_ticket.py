import pytest
from fastapi import HTTPException
from backend.app.core.database import SessionLocal
from backend.app.interview.models import Interview, User, SpeechCapture
from backend.app.interview.speech_routes import get_capture


@pytest.fixture
def mic_interview(client, monkeypatch):
    monkeypatch.setenv('TALENTFLOW_ASR_MODE', 'doubao')
    monkeypatch.setenv('DOUBAO_ASR_API_KEY', 'synthetic-test')
    with SessionLocal() as db:
        interview = Interview(candidate_id=90991, job_id=1, batch_id=1, question_version=1,
                              status='mic_check', consented=True)
        db.add(interview)
        db.flush()
        interview_id = interview.id
        db.add(User(username='mic-ticket-test', display_name='设备检测测试', role='candidate',
                    candidate_id=90991))
        db.commit()
    yield interview_id
    with SessionLocal() as db:
        db.query(SpeechCapture).filter_by(owner='mic-ticket-test').delete()
        db.query(User).filter_by(username='mic-ticket-test').delete()
        db.query(Interview).filter_by(candidate_id=90991).delete()
        db.commit()


def test_mic_test_ticket_checks_owner_consent_stage_and_cannot_be_answer(client, headers, mic_interview):
    interview_id = mic_interview
    body = {'kind': 'mic_check', 'target_id': interview_id, 'consented': True}
    auth = headers('candidate', 'mic-ticket-test')
    assert client.post('/api/speech/tickets', headers=headers('candidate', 'candidate'), json=body).status_code == 403
    # 设备检测只属于候选人本人，工作人员也不能代为申请。
    assert client.post('/api/speech/tickets', headers=headers('hr_admin', 'hr'), json=body).status_code == 403
    assert client.post('/api/speech/tickets', headers=auth, json={**body, 'consented': False}).status_code == 409
    for invalid in ({'question_id': 1}, {'phase': 'followup'}):
        assert client.post('/api/speech/tickets', headers=auth, json={**body, **invalid}).status_code == 422
    assert client.post('/api/speech/tickets', headers=auth, json={**body, 'kind': 'unknown'}).status_code == 422
    response = client.post('/api/speech/tickets', headers=auth, json=body)
    assert response.status_code == 200
    with SessionLocal() as db:
        capture = db.get(SpeechCapture, response.json()['capture_id'])
        assert capture.kind == 'mic_check' and capture.question_id is None
        capture.status = 'completed'
        capture.transcript = '麦克风测试，一二三'
        db.commit()
        with pytest.raises(HTTPException) as denied:
            get_capture(db, capture.id, {'user': 'mic-ticket-test', 'role': 'candidate'},
                        'interview', interview_id, question_id=1)
        assert denied.value.status_code == 403
        interview = db.get(Interview, interview_id)
        interview.consented = False
        db.commit()
    assert client.post('/api/speech/tickets', headers=auth, json=body).status_code == 409
    with SessionLocal() as db:
        interview = db.get(Interview, interview_id)
        interview.consented = True
        interview.status = 'in_progress'
        db.commit()
    assert client.post('/api/speech/tickets', headers=auth, json=body).status_code == 409


def test_tickets_are_not_issued_without_real_speech_recognition(client, headers, mic_interview, monkeypatch):
    # 测试环境的模拟转写不发放录音凭证，避免把模拟结果当成真实采集。
    monkeypatch.setenv('TALENTFLOW_ASR_MODE', 'mock')
    body = {'kind': 'mic_check', 'target_id': mic_interview, 'consented': True}
    assert client.post('/api/speech/tickets', headers=headers('candidate', 'mic-ticket-test'), json=body).status_code == 409
    with SessionLocal() as db:
        assert db.query(SpeechCapture).filter_by(owner='mic-ticket-test').count() == 0
