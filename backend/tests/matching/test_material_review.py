import copy
from . import helpers
import json
from pathlib import Path

import pytest

from .fixture_data import init_db
from matching_core.db import connect, row
from matching_core.services import workflow as w
from matching_core.services import candidate_scoring, model_adapter
from matching_core.services.material_review import (
    MATERIAL_FIELD_LABELS, effective_material_evidence, material_text, prepare_material_update,
)
from matching_core.services.parser import parse_candidate


@pytest.fixture
def materials(tmp_path, monkeypatch):
    database = tmp_path / 'material.sqlite'
    init_db(database)
    original = tmp_path / 'resume.pdf'
    original.write_bytes(b'original PDF never changes')
    text = '姓名：待人工确认\n教育经历：本科\n专业技能：旧的Python识别结果\n工作经历：三年系统维护\n面试评价：原纪要需要核实'
    def parse(path, *args, **kwargs):
        parsed = parse_candidate(text, path.name)
        parsed['model_analysis'] = {}
        return parsed, dict(detected=False, types=[]), text
    monkeypatch.setattr(w, 'parse_material', parse)
    monkeypatch.setattr(w, 'enrich_candidate', lambda value: value)
    def assess(score, parsed, job, *args):
        score.update(scoring_method='ai_semantic_v1', total=80,
                     reasoning_analysis=dict(status='调用成功', reason='测试评分'),
                     dimensions=[dict(dimension=k, score=80, weight=v, evidence_available=True)
                                 for k, v in job['weights'].items()])
    monkeypatch.setattr(w, 'analyze_score', assess)
    jobs = ['JOB-TECH-001', 'JOB-SALES-001']
    task = w.create_fit_task(jobs, [original.name], '招聘人员', database)
    cid = w.process_fit_task(task, [original], '招聘人员', db_path=database)[0]
    return database, task, cid, jobs, original


def test_name_fields_minutes_and_snapshot_can_be_corrected_without_changing_pdf(materials):
    db, task, cid, jobs, source = materials
    before = w.get_candidate(cid, db)
    changed = {key: '已核实' + label for key, label in MATERIAL_FIELD_LABELS.items()}
    result = w.update_candidate_material(cid, changed, '招聘人员', db, full_name='测试甲', confirmed=False,
                                         expected_material_version=0)
    assert result['full_name'] == result['parsed']['full_name'] == '测试甲'
    assert result['masked_name'] == result['parsed']['masked_name'] == '测**'
    assert result['parse_status'] == '待人工确认'
    assert result['parsed']['fields']['interview_evaluation']['value'] == '已核实面试评价'
    assert result['parsed']['fields']['additional_material']['value'] == '已核实补充资料'
    assert result['parsed']['fields']['skills']['original_reference']['source_file'] == 'resume.pdf'
    assert result['parsed']['fields']['skills']['source_file'] == '人工核实记录'
    snapshot = json.loads(Path(result['structured_path']).read_text(encoding='utf-8'))
    assert snapshot['parsed'] == result['parsed'] and snapshot['score'] == result['score']
    assert source.read_bytes() == Path(result['original_path']).read_bytes() == b'original PDF never changes'
    original_evidence = [e for e in result['parsed']['raw_evidence'] if e.get('origin') != 'human_review']
    assert original_evidence == before['parsed']['raw_evidence']


def test_material_edit_clears_all_final_decisions_until_new_review_even_after_reanalysis(materials):
    db, task, cid, jobs, _ = materials
    w.save_review(cid, '保留原复核意见', '保留', '招聘人员', db)
    for job in jobs:
        w.save_fit_decision(cid, job, '保留岗位复核依据', '作为备选岗位', '招聘人员', db)
    w.update_candidate_material(cid, {'education': '实际为硕士'}, '招聘人员', db)
    candidate = w.get_candidate(cid, db)
    assert candidate['decision'] is None and candidate['review_comment'] == '保留原复核意见'
    assert candidate['score']['requires_reassessment']
    matches = w.get_candidate_job_matches(candidate_id=cid, db_path=db)
    assert len(matches) == len(jobs)
    assert all(m['decision'] is None and m['score']['requires_reassessment'] for m in matches)
    assert all(m['review_comment'] == '保留岗位复核依据' for m in matches)
    w.reanalyze_task(task, '招聘人员', db)
    assert w.get_candidate(cid, db)['decision'] is None
    assert all(m['decision'] is None and not m['score'].get('requires_reassessment')
               for m in w.get_candidate_job_matches(candidate_id=cid, db_path=db))


