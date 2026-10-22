import httpx
import pytest
from fastapi import HTTPException
from backend.app.interview import retrieval_models, standards
from backend.app.interview import text_models as m


def test_invalid_evidence_cannot_be_scored():
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=5, reason='优秀',
        answer_ids=['A1'], evidence_excerpt='不存在的证据', insufficient=False) for d in standards.DIMENSIONS])
    with pytest.raises(HTTPException) as error:
        m.validate_evaluations(raw, [{'answer_code': 'A1', 'transcript': '我核对了记录'}])
    assert error.value.status_code == 502


@pytest.mark.parametrize('score,text', [(1, '我不会处理这个问题。'), (0, '喂喂喂喂喂喂。'), (2, '先沟通再处理。'), (4, '我核实需求后分解计划并按时完成。')])
def test_underperformance_and_good_answers_keep_grounded_scores(score, text):
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=score, reason='依据本次回答展示程度评分',
        answer_ids=['A1'], evidence_excerpt=text, insufficient=False) for d in standards.DIMENSIONS])
    rows = m.validate_evaluations(raw, [{'answer_code': 'A1', 'transcript': text, 'timed_out': True}])
    assert all(row['score'] == score and row['answer_ids'] == ['A1'] and row['reason'] == '依据本次回答展示程度评分' for row in rows)
    assert all(row['level'] == f'{score}级' and row['insufficient'] is False for row in rows)


def test_silence_stays_unscored_with_specific_reason():
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=None, reason='未收到可理解的回答，请核实录音。',
        answer_ids=[], evidence_excerpt='', insufficient=True) for d in standards.DIMENSIONS])
    rows = m.validate_evaluations(raw, [{'answer_code': 'A1', 'transcript': '', 'followup_answer': '追问超时未作答'}])
    assert all(row['score'] is None and row['reason'] == '未收到可理解的回答，请核实录音。' for row in rows)


def test_greeting_answer_cannot_be_silently_left_unscored():
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=None, reason='只有问候',
        answer_ids=[], evidence_excerpt='', insufficient=True) for d in standards.DIMENSIONS])
    with pytest.raises(HTTPException) as error:
        m.validate_evaluations(raw, [{'answer_code': 'A1', 'dimension': '岗位专业能力', 'transcript': '喂喂喂。'}])
    assert '按本题作答表现评分' in error.value.detail


def test_timeout_placeholder_cannot_be_used_as_low_score_evidence():
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=1, reason='未展示能力',
        answer_ids=['A1'], evidence_excerpt='超时未作答', insufficient=False) for d in standards.DIMENSIONS])
    with pytest.raises(HTTPException):
        m.validate_evaluations(raw, [{'answer_code': 'A1', 'transcript': '超时未作答'}])


def test_quote_links_only_the_answer_that_contains_it():
    raw = m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=2, reason='回答概括',
        answer_ids=['A1', 'A2'], evidence_excerpt='先沟通再处理', insufficient=False) for d in standards.DIMENSIONS])
    rows = m.validate_evaluations(raw, [
        {'answer_code': 'A1', 'transcript': '先沟通再处理'},
        {'answer_code': 'A2', 'transcript': '其他问题的回答'},
    ])
    assert all(row['score'] == 2 and row['answer_ids'] == ['A1'] for row in rows)


def test_bad_scoring_quote_is_retried_instead_of_erasing_scores(monkeypatch):
    monkeypatch.setattr(m, 'enabled', lambda: True)
    monkeypatch.setattr(m, 'status', lambda: {})
    monkeypatch.setattr(retrieval_models, 'embed', lambda docs: {})
    monkeypatch.setattr(retrieval_models, 'rerank', lambda *args: {})
    attempts = []
    def reply(model, task, data, schema, **kwargs):
        if schema is m.Evaluations:
            assert kwargs['max_tokens'] == 12000
            attempts.append(data)
            assert '0至5分' in task and '空白' in standards.RUBRIC['0'] and '不得保底给1分' in task
            return schema(evaluations=[m.Evaluation(dimension=d[0], score=1, reason='本次未展示具体方法，需进一步核实',
                answer_ids=['A1'], evidence_excerpt='改写了原话' if len(attempts) == 1 else '我不会',
                insufficient=False) for d in standards.DIMENSIONS])
        return m.Narrative(summary='本次回答未展示基本方法', matched=[], to_verify=[], risks=[], offline_questions=[])
    monkeypatch.setattr(m, 'request_json', reply)
    report = m.build_report('测试', [{'answer_code': 'A1', 'transcript': '我不会'}])
    assert len(attempts) == 2 and 'validation_error' in attempts[1]
    assert all(row['score'] == 1 for row in report['evaluations'])
    assert report['match_analysis']['score'] == 20
    assert report['scoring_policy'] == 'answer-performance-v3-zero'
    assert report['match_analysis']['matched'] == []
    assert len(report['match_analysis']['to_verify']) == 6


