"""Offline regressions for bounded, evidence-preserving scoring recovery."""
import copy
import json

import pytest

from matching_core.services import candidate_scoring as scoring
from matching_core.services import model_adapter
from matching_core.services.model_adapter import ModelError


@pytest.fixture
def case(monkeypatch):
    job = {'name': '测试岗位', 'weights': {'技术': 60, '协作': 40}, 'hard_conditions': [{'name': '本科'}]}
    parsed = {'raw_evidence': [{'text': '本科毕业，开发系统并协调项目', 'file': '测试材料.pdf', 'location': '第1行'}]}
    output = {'dimensions': [
        {'name': '技术', 'status': '已评估', 'score': 80, 'reason': '具有开发经历', 'evidence_ids': [0]},
        {'name': '协作', 'status': '已评估', 'score': 60, 'reason': '参与协调项目', 'evidence_ids': [0]}],
        'hard_checks': [{'name': '本科', 'status': '满足', 'reason': '提供本科学历', 'evidence_ids': [0]}]}
    monkeypatch.setattr(scoring, 'model_settings', lambda: {
        'provider': 'external', 'confirmed': True, 'key': 'test-only-secret', 'url': 'https://example.invalid',
        'reasoning_model': 'chat-reasoner', 'http_allowed': False, 'reasoning_max_tokens': 4096})
    return job, parsed, output


def responses(monkeypatch, values):
    calls = []
    def once(adapter, text, job):
        calls.append({'feedback': adapter.correction_feedback, 'payload': json.loads(text)})
        value = values[min(len(calls) - 1, len(values) - 1)]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)
    monkeypatch.setattr(model_adapter.ExternalModelAdapter, '_analyze_once', once)
    return calls


def test_normalizes_only_legal_references_without_an_extra_request(case, monkeypatch):
    job, parsed, output = case
    parsed['raw_evidence'] += [dict(text=f'测试项目经历{i}', file='测试材料.pdf', location=f'第{i+1}行') for i in range(1, 4)]
    output['dimensions'][0]['evidence_ids'] = [' 0 ', 0, '1', 2, 3, 3]
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({}, parsed, job)
    assert result['total'] == 72 and len(calls) == 1
    assert [e['text'] for e in result['dimensions'][0]['evidence']] == [e['text'] for e in parsed['raw_evidence'][:3]]
    recovery = result['reasoning_analysis']['recovery']
    assert recovery['status'] == 'normalized' and not recovery['attempted']
    assert set(recovery['normalizations'][0]['changes']) == {'numeric_string', 'duplicate_reference', 'reference_limit'}


@pytest.mark.parametrize('ids', [[1], [-1], [True], [0.0], ['1.0'], [0, 999], '0', [None]])
def test_invalid_citation_gets_one_correction_then_only_its_dimension_is_pending(case, monkeypatch, ids):
    job, parsed, output = case
    output['dimensions'][0]['evidence_ids'] = ids
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({'total': 99}, parsed, job)
    assert len(calls) == 2
    feedback = json.loads(calls[1]['feedback'])
    assert feedback['valid_evidence_ids'] == [0]
    assert feedback['schema']['dimensions'] and feedback['dimension_names'] == ['技术', '协作']
    assert feedback['errors'][0]['code'] == 'SCORING_EVIDENCE'
    assert result['total'] == 24 and result['coverage_percent'] == 40
    assert result['dimensions'][0]['score'] is None and result['dimensions'][0]['evidence'] == []
    assert result['dimensions'][1]['score'] == 60
    state = result['reasoning_analysis']
    assert state['status'] == '调用成功' and state['retryable']
    assert state['recovery']['pending_dimensions'] == ['技术']
    assert state['recovery']['status'] == 'partial' and state['recovery']['attempted']
    assert state['diagnostics']['error_code'] == 'SCORING_EVIDENCE'


def test_correction_fills_rejected_row_without_overwriting_verified_scores(case, monkeypatch):
    job, parsed, valid = case
    first, second = copy.deepcopy(valid), copy.deepcopy(valid)
    first['dimensions'][0]['evidence_ids'] = [999]
    second['dimensions'][0]['score'] = 85
    second['dimensions'][1]['score'] = 99
    calls = responses(monkeypatch, [first, second])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 75
    assert result['dimensions'][1]['score'] == 60
    recovery = result['reasoning_analysis']['recovery']
    assert recovery['status'] == 'corrected' and recovery['corrected'] and recovery['attempted']
    assert result['reasoning_analysis']['diagnostics']['error_code'] == ''


def test_complementary_valid_rows_survive_a_partially_invalid_correction(case, monkeypatch):
    job, parsed, valid = case
    first, second = copy.deepcopy(valid), copy.deepcopy(valid)
    first['dimensions'][0]['evidence_ids'] = [999]
    second['dimensions'][1]['evidence_ids'] = [999]
    calls = responses(monkeypatch, [first, second])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 72
    assert result['reasoning_analysis']['recovery']['status'] == 'corrected'
    assert result['reasoning_analysis']['diagnostics']['error_code'] == ''