def test_confirmation_without_content_change_does_not_discard_review(materials):
    db, task, cid, _, _ = materials
    w.update_candidate_material(cid, {'skills': '人工核实Java'}, '招聘人员', db, confirmed=False)
    w.reanalyze_task(task, '招聘人员', db)
    w.save_review(cid, '已重新核验', '保留', '招聘人员', db)
    result = w.update_candidate_material(cid, {}, '招聘人员', db, confirmed=True,
                                         expected_material_version=1)
    assert result['parse_status'] == '人工已复核' and result['decision'] == '保留'
    assert not result['score'].get('requires_reassessment')
    assert result['parsed']['material_version'] == 2
    assert result['parsed']['fields']['skills']['status'] == '人工已确认'
    assert next(e for e in result['parsed']['raw_evidence'] if e.get('field_key') == 'skills')['confirmed']


def test_second_correction_and_clear_use_latest_material_and_preserve_original_provenance(materials):
    db, _, cid, _, _ = materials
    w.update_candidate_material(cid, {'skills': '已核实Java经验'}, '招聘人员', db)
    result = w.update_candidate_material(cid, {'skills': '已核实Go经验'}, '招聘人员', db)
    text = material_text(result['parsed'])
    assert '已核实Go经验' in text and '已核实Java经验' not in text and '旧的Python识别结果' not in text
    evidence = [e for e in result['parsed']['raw_evidence'] if e.get('field_key') == 'skills']
    assert len(evidence) == 1 and evidence[0]['origin'] == 'human_review'
    cleared = w.update_candidate_material(cid, {'skills': ''}, '招聘人员', db, confirmed=False)
    assert cleared['parsed']['fields']['skills']['manual_override']
    assert '旧的Python识别结果' not in material_text(cleared['parsed'])
    assert not any(e.get('field_key') == 'skills' for e in effective_material_evidence(cleared['parsed']))
    assert '旧的Python识别结果' in json.dumps(cleared['parsed']['raw_evidence'], ensure_ascii=False)


@pytest.mark.parametrize('status', ['待处理', '处理中'])
def test_edit_rejects_busy_tasks_atomically(materials, status):
    db, task, cid, _, _ = materials
    with connect(db) as conn:
        conn.execute('UPDATE tasks SET status=? WHERE id=?', (status, task))
    before = w.get_candidate(cid, db)
    with pytest.raises(ValueError, match='正在处理'):
        w.update_candidate_material(cid, {'skills': '新资料'}, '招聘人员', db)
    assert w.get_candidate(cid, db) == before


def test_permissions_stale_version_empty_name_and_sensitive_values_leave_record_unchanged(materials):
    db, _, cid, _, _ = materials
    before = w.get_candidate(cid, db)
    with pytest.raises(PermissionError):
        w.update_candidate_material(cid, {'skills': '新资料'}, '访客', db)
    with pytest.raises(ValueError, match='其他操作修改'):
        w.update_candidate_material(cid, {'skills': '新资料'}, '招聘人员', db, expected_material_version=100)
    with pytest.raises(ValueError, match='姓名'):
        w.update_candidate_material(cid, {}, '招聘人员', db, full_name='')
    with pytest.raises(ValueError, match='脱敏'):
        w.update_candidate_material(cid, {'additional_material': '联系电话13812345678'}, '招聘人员', db)
    assert w.get_candidate(cid, db) == before