def test_summary_cannot_erase_existing_scores():
    narrative = m.Narrative(summary='所有维度证据不足', matched=[], to_verify=[], risks=[], offline_questions=[])
    with pytest.raises(HTTPException):
        m.validate_report_narrative(narrative, [{'score': 0}] * 6, [], {})


def test_live_followup_requires_exact_evidence(monkeypatch):
    monkeypatch.setenv('TALENTFLOW_TEXT_MODE', 'live')
    monkeypatch.setattr(m, 'request_json', lambda *args: m.Followup(content='你使用了什么标准？', basis='伪造证据'))
    with pytest.raises(HTTPException) as error:
        m.generate_followup(1, '我核对了记录')
    assert error.value.status_code == 502


def test_transport_error_does_not_fall_back(monkeypatch):
    monkeypatch.setattr(m, 'get_key', lambda: 'synthetic-test')
    def fail(*args, **kwargs):
        raise httpx.ConnectError('synthetic')
    monkeypatch.setattr(httpx.Client, 'post', fail)
    with pytest.raises(HTTPException) as error:
        m.request_json('chat-primary', 'test', {}, m.Followup)
    assert error.value.status_code == 502
    assert 'synthetic-test' not in error.value.detail


def test_followup_retries_misquoted_asr_numbers_without_changing_original(monkeypatch):
    monkeypatch.setattr(m, 'enabled', lambda: True)
    calls = []
    transcript = '最终安排2人调配，4人分批招聘。'
    def reply(model, task, data, schema):
        calls.append(data)
        return m.Followup(content='你怎样跟踪分批到岗的进度？',
                          basis='安排两人调配' if len(calls) == 1 else '安排2人调配')
    monkeypatch.setattr(m, 'request_json', reply)
    result = m.generate_followup(2, transcript)
    assert result['basis'] == '安排2人调配'
    assert result['allowed'] is True
    assert len(calls) == 2 and 'validation_error' in calls[1]
    assert all(call['answer'] == transcript for call in calls)


def test_scoring_advice_has_room_for_complete_six_dimension_output(monkeypatch):
    monkeypatch.setenv('TALENTFLOW_TEXT_MODE', 'live')
    monkeypatch.setattr(m, 'get_key', lambda: 'synthetic-test')
    job = {'code': 'TEST', 'name': '测试岗位', 'duties': '质量管理', 'professional_requirements': '质量控制'}
    result = m.mock.build_scoring_advice(job)
    def respond(self, url, **kwargs):
        assert kwargs['json']['max_tokens'] == 12000
        assert self.timeout.read == 75
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'finish_reason': 'stop', 'message': {'content': m.json.dumps(result)}}],
        })
    monkeypatch.setattr(httpx.Client, 'post', respond)
    advice = m.generate_scoring_advice(job)
    assert len(advice['criteria']) == 6
    assert sum(row['suggested_weight'] for row in advice['criteria']) == 100


def test_truncated_output_is_retried_with_more_room_and_never_parsed(monkeypatch):
    monkeypatch.setattr(m, 'get_key', lambda: 'synthetic-test')
    limits = []
    def respond(self, url, **kwargs):
        limits.append(kwargs['json']['max_tokens'])
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'finish_reason': 'length' if len(limits) == 1 else 'stop', 'message': {
                'content': '{' if len(limits) == 1 else m.json.dumps({'content': '你使用了什么标准？', 'basis': '我核对了记录'})
            }}],
        })
    monkeypatch.setattr(httpx.Client, 'post', respond)
    result = m.request_json('chat-primary', 'test', {}, m.Followup)
    assert limits == [6000, 12000]
    assert result.basis == '我核对了记录'


