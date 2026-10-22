import copy
from . import helpers
import pytest
from matching_core.services import candidate_scoring as ai
from matching_core.services.scoring import score_value, annotate_score_evidence, assessment_summary_data, evaluate_fit_metadata
from matching_core.services.model_adapter import ModelError


@pytest.fixture
def assessment(monkeypatch):
    job = dict(name='工程师', weights={'技术': 60, '协作': 40}, hard_conditions=[{'name': '本科'}])
    parsed = {'raw_evidence': [{'text': '本科，开发系统并协调跨部门项目', 'file': '材料.pdf', 'location': '第1行'}]}
    output = {'dimensions': [{'name': '技术', 'score': 80, 'status': '已评估', 'reason': '具备系统开发经历', 'evidence_ids': [0]},
                             {'name': '协作', 'score': 60, 'status': '已评估', 'reason': '有跨部门项目经验，职责深度待核验', 'evidence_ids': [0]}],
              'hard_checks': [{'name': '本科', 'status': '满足', 'reason': '材料明确本科', 'evidence_ids': [0]}]}
    monkeypatch.setattr(ai, 'model_settings', lambda: dict(provider='external', confirmed=True, key='fake-secret', url='https://example.invalid',
                       reasoning_model='chat-reasoner', http_allowed=False, reasoning_max_tokens=4096))
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', lambda *args: copy.deepcopy(output))
    return job, parsed, output


def test_total_and_commentary_share_validated_dimensions(assessment):
    job, parsed, output = assessment
    score = ai.add_ai_score({'total': 99}, parsed, job)
    assert score_value(score) == 72
    assert score['reasoning_analysis']['status'] == '调用成功'
    assert score['dimensions'][0]['evidence'][0]['file'] == '材料.pdf'
    assert '具备系统开发经历' in score['strengths'][0]
    assert annotate_score_evidence(score, [])['total'] == 72


def test_unknown_does_not_mean_zero_or_normalize_remaining_weights(assessment):
    job, parsed, output = assessment
    output['dimensions'][1].update(score=None, status='待核实', evidence_ids=[])
    score = ai.add_ai_score({}, parsed, job)
    assert score_value(score) == 48
    assert score['assessed_score'] == 80
    assert score['coverage_percent'] == 60
    assert score['assessment_status'] == '待补充材料'
    assert score['dimensions'][1]['weighted'] is None


@pytest.mark.parametrize('bad', [float('nan'), 101, -1, True, '80'])
def test_invalid_score_never_adopted(assessment, bad):
    job, parsed, output = assessment
    output['dimensions'][0]['score'] = bad
    score = ai.add_ai_score({'total': 99}, parsed, job)
    assert score_value(score) == 24
    assert score['dimensions'][0]['score'] is None
    assert score['dimensions'][1]['score'] == 60
    assert score['reasoning_analysis']['recovery']['pending_dimensions'] == ['技术']


def test_fabricated_reference_and_duplicate_dimensions_rejected(assessment):
    job, parsed, output = assessment
    output['dimensions'][0]['evidence_ids'] = [999]
    score = ai.add_ai_score({}, parsed, job)
    assert score_value(score) == 24
    assert score['dimensions'][0]['evidence'] == []
    output['dimensions'][0]['evidence_ids'] = [0]
    output['dimensions'][1]['name'] = '技术'
    assert score_value(ai.add_ai_score({}, parsed, job)) is None


def test_service_failure_has_no_keyword_fallback(assessment, monkeypatch):
    job, parsed, output = assessment
    def fail(*args):
        raise ModelError('服务超时')
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', fail)
    score = ai.add_ai_score({'total': 95}, parsed, job)
    assert score_value(score) is None
    assert '服务超时' in score['reasoning_analysis']['reason']