def test_legacy_api_confirms_and_canonical_fields_are_completed(materials):
    db, _, cid, _, _ = materials
    with connect(db) as conn:
        conn.execute('UPDATE candidates SET parsed_json=? WHERE id=?',
                     (json.dumps(dict(full_name='测试', masked_name='测*', fields={}, raw_evidence=[])), cid))
    helpers.update_candidate_fields(cid, {'education': '本科'}, '用人部门', db)
    candidate = w.get_candidate(cid, db)
    assert set(candidate['parsed']['fields']) == set(MATERIAL_FIELD_LABELS)
    assert candidate['parse_status'] == '人工已复核'
    assert candidate['parsed']['fields']['education']['status'] == '人工已确认'


def test_model_reextraction_cannot_replace_saved_or_cleared_human_fields(monkeypatch):
    base = parse_candidate('专业技能：误识别Python\n工作经历：三年维护', 'original.pdf')
    updated, _ = prepare_material_update(base, {'skills': '', 'work_experience': '人工修正后端开发',
                                               'additional_material': '人工追加纪要'}, confirmed=False)
    monkeypatch.setattr(model_adapter, 'model_settings', lambda: dict(provider='external', confirmed=True,
                         model='chat-primary', key='offline', url='https://example.invalid', http_allowed=False))
    class FakeAdapter:
        diagnostics = {}
        def __init__(self, *args, **kwargs): pass
        def analyze(self, *args):
            return dict(fields={key: [0] for key in MATERIAL_FIELD_LABELS if key != 'additional_material'})
    monkeypatch.setattr(model_adapter, 'ExternalModelAdapter', FakeAdapter)
    result = model_adapter.enrich_candidate(copy.deepcopy(updated))
    assert result['model_analysis']['status'] == '调用成功'
    for key in ('skills', 'work_experience', 'additional_material'):
        assert result['fields'][key] == updated['fields'][key]
    assert result['parse_status'] == '待人工确认'


def test_semantic_extraction_fallback_accepts_edited_material_with_additional_field(monkeypatch):
    parsed = parse_candidate('专业技能：Python开发\n工作经历：三年维护', 'original.pdf')
    parsed, _ = prepare_material_update(parsed, {'additional_material': '追加面试资料'}, confirmed=False)
    monkeypatch.setattr(model_adapter, 'model_settings', lambda: dict(provider='external', confirmed=True,
                         model='chat-primary', key='offline', url='https://example.invalid', http_allowed=False))
    class FakeAdapter:
        diagnostics = {}
        def __init__(self, *args, **kwargs): pass
        def analyze(self, *args):
            return dict(skills='Python开发', work_experience='三年维护')
    monkeypatch.setattr(model_adapter, 'ExternalModelAdapter', FakeAdapter)
    result = model_adapter.enrich_candidate(parsed)
    assert result['model_analysis']['status'] == '调用成功'
    assert result['model_analysis']['fields_count'] == 2
    assert result['fields']['additional_material']['value'] == '追加面试资料'


def test_scoring_payload_contains_current_manual_data_and_explicit_clear_only(monkeypatch):
    parsed = parse_candidate('专业技能：旧Python资料\n工作经历：旧工作经历\n项目经历：保留项目证据', 'original.pdf')
    parsed, _ = prepare_material_update(parsed, {'skills': '实际为Java项目', 'work_experience': ''})
    captured = []
    monkeypatch.setattr(candidate_scoring, 'model_settings', lambda: dict(provider='external', confirmed=True,
        reasoning_model='chat-evaluation', key='offline', url='https://example.invalid', http_allowed=False, reasoning_max_tokens=1024))
    class FakeAdapter:
        diagnostics = {}
        def __init__(self, *args, **kwargs): pass
        def analyze(self, text, context):
            captured.append(json.loads(text))
            raise model_adapter.ModelError('offline capture')
    monkeypatch.setattr(candidate_scoring, 'ExternalModelAdapter', FakeAdapter)
    candidate_scoring.add_ai_score({}, parsed, dict(name='工程师', weights={'开发': 100}, hard_conditions=[]))
    assert len(captured) == 1
    sent = json.dumps(captured[0], ensure_ascii=False)
    assert '实际为Java项目' in sent and '旧Python资料' not in sent and '旧工作经历' not in sent
    assert any(e['origin'] == 'human_review' for e in captured[0]['evidence'])
    assert next(c for c in captured[0]['manual_corrections'] if c['field'] == 'work_experience')['cleared']