@pytest.mark.parametrize('failure,status,detail', [
    ('length', 502, '超出长度限制'),
    ('timeout', 504, '响应超时'),
    ('unauthorized', 503, '身份验证失败'),
    ('invalid', 502, '格式不完整'),
])
def test_model_failures_explain_the_actionable_cause(monkeypatch, failure, status, detail):
    monkeypatch.setattr(m, 'get_key', lambda: 'synthetic-test')
    def respond(self, url, **kwargs):
        if failure == 'timeout':
            raise httpx.ReadTimeout('private-provider-detail')
        if failure == 'unauthorized':
            return httpx.Response(401, request=httpx.Request('POST', url))
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'finish_reason': 'length' if failure == 'length' else 'stop', 'message': {'content': '{'}}],
        })
    monkeypatch.setattr(httpx.Client, 'post', respond)
    with pytest.raises(HTTPException) as error:
        m.request_json('chat-primary', 'test', {}, m.Followup)
    assert error.value.status_code == status
    assert detail in error.value.detail
    assert 'synthetic-test' not in error.value.detail
    assert 'private-provider-detail' not in error.value.detail


def test_report_routes_two_models_and_keeps_identity_local(monkeypatch):
    monkeypatch.setenv('TALENTFLOW_TEXT_MODE', 'live')
    # 文本模型已配置密钥（测试用的假密钥）；模型请求在下面换成本地替身，不会用到它。
    monkeypatch.setenv('TALENTFLOW_LLM_API_KEY', 'synthetic-test')
    # 检索只做证据排序；测试中替换掉，保证不读取密钥、不访问模型服务。
    monkeypatch.setattr(retrieval_models, 'embed', lambda docs: {})
    monkeypatch.setattr(retrieval_models, 'rerank', lambda *args: {})
    calls = []
    def fake(model, task, data, schema, **kwargs):
        calls.append((model, data))
        if schema is m.Evaluations:
            return m.Evaluations(evaluations=[m.Evaluation(dimension=d[0], score=3, reason='引用回答',
                answer_ids=['A1'], evidence_excerpt='我核对了记录', insufficient=False) for d in standards.DIMENSIONS])
        return m.Narrative(summary='待复核纪要', matched=[], to_verify=['补充核实'], risks=[], offline_questions=['判断标准是什么？'])
    monkeypatch.setattr(m, 'request_json', fake)
    report = m.build_report('虚构姓名', [{'answer_code': 'A1', 'transcript': '我核对了记录'}])
    assert [call[0] for call in calls] == ['chat-evaluation', 'chat-primary']
    assert all('虚构姓名' not in str(data) for _, data in calls)
    assert report['decision'] is None
    assert report['model_provenance']['mode'] == 'live'


def test_fixed_results_are_only_available_in_test_runtime(monkeypatch):
    # 正式环境未启用文本模型时必须明确报错，不能返回测试用的固定结果。
    monkeypatch.setenv('TALENTFLOW_TEXT_MODE', 'mock')
    monkeypatch.setenv('TALENTFLOW_RUNTIME_PROFILE', 'production')
    assert m.status()['mode'] == 'unavailable' and m.status()['asr'] == 'unavailable'
    job = {'code': 'TEST', 'name': '测试岗位', 'duties': '质量管理', 'professional_requirements': '质量控制'}
    for call in (lambda: m.generate_questions(job), lambda: m.generate_followup(1, '我核对了记录'),
                 lambda: m.build_report('测试', []), lambda: m.generate_scoring_advice(job)):
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 503
    monkeypatch.setenv('TALENTFLOW_RUNTIME_PROFILE', 'test')
    assert m.status()['mode'] == 'mock' and m.status()['asr'] == 'mock'
    questions = m.generate_questions(job, 8)
    assert len(questions) == 8 and len({content for _, content in questions}) == 8
    assert [dimension for dimension, _ in questions[:6]] == [item[0] for item in standards.DIMENSIONS]