def test_workflow_persistence_cross_job_and_report(assessment, monkeypatch, tmp_path):
    import json
    from docx import Document
    from .fixture_data import init_db
    from .test_demo import processed_candidate
    from matching_core.services import workflow as w
    from matching_core.services.report import export_report
    def respond(self, text, job):
        payload = json.loads(text)
        return {'dimensions': [{'name': name, 'score': 80, 'status': '已评估',
                                'reason': '项目证据符合岗位标准', 'evidence_ids': [0]} for name in payload['job']['weights']],
                'hard_checks': [{'name': h['name'], 'status': '无法确认', 'reason': '需要补充核验', 'evidence_ids': []}
                                for h in payload['job']['hard_conditions']]}
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', respond)
    db = tmp_path / 'test.db'
    init_db(db)
    task, cid = processed_candidate(db)
    candidate = w.get_candidate(cid, db)
    assert candidate['score']['total'] == 80
    matches = w.evaluate_candidate_jobs(cid, [candidate['job_id']], '招聘人员', db)
    assert matches[0]['score']['total'] == 80
    w.rescore_candidate(cid, '招聘人员', db)
    assert w.get_candidate(cid, db)['score']['assessment_status'] == 'AI已评分'
    helpers.update_candidate_fields(cid, {'education': '已确认本科'}, '招聘人员', db)
    w.rescore_candidate(cid, '招聘人员', db)
    w.save_review(cid, '核对完成', '保留', '招聘人员', db)
    path = export_report(w.get_candidate(cid, db), w.get_job(candidate['job_id'], db), '招聘人员', db, tmp_path / 'report.docx')
    text = '\n'.join(p.text for p in Document(path).paragraphs)
    assert 'AI逐项评分依据' in text
    assert '项目证据符合岗位标准' in text


def test_weighted_reference_and_coverage_order():
    from matching_core.services.scoring import summarize_ai_score, score_sort_key
    partial = {'scoring_method':'ai_semantic_v1', 'dimensions':[{'dimension':'A','weight':20,'score':95},{'dimension':'B','weight':80,'score':None}]}
    complete = {'scoring_method':'ai_semantic_v1', 'dimensions':[{'dimension':'A','weight':20,'score':60},{'dimension':'B','weight':80,'score':70}]}
    assert summarize_ai_score(partial)['total'] == 19
    assert partial['assessed_score'] == 95
    assert partial['coverage_percent'] == 20
    assert summarize_ai_score(complete)['total'] == 68
    assert score_sort_key(complete) > score_sort_key(partial)


def test_ranking_uses_comprehensive_score_not_coverage_bucket():
    from matching_core.services.scoring import score_sort_key
    partial = {'scoring_method': 'ai_semantic_v1', 'dimensions': [
        {'dimension': 'A', 'weight': 70, 'score': 100}, {'dimension': 'B', 'weight': 30, 'score': None}]}
    complete = {'scoring_method': 'ai_semantic_v1', 'dimensions': [
        {'dimension': 'A', 'weight': 70, 'score': 60}, {'dimension': 'B', 'weight': 30, 'score': 60}]}
    assert score_sort_key(partial) > score_sort_key(complete)
    assert assessment_summary_data(partial)['conclusion'] == '待补充材料'


def test_zero_weight_assessed_dimension_can_be_reweighted_without_model():
    from matching_core.services.scoring import summarize_ai_score
    score = {'scoring_method': 'ai_semantic_v1', 'dimensions': [
        {'dimension': 'A', 'weight': 100, 'score': 80, 'evidence_available': True},
        {'dimension': 'B', 'weight': 0, 'score': 40, 'evidence_available': True}]}
    summarize_ai_score(score)
    assert score['total'] == 80
    assert score['dimensions'][1]['evidence_available']
    for d in score['dimensions']:
        d['weight'] = 50
    summarize_ai_score(score)
    assert score['total'] == 60 and score['coverage_percent'] == 100


def test_summary_distinguishes_missing_materials_from_ability_gap(assessment):
    job, parsed, output = assessment
    output['dimensions'][1].update(score=None, status='待核实', reason='尚未提供协作经历', evidence_ids=[])
    score = ai.add_ai_score({}, parsed, job)
    summary = assessment_summary_data(score, job)
    assert summary['total'] == 48
    assert summary['conclusion'] == '待补充材料'
    assert summary['gaps'] and summary['gaps'][0].startswith('待核实 · 协作')
    assert '不判断能力差距' in summary['gaps'][0]
    assert summary['missing_dimensions'] == ['协作']
    assert '能力为零' in summary['score_note']
    assert any('协作' in question for question in summary['questions'])
    assert not summary['recommended']
    assert evaluate_fit_metadata([], job, score)['recommendation_level'] == '待补充材料'