@pytest.mark.parametrize('text', ['教育经历：本科\n专业技能：Python\n项目经历：开发系统',
                                 '教育经历：本科；专业技能：Python；项目经历：开发系统',
                                 '取得本科学历，并通过Python完成开发系统'])
def test_editing_one_field_on_pdf_page_preserves_unrelated_fields(text):
    parsed = dict(fields={'education': dict(label='教育经历', value='本科', evidence='本科',
                    source_file='resume.pdf', location='第1页')},
                  raw_evidence=[dict(text=text, file='resume.pdf', location='第1页')])
    updated, _ = prepare_material_update(parsed, {'education': '硕士'})
    current = material_text(updated)
    assert 'Python' in current and '开发系统' in current
    assert '本科' not in current and '硕士' in current
    assert updated['raw_evidence'][0]['text'] == text


def test_snapshot_sync_failure_does_not_claim_database_save_failed(materials, monkeypatch):
    db, _, cid, _, _ = materials
    def unavailable(*args, **kwargs):
        raise PermissionError('snapshot directory unavailable')
    monkeypatch.setattr(w, '_sync_candidate_snapshot', unavailable)
    saved = w.update_candidate_material(cid, {'skills': '保存当前资料'}, '招聘人员', db)
    assert saved['parsed']['fields']['skills']['value'] == '保存当前资料'
    assert '已保存到数据库' in saved['material_snapshot_warning']
    assert w.get_candidate(cid, db)['parsed']['fields']['skills']['value'] == '保存当前资料'


def test_review_cannot_accept_stale_analysis(materials):
    db, _, cid, jobs, _ = materials
    w.update_candidate_material(cid, {'skills': '新的重要资料'}, '招聘人员', db)
    with pytest.raises(ValueError, match='先重新分析'):
        w.save_review(cid, '复核', '保留', '招聘人员', db)
    with pytest.raises(ValueError, match='先重新分析'):
        w.save_fit_decision(cid, jobs[0], '复核', '推荐至该岗位', '招聘人员', db)
    w.save_review(cid, '可以保存意见但不下最终结论', None, '招聘人员', db)


def test_name_only_correction_keeps_scores_and_decisions(materials):
    """只改姓名不需要重新分析：姓名在送入模型前已脱敏，不参与评分。"""
    db, task, cid, jobs, source = materials
    w.update_candidate_material(cid, {}, '招聘人员', db, confirmed=True)
    w.save_fit_decision(cid, jobs[0], '同意推荐', '推荐至该岗位', '招聘人员', db)
    renamed = w.update_candidate_material(cid, {}, '招聘人员', db, full_name='示例人员01', confirmed=False)
    assert renamed['full_name'] == '示例人员01'
    assert not renamed['score'].get('requires_reassessment')
    matches = {item['job_id']: item for item in w.get_candidate_job_matches(candidate_id=cid, db_path=db)}
    assert matches[jobs[0]]['decision'] == '推荐至该岗位'
    assert not any(item['score'].get('requires_reassessment') for item in matches.values())
    # 其他资料有改动时，评分和结论仍然失效。
    changed = w.update_candidate_material(cid, {'education': '硕士，人力资源管理'}, '招聘人员', db, confirmed=False)
    assert changed['score']['requires_reassessment'] is True
    matches = w.get_candidate_job_matches(candidate_id=cid, db_path=db)
    assert all(item['score']['requires_reassessment'] and item['decision'] is None for item in matches)