@pytest.mark.parametrize('network_first', [True, False])
def test_transport_and_validation_failures_share_two_request_budget(case, monkeypatch, network_first):
    job, parsed, output = case
    output['dimensions'][0]['evidence_ids'] = [999]
    timeout = ModelError('等待模型响应超时', 'TIMEOUT', True)
    calls = responses(monkeypatch, [timeout, output] if network_first else [output, timeout])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 24
    diagnostic = result['reasoning_analysis']['diagnostics']
    assert diagnostic['attempts'] == diagnostic['max_attempts'] == 2
    assert set(diagnostic['error_codes']) == {'TIMEOUT', 'SCORING_EVIDENCE'}
    assert result['reasoning_analysis']['recovery']['attempted'] is (not network_first)


def test_all_rejected_dimensions_stay_unscored_and_retryable(case, monkeypatch):
    job, parsed, output = case
    for item in output['dimensions']:
        item['evidence_ids'] = [999]
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({'total': 100}, parsed, job)
    assert len(calls) == 2 and result['total'] is None and result['assessed_score'] is None
    assert result['reasoning_analysis']['status'] == '未成功'
    assert result['reasoning_analysis']['recovery']['status'] == 'failed'
    assert result['reasoning_analysis']['retryable']
    assert all(item['score'] is None for item in result['dimensions'])


def test_legitimate_all_unknown_assessment_is_successful_without_retry(case, monkeypatch):
    from matching_core.services.scoring import assessment_summary_data
    job, parsed, output = case
    for item in output['dimensions']:
        item.update(status='待核实', score=None, reason='尚缺相关项目证明材料', evidence_ids=[])
    output['hard_checks'][0].update(status='无法确认', reason='请补充学历证明', evidence_ids=[])
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 1 and result['total'] is None
    state = result['reasoning_analysis']
    assert state['status'] == '调用成功' and state['recovery']['status'] == 'not_needed'
    assert not state['recovery']['attempted'] and state['diagnostics']['error_code'] == ''
    assert assessment_summary_data(result, job)['conclusion'] == '待补充材料'


def test_rejected_hard_condition_does_not_erase_dimension_scores(case, monkeypatch):
    job, parsed, output = case
    output['hard_checks'][0]['evidence_ids'] = [999]
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 72
    assert result['hard_checks'][0]['status'] == '无法确认'
    assert result['hard_checks'][0]['sources'] == []
    assert result['reasoning_analysis']['recovery']['pending_hard_conditions'] == ['本科']


def test_missing_empty_hard_checks_schema_is_reported_as_corrected(case, monkeypatch):
    job, parsed, output = case
    job['hard_conditions'] = []
    output['hard_checks'] = []
    first = copy.deepcopy(output)
    del first['hard_checks']
    calls = responses(monkeypatch, [first, output])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 72
    assert result['reasoning_analysis']['recovery']['status'] == 'corrected'


def test_malformed_correction_keeps_valid_rows_from_first_response(case, monkeypatch):
    job, parsed, output = case
    output['dimensions'][0]['evidence_ids'] = [999]
    calls = responses(monkeypatch, [output, None])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 2 and result['total'] == 24
    assert result['reasoning_analysis']['recovery']['status'] == 'partial'


@pytest.mark.parametrize('analysis', [[], {'questions': [{'text': '请核验项目贡献', 'evidence_ids': [999]}]},
                                      {'risks': [{'text': 'test-only-secret', 'evidence_ids': [0]}]}])
def test_optional_invalid_analysis_does_not_retry_or_erase_scoring(case, monkeypatch, analysis):
    job, parsed, output = case
    output['analysis'] = analysis
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({}, parsed, job)
    assert len(calls) == 1 and result['total'] == 72
    assert result['reasoning_analysis']['comprehensive_sections'] == {}
    assert result['reasoning_analysis']['recovery']['analysis_discarded']
    assert 'test-only-secret' not in json.dumps(result, ensure_ascii=False)


def test_unsafe_dimension_reason_is_not_saved_or_echoed_in_retry(case, monkeypatch):
    job, parsed, output = case
    output['dimensions'][0]['reason'] = 'test-only-secret'
    calls = responses(monkeypatch, [output])
    result = scoring.add_ai_score({}, parsed, job)
    assert result['total'] == 24 and len(calls) == 2
    assert 'test-only-secret' not in json.dumps(result, ensure_ascii=False)
    assert 'test-only-secret' not in calls[1]['feedback']


def test_correction_feedback_is_sent_as_system_instruction(case, monkeypatch):
    job, parsed, output = case
    first = copy.deepcopy(output)
    first['dimensions'][0]['evidence_ids'] = [999]
    requests = []
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, limit):
            payload = first if len(requests) == 1 else output
            return json.dumps({'model': 'chat-reasoner', 'choices': [{'finish_reason': 'stop', 'message': {
                'content': json.dumps(payload, ensure_ascii=False)}}]}).encode()
    class Opener:
        def open(self, request, timeout):
            requests.append(json.loads(request.data))
            return Response()
    monkeypatch.setattr(model_adapter, 'build_opener', lambda *args: Opener())
    result = scoring.add_ai_score({}, parsed, job)
    assert result['total'] == 72 and len(requests) == 2
    assert 'valid_evidence_ids' not in requests[0]['messages'][0]['content']
    assert '"valid_evidence_ids": [0]' in requests[1]['messages'][0]['content']
    assert requests[0]['messages'][1] == requests[1]['messages'][1]
