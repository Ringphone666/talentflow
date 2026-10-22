import json
from types import SimpleNamespace

import pytest
from backend.app.core.database import SessionLocal
from backend.app.interview.models import Candidate, ListeningSession, SpeechCapture, Report, ReportVersion, Interview, User
from backend.app.interview import listening_intelligence as intelligence

from . import support

STAGE_KEYS = ('report_id', 'version', 'version_type', 'status', 'content')


@pytest.fixture
def listening(client, headers, monkeypatch, created):
    """一名已完成第一阶段面试、尚未在系统内确认最新采集告知的虚构候选人。"""
    # 语音转写已启用并配置了密钥（测试用的假密钥，不会发起连接）。
    monkeypatch.setenv('TALENTFLOW_ASR_MODE', 'doubao')
    monkeypatch.setenv('DOUBAO_ASR_API_KEY', 'synthetic-test')
    record = support.create_completed_candidate(created, 'TWO-STAGE-001', '两阶段测试', consented=False)
    with SessionLocal() as db:
        db.add(User(username='two-stage-candidate', display_name=record['name'], role='candidate',
                    candidate_id=record['candidate_id']))
        db.commit()
    h = headers('interviewer', 'two-stage-tester')
    return SimpleNamespace(h=h, code=record['code'], id=record['candidate_id'], interview_id=record['interview_id'],
                           report_id=record['report_id'], url=f"/api/listening/{record['candidate_id']}",
                           candidate=headers('candidate', 'two-stage-candidate'))


def frozen(stage):
    """旁听开始时锁定的第一阶段报告；锁定后另附当时的简历和岗位要求。"""
    return {key: stage[key] for key in STAGE_KEYS}


def begin(client, listening):
    state = client.get(listening.url, headers=listening.h).json()
    assert state['mode'] == 'linked' and state['prior_consent_valid'] is False
    assert client.post(f'/api/interviews/{listening.interview_id}/consent', headers=listening.candidate,
                       json={'consented': True, 'notice_version': intelligence.current_notice()[0]}).status_code == 200
    assert state['stage_one']['report_id'] == listening.report_id
    response = client.post(listening.url + '/start', headers=listening.h, json={
        'consented': True, 'candidate_confirmed': True, 'candidate_code': listening.code, 'notice_version': state['notice_version']})
    assert response.status_code == 200
    assert response.json()['mode'] == 'linked'
    return state


def add_capture(listening, transcript, **fields):
    return support.add_capture('two-stage-test', listening.id, transcript, owner='two-stage-tester', **fields)


def label(client, listening, speaker, capture_id='two-stage-test'):
    return client.post(listening.url + '/speaker', headers=listening.h, json={'capture_id': capture_id, 'speaker': speaker})


def test_candidate_consent_and_report_version_are_preserved(client, listening):
    # 候选人没有系统内的同意记录，面试官也没有确认现场告知时，不能开始旁听。
    assert client.post(listening.url + '/start', headers=listening.h, json={'consented': True}).status_code == 409
    assert client.post(listening.url + '/start', headers=listening.h, json={'candidate_confirmed': True}).status_code == 409
    state = begin(client, listening)
    after = client.get(listening.url, headers=listening.h).json()
    assert after['status'] == 'running' and after['mode'] == 'linked' and after['prior_consent_valid'] is True
    assert after['consent_record']['candidate_code'] == listening.code
    assert after['consent_record']['video'] is False
    assert frozen(after['stage_one']) == frozen(state['stage_one'])
    assert after['stage_one']['job']['name'] == after['job']['name']
    assert after['stage_one']['listening_resume'] == after['resume_context']
    # 系统内已有同意记录时引用该记录，不因面试官勾选现场确认而改写取得方式。
    assert after['consent_record']['method'] == '引用前置两阶段合规告知'
    assert after['consent_record']['interview_id'] == listening.interview_id
    assert 'confirmed_at' in after['consent_record']
    # Resuming does not overwrite consent timestamp or the frozen report.
    client.post(listening.url + '/start', headers=listening.h, json={'consented': True})
    resumed = client.get(listening.url, headers=listening.h).json()
    assert resumed['consent_record'] == after['consent_record']
    assert resumed['stage_one'] == after['stage_one']


