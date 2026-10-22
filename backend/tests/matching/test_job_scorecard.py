import copy

import pytest

from matching_core.services import job_scorecard as scorecard, workflow


@pytest.fixture
def model(monkeypatch):
    monkeypatch.setattr(scorecard, 'model_settings', lambda: dict(provider='external', confirmed=True, key='test-secret', url='https://example.invalid', http_allowed=False))
    result = {'dimensions': [
        {'name': '客户开发', 'weight': 50, 'keywords': ['客户开发', '客户拜访'], 'reason': '重点职责是开发客户', 'evidence_ids': [0]},
        {'name': '商务沟通', 'weight': 30, 'keywords': ['商务沟通', '客户交流'], 'reason': '要求商务沟通能力', 'evidence_ids': [1]},
        {'name': '客户维护', 'weight': 20, 'keywords': ['客户维护', '客户服务'], 'reason': '职责包括客户维护', 'evidence_ids': [0]},
    ]}
    def analyze(self, text, job):
        assert self.model == 'chat-primary' and self.task == 'job_scorecard'
        assert '负责客户开发与维护' in text
        return copy.deepcopy(result)
    monkeypatch.setattr(scorecard.ExternalModelAdapter, 'analyze', analyze)
    return result


def job():
    return {'name': '销售专员', 'responsibilities': ['负责客户开发与维护'], 'requirements': ['具备商务沟通能力']}


def test_generates_editable_scorecard_with_valid_weights_and_evidence(model):
    result = scorecard.generate_job_scorecard(job())
    assert sum(result['weights'].values()) == 100
    assert len(result['dimensions']) == 3
    assert result['basis'][0]['evidence'] == ['负责客户开发与维护']


@pytest.mark.parametrize('failure', ['total', 'nan', 'duplicate', 'evidence'])
def test_invalid_suggestions_are_rejected(model, failure):
    if failure == 'total':
        model['dimensions'][0]['weight'] = 10
    elif failure == 'nan':
        model['dimensions'][0]['weight'] = float('nan')
    elif failure == 'duplicate':
        model['dimensions'][1]['name'] = '客户开发'
    else:
        model['dimensions'][0]['evidence_ids'] = [999]
    with pytest.raises(ValueError):
        scorecard.generate_job_scorecard(job())


def test_import_without_dimensions_auto_generates_and_keeps_source_fields(tmp_path, model):
    parsed = dict(job(), metadata={'name': '销售专员', 'sequence': '营销类', 'level': 'P3'}, hard_conditions=[], dimensions=[], warning='', status='提取成功')
    draft = workflow._prepare_parsed_job(tmp_path / 'job.docx', parsed, None, tmp_path / 'unused.db')
    assert len(draft['dimensions']) == 3
    assert draft['weights']['客户开发'] == 50
    assert draft['requirements'] == parsed['requirements']
    assert draft['model_source'] == 'AI根据岗位说明书生成（待人工确认）'
    assert not (tmp_path / 'unused.db').exists()


def test_model_failure_keeps_imported_information_for_retry(tmp_path, monkeypatch):
    def fail(job):
        raise ValueError('服务暂不可用')
    monkeypatch.setattr(scorecard, 'generate_job_scorecard', fail)
    parsed = dict(job(), metadata={'name': '销售专员'}, hard_conditions=[], dimensions=[], warning='', status='提取成功')
    draft = workflow._prepare_parsed_job(tmp_path / 'job.docx', parsed, None, tmp_path / 'unused.db')
    assert draft['name'] == '销售专员'
    assert draft['responsibilities'] == parsed['responsibilities']
    assert draft['scorecard_error'] == '服务暂不可用'
    assert draft['dimensions'] == []


def test_extra_valid_citations_and_keywords_do_not_discard_suggestions(model):
    model['dimensions'][0]['keywords'] = [f'能力{i}' for i in range(8)]
    model['dimensions'][0]['evidence_ids'] = list(range(7))
    source = dict(job(), responsibilities=[f'负责客户开发与维护{i}' for i in range(7)])
    result = scorecard.generate_job_scorecard(source)
    assert len(result['basis'][0]['evidence']) == 7
    assert len(result['dimensions'][0]['keywords']) == 8


def test_complete_source_scorecard_is_used_without_generation(tmp_path, monkeypatch):
    def unexpected(*args):
        raise AssertionError('Source standards must take precedence')
    monkeypatch.setattr(scorecard, 'generate_job_scorecard', unexpected)
    dims = [{'name': '客户开发', 'keywords': ['客户拜访']}, {'name': '客户维护', 'keywords': ['服务']}]
    parsed = dict(job(), metadata={'name': '销售专员'}, dimensions=dims, weights={'客户开发': 70, '客户维护': 30}, hard_conditions=[], warning='', status='成功')
    draft = workflow._prepare_parsed_job(tmp_path / 'job.txt', parsed, 'unused-reference', tmp_path / 'unused.db')
    assert draft['dimensions'] == dims
    assert draft['weights'] == parsed['weights']
    assert draft['model_source'] == '文件明确维度及权重'


def test_partial_source_weights_are_preserved_when_completing(model):
    dims = [{'name': name, 'keywords': ['原始关键词']} for name in ('客户开发', '商务沟通', '客户维护')]
    source = dict(job(), dimensions=dims, weights={'客户开发': 50})
    result = scorecard.generate_job_scorecard(source)
    assert result['dimensions'] == [dict(d, negative_keywords=[]) for d in dims]
    assert result['weights'] == {'客户开发': 50, '商务沟通': 30, '客户维护': 20}
    model['dimensions'][0]['weight'] = 60
    model['dimensions'][1]['weight'] = 20
    with pytest.raises(ValueError, match='改动了原文'):
        scorecard.generate_job_scorecard(source)


def test_failed_partial_generation_keeps_original_weights(tmp_path, monkeypatch):
    monkeypatch.setattr(scorecard, 'generate_job_scorecard', lambda job: (_ for _ in ()).throw(ValueError('连接失败')))
    dims = [{'name': '客户开发', 'keywords': ['拜访']}, {'name': '商务沟通', 'keywords': ['谈判']}]
    parsed = dict(job(), metadata={'name': '销售专员'}, dimensions=dims, weights={'客户开发': 70}, hard_conditions=[], warning='', status='成功')
    draft = workflow._prepare_parsed_job(tmp_path / 'job.txt', parsed, None, tmp_path / 'unused.db')
    assert draft['weights'] == {'客户开发': 70, '商务沟通': 0}
    assert draft['source_weights'] == {'客户开发': 70}
    assert draft['scorecard_error'] == '连接失败'