@pytest.mark.parametrize('status, conclusion', [('不满足', '硬性条件存在差距'), ('无法确认', '硬性条件待核实')])
def test_high_score_does_not_override_hard_condition_findings(assessment, status, conclusion):
    job, parsed, output = assessment
    for d in output['dimensions']:
        d['score'] = 95
    output['hard_checks'][0]['status'] = status
    summary = assessment_summary_data(ai.add_ai_score({}, parsed, job), job)
    assert summary['total'] == 95
    assert summary['conclusion'] == conclusion
    assert not summary['recommended']
    assert summary['verification'] and summary['risks']


def test_failed_and_completely_unknown_never_become_zero_scores(assessment, monkeypatch):
    job, parsed, output = assessment
    for d in output['dimensions']:
        d.update(score=None, status='待核实', evidence_ids=[])
    score = ai.add_ai_score({}, parsed, job)
    assert score['total'] is None and score['assessed_score'] is None
    assert assessment_summary_data(score)['conclusion'] == '待补充材料'
    def fail(*args):
        raise ModelError('服务超时')
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', fail)
    score = ai.add_ai_score({}, parsed, job)
    summary = assessment_summary_data(score)
    assert summary['total'] is None and summary['conclusion'] == '评分未完成'
    assert any('服务超时' in risk for risk in summary['risks'])


def test_optional_analysis_is_evidence_linked_and_from_same_call(assessment, monkeypatch):
    job, parsed, output = assessment
    output['analysis'] = {'strengths': [{'text': '具有系统开发与跨部门协作的结合经验', 'evidence_ids': [0]}],
                          'questions': [{'text': '请举例说明开发项目中你如何解决跨部门接口分歧？', 'evidence_ids': [0]}]}
    calls = []
    def respond(*args):
        calls.append(1)
        return copy.deepcopy(output)
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', respond)
    score = ai.add_ai_score({}, parsed, job)
    summary = assessment_summary_data(score, job)
    assert len(calls) == 1
    assert summary['strengths'][0] == output['analysis']['strengths'][0]['text']
    assert summary['questions'][0] == output['analysis']['questions'][0]['text']
    output['analysis']['questions'][0]['evidence_ids'] = [999]
    score = ai.add_ai_score({}, parsed, job)
    assert score_value(score) == 72
    assert score['reasoning_analysis']['recovery']['analysis_discarded']
    assert score['reasoning_analysis']['comprehensive_sections'] == {}


def test_historical_decoding_recomputes_without_rewriting_json():
    import json
    from matching_core.db import decode_candidate_job_match
    historic = {'total': 95, 'assessment_status': '部分证据参考分', 'scoring_method': 'ai_semantic_v1',
                'dimensions': [{'dimension': 'A', 'weight': 20, 'score': 95}, {'dimension': 'B', 'weight': 80, 'score': None}]}
    raw = dict(tags_json='[]', score_json=json.dumps(historic), recommendation_level='旧推荐')
    decoded = decode_candidate_job_match(raw)
    assert decoded['score']['total'] == 19
    assert decoded['recommendation_level'] == '待补充材料'
    assert json.loads(raw['score_json'])['total'] == 95


def test_zero_is_retained_only_with_actual_assessed_evidence(assessment):
    job, parsed, output = assessment
    for d in output['dimensions']:
        d['score'] = 0
    score = ai.add_ai_score({}, parsed, job)
    assert score_value(score) == 0
    assert score['coverage_percent'] == 100
    assert assessment_summary_data(score)['conclusion'] == '匹配差距较大'


def test_strong_historical_assessment_has_useful_verification_and_questions(assessment):
    job, parsed, output = assessment
    for d in output['dimensions']:
        d['score'] = 90
    score = ai.add_ai_score({}, parsed, job)
    score['reasoning_analysis']['last_attempt'] = {'status': '未成功', 'reason': '请求超时'}
    summary = assessment_summary_data(score)
    assert summary['conclusion'] == '高度匹配'
    assert summary['verification'] and summary['questions']
    assert '技术' in summary['verification'][0]
    assert any('上次成功结果' in risk and '请求超时' in risk for risk in summary['risks'])