def test_two_stage_suggestions_and_combined_report(client, listening):
    original = begin(client, listening)['stage_one']
    add_capture(listening, '我记录了异常数据，并请班组长复核后隔离该批次。')
    assert label(client, listening, 'interviewer').status_code == 200
    assert label(client, listening, 'judge').status_code == 422
    no_candidate = client.post(listening.url + '/suggest', headers=listening.h).json()
    assert no_candidate['suggestions'] == [] and no_candidate['skipped']
    assert client.post(listening.url + '/finish', headers=listening.h).status_code == 409
    label(client, listening, 'candidate')
    suggestions = client.post(listening.url + '/suggest', headers=listening.h).json()['suggestions']
    assert len(suggestions) == 1
    assert suggestions[0]['report_id'] == original['report_id']
    assert suggestions[0]['report_version'] == original['version']
    assert suggestions[0]['capture_id'] == 'two-stage-test'
    assert suggestions[0]['answer_excerpt'] in '我记录了异常数据，并请班组长复核后隔离该批次。'
    assert client.post(listening.url + '/suggest', headers=listening.h).json()['skipped'] == '没有新增回答证据'
    assert client.post(listening.url + '/suggestions', headers=listening.h, json={'suggestion_id': 1, 'action': 'dropped'}).status_code == 422
    assert client.post(listening.url + '/suggestions', headers=listening.h, json={'suggestion_id': 9, 'action': 'adopted'}).status_code == 404
    assert client.post(listening.url + '/suggestions', headers=listening.h, json={'suggestion_id': 1, 'action': 'adopted'}).status_code == 200
    combined = client.post(listening.url + '/finish', headers=listening.h)
    assert combined.status_code == 200
    result = combined.json()
    assert result['mode'] == 'linked' and result['status'] == 'pending_review'
    assert frozen(result['stage_one']) == frozen(original)
    assert len(result['stage_one_evaluations']) == 6 and result['stage_one_summary']
    assert result['findings'][0]['answer_excerpt']
    assert result['findings'][0]['stage_one_excerpt'] in json.dumps(original['content'], ensure_ascii=False)
    assert result['decision'] is None and result['adopted_questions'] == [suggestions[0]['text']]
    assert client.post(listening.url + '/finish', headers=listening.h).json() == result
    # 结束后不能重新开始或继续标注，历史记录不被覆盖。
    assert client.post(listening.url + '/start', headers=listening.h, json={'consented': True}).status_code == 409
    assert label(client, listening, 'interviewer').status_code == 403
    with SessionLocal() as db:
        report = db.get(Report, original['report_id'])
        assert report.current_version == original['version']
        version = db.query(ReportVersion).filter_by(report_id=report.id, version=report.current_version).one()
        assert json.loads(version.content) == original['content']


def test_model_gets_both_stages_and_fabricated_quotes_are_rejected(client, listening, monkeypatch):
    stage = begin(client, listening)['stage_one']
    add_capture(listening, '我的原始回答')
    label(client, listening, 'candidate')
    monkeypatch.setattr(intelligence.text_models, 'enabled', lambda: True)
    calls = []
    def fake_request(model, task, data, schema, **kwargs):
        calls.append(data)
        assert data['first_stage_report'] == {key: stage[key] for key in ('report_id', 'version', 'status', 'content')}
        assert data['second_stage'][0]['text'] == '我的原始回答'
        assert data['job']['name'] and 'dimensions' not in data
        return intelligence.SuggestionBatch(suggestions=[intelligence.LinkedSuggestion(text='请补充具体做法',reason='核实',dimension='岗位专业能力',stage_one_excerpt='不存在的报告原文',capture_id='two-stage-test',answer_excerpt='伪造回答')])
    monkeypatch.setattr(intelligence.text_models, 'request_json', fake_request)
    assert client.post(listening.url + '/suggest', headers=listening.h).status_code == 502
    # 引用定位不到时要求模型校正一次，仍然不可靠就不保存。
    assert len(calls) == 2 and 'validation_error' in calls[1]
    assert client.get(listening.url, headers=listening.h).json()['suggestions'] == []


@pytest.mark.parametrize('finish', [False, True])
def test_misquoted_two_stage_evidence_is_corrected_before_saving(client, listening, monkeypatch, finish):
    stage = begin(client, listening)['stage_one']
    add_capture(listening, '我安排2人调配，4人分批到岗。')
    label(client, listening, 'candidate')
    quote = next(s for s in intelligence.strings(stage['content']) if s)
    monkeypatch.setattr(intelligence.text_models, 'enabled', lambda: True)
    calls = []
    def reply(model, task, data, schema, **kwargs):
        calls.append(data)
        common = {'dimension': '岗位专业能力', 'stage_one_excerpt': quote,
                  'capture_id': 'two-stage-test', 'answer_excerpt': '我安排两人调配' if len(calls) == 1 else '我安排2人调配'}
        if finish:
            return intelligence.CombinedReport(findings=[intelligence.CombinedFinding(**common,
                analysis='补充说明人员安排', status='新增证据待复核')])
        return intelligence.SuggestionBatch(suggestions=[intelligence.LinkedSuggestion(**common,
            text='请补充人员安排的依据。', reason='核实方案依据')])
    monkeypatch.setattr(intelligence.text_models, 'request_json', reply)
    response = client.post(listening.url + ('/finish' if finish else '/suggest'), headers=listening.h)
    assert response.status_code == 200, response.text
    assert len(calls) == 2 and 'validation_error' in calls[1]
    rows = response.json()['findings' if finish else 'suggestions']
    assert rows[0]['answer_excerpt'] == '我安排2人调配'
    assert calls[1]['second_stage'][0]['text'] == '我安排2人调配，4人分批到岗。'
    if finish:
        assert response.json()['generation_mode'] == '文本模型分析'


def test_slow_text_service_still_lets_the_interviewer_finish(client, listening, monkeypatch):
    from fastapi import HTTPException
    mark = support.audit_mark(client)
    begin(client, listening)
    add_capture(listening, '我先记录异常，再请班组长复核。')
    label(client, listening, 'candidate')
    monkeypatch.setattr(intelligence.text_models, 'enabled', lambda: True)
    def unavailable(*args, **kwargs):
        raise HTTPException(502, '无法连接AI服务，请联系管理员检查模型服务连接')
    monkeypatch.setattr(intelligence.text_models, 'request_json', unavailable)
    # 补充提问不降级：服务不可用时如实报错。
    assert client.post(listening.url + '/suggest', headers=listening.h).status_code == 502
    # 结束旁听时保全原文证据，标明需要人工补充结论。
    finished = client.post(listening.url + '/finish', headers=listening.h)
    assert finished.status_code == 200, finished.text
    result = finished.json()
    assert result['generation_mode'] == '证据保全降级'
    assert result['findings'][0]['capture_id'] == 'two-stage-test'
    assert result['findings'][0]['answer_excerpt'] in '我先记录异常，再请班组长复核。'
    assert result['findings'][0]['human_review_required'] is True and result['decision'] is None
    audits = support.audits_since(client, mark, action='combined_report_generated')
    assert len(audits) == 1 and '证据保全' in audits[0]['detail'] and audits[0]['actor'] == 'two-stage-tester'


def test_listening_sends_frozen_resume_speaker_segments_and_question_history(client, listening, monkeypatch):
    with SessionLocal() as db:
        candidate = db.get(Candidate, listening.id)
        candidate.resume_ocr_status = 'completed'
        candidate.resume_ocr_text = '负责质量改进项目'
        db.commit()
    begin(client, listening)
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=listening.id, source_mode='doubao').one()
        session.suggestions = json.dumps([{'id': 1, 'text': '过去问题', 'status': 'ignored', 'edited_text': ''}])
        db.get(Candidate, listening.id).resume_ocr_text = '后来更新的其他经历'
        db.commit()
    add_capture(listening, '我检查了质量记录', speaker_status='completed',
                speaker_result=json.dumps({'turns': [{'cluster_id': 'voice-1', 'start_ms': 0, 'end_ms': 1000}]}),
                provider_result=json.dumps({'result': {'utterances': [{'text': '我检查了质量记录', 'start_time': 0, 'end_time': 1000}]}}))
    label(client, listening, 'candidate')
    monkeypatch.setattr(intelligence.text_models, 'enabled', lambda: True)
    seen = []
    def reply(model, task, data, schema, **kwargs):
        seen.append(data)
        assert data['resume']['text'] == '负责质量改进项目'
        assert data['previous_questions'][0]['status'] == 'ignored'
        assert data['second_stage'][0]['speaker_analysis']['segments'][0]['clusters'] == ['voice-1']
        return intelligence.SuggestionBatch(suggestions=[])
    monkeypatch.setattr(intelligence.text_models, 'request_json', reply)
    assert client.post(listening.url + '/suggest', headers=listening.h).status_code == 200
    assert len(seen) == 1


def test_continuous_dialogue_is_uncertain_and_does_not_require_manual_label(client, listening, monkeypatch):
    stage = begin(client, listening)['stage_one']
    ticket = client.post('/api/speech/tickets', headers=listening.h, json={'kind': 'listening', 'target_id': listening.id, 'consented': True}).json()
    cid = ticket['capture_id']
    with SessionLocal() as db:
        capture = db.get(SpeechCapture, cid)
        capture.status = 'recording'
        capture.transcript = '请说明你的处理过程。我先记录异常并请班组长核实。'
        db.commit()
    quote = next(s for s in intelligence.strings(stage['content']) if s)
    monkeypatch.setattr(intelligence.text_models, 'enabled', lambda: True)
    def fake_request(model, task, data, schema, **kwargs):
        assert data['second_stage'][-1]['speaker'] == 'dialogue'
        assert '不是候选人独白' in task
        return intelligence.SuggestionBatch(suggestions=[intelligence.LinkedSuggestion(text='请补充异常判断标准。',reason='核实',dimension='岗位专业能力',stage_one_excerpt=quote,capture_id=cid,answer_excerpt='我先记录异常并请班组长核实。',speaker_basis='疑似在回答前一句提问，身份须现场核实')])
    monkeypatch.setattr(intelligence.text_models, 'request_json', fake_request)
    result = client.post(listening.url + '/suggest', headers=listening.h).json()['suggestions'][0]
    assert result['speaker_inferred'] and result['provisional']
    assert result['speaker_basis']
    # 录音尚未停止时不能结束旁听。
    assert client.post(listening.url + '/finish', headers=listening.h).status_code == 409
    with SessionLocal() as db:
        db.query(Interview).filter_by(candidate_id=listening.id).update({'consented': False})
        db.commit()
    assert client.post(listening.url + '/suggest', headers=listening.h).status_code == 409
    assert client.post('/api/speech/tickets', headers=listening.h, json={'kind': 'listening', 'target_id': listening.id, 'consented': True}).status_code == 409