def test_changed_materials_keep_previous_score_but_cannot_recommend(assessment):
    job, parsed, output = assessment
    score = ai.add_ai_score({}, parsed, job)
    score['requires_reassessment'] = True
    summary = assessment_summary_data(score)
    assert summary['total'] == 72
    assert summary['conclusion'] == '资料已变更，待重新分析'
    assert not summary['recommended']
    assert '尚未反映最新' in summary['score_note']
    assert any('资料已变更' in risk for risk in summary['risks'])
    ai.add_ai_score(score, parsed, job)
    assert not score.get('requires_reassessment')
    assert assessment_summary_data(score)['conclusion'] != '资料已变更，待重新分析'


def test_telephone_work_evidence_is_retained_but_personal_attributes_removed(assessment, monkeypatch):
    job, parsed, output = assessment
    parsed['raw_evidence'] = [dict(text='电话沟通客户并协调跨部门开发', file='简历.pdf', location='第1行'),
                              dict(text='性别：男', file='简历.pdf', location='第2行'),
                              dict(text='人工核实教育：本科。', file='人工核实记录', location='字段：学历', origin='human_review', field_key='education')]
    sent = []
    def respond(self, text, job):
        import json
        sent.append(json.loads(text))
        return output
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', respond)
    assert score_value(ai.add_ai_score({}, parsed, job)) == 72
    assert len(sent[0]['evidence']) == 2
    assert sent[0]['evidence'][1]['origin'] == 'human_review'


def test_weight_only_changes_refresh_both_workflows_without_model_calls(assessment, monkeypatch, tmp_path):
    import json
    from .fixture_data import init_db
    from .test_demo import processed_candidate
    from matching_core.services import workflow as w
    calls = []
    def respond(self, text, job):
        payload = json.loads(text)
        calls.append(payload['job']['name'])
        names = list(payload['job']['weights'])
        return {'dimensions': [dict(name=name, score=(40 + index * 10) if index < len(names)-1 else None,
                                    status='已评估' if index < len(names)-1 else '待核实',
                                    reason='有相关项目依据' if index < len(names)-1 else '尚需补充相关材料',
                                    evidence_ids=[0] if index < len(names)-1 else []) for index, name in enumerate(names)],
                'hard_checks': [dict(name=h['name'], status='满足', reason='测试核验依据', evidence_ids=[0])
                                for h in payload['job']['hard_conditions']]}
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', respond)
    db = tmp_path / 'weight_refresh.db'
    init_db(db)
    _, cid = processed_candidate(db)
    candidate = w.get_candidate(cid, db)
    primary = w.get_job(candidate['job_id'], db)
    secondary = next(job for job in w.get_jobs(db) if job['id'] != primary['id'])
    w.evaluate_candidate_jobs(cid, [primary['id'], secondary['id']], '招聘人员', db)
    w.save_review(cid, '保留人工意见', '保留', '招聘人员', db)
    w.save_fit_decision(cid, secondary['id'], '保留适岗意见', '作为备选岗位', '招聘人员', db)
    before_primary = copy.deepcopy(w.get_candidate(cid, db)['score'])
    count = len(calls)
    names = list(secondary['weights'])
    weights = {name: 80 if i == 0 else 20 if i == len(names)-1 else 0 for i, name in enumerate(names)}
    updated = w.update_job_weights(secondary['id'], weights, '招聘人员', db)
    assert updated == 1
    assert len(calls) == count
    match = next(m for m in w.get_candidate_job_matches(candidate_id=cid, db_path=db) if m['job_id'] == secondary['id'])
    assert match['score']['total'] == 32
    assert match['score']['coverage_percent'] == 80
    assert match['score']['dimensions'][-1]['score'] is None
    assert match['score']['job_weight_version'] == w.get_job(secondary['id'], db)['weight_version']
    assert match['decision'] == '作为备选岗位' and match['review_comment'] == '保留适岗意见'
    assert w.get_candidate(cid, db)['score'] == before_primary

    names = list(primary['weights'])
    weights = {name: 100 if i == 0 else 0 for i, name in enumerate(names)}
    updated = w.update_job_weights(primary['id'], weights, '招聘人员', db)
    assert updated == 1
    assert len(calls) == count
    candidate = w.get_candidate(cid, db)
    assert candidate['score']['total'] == 40
    assert candidate['decision'] == '保留' and candidate['review_comment'] == '保留人工意见'
    match = next(m for m in w.get_candidate_job_matches(candidate_id=cid, db_path=db) if m['job_id'] == primary['id'])
    assert match['score']['total'] == candidate['score']['total']
    assert match['score']['job_weight_version'] == candidate['score']['job_weight_version']
