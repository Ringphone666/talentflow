"""Isolated regression coverage for batch review state and report selections."""
import copy
import csv
import io
import json

import pytest

from .fixture_data import init_db
from matching_core import db
from matching_core.services import batches, workflow


def ai_score(value=96, **extra):
    return dict(scoring_method='ai_semantic_v1', total=value,
                dimensions=[dict(dimension='相关能力', score=value, weight=100, evidence_available=True)],
                reasoning_analysis={'status': '调用成功'}, **extra)


@pytest.mark.parametrize('candidate,expected', [
    ({'parse_status': '解析成功', 'score': ai_score()}, '待审核'),
    ({'parse_status': '人工已复核', 'score': ai_score()}, '待审核'),
    ({'parse_status': '解析成功', 'decision': '进入下一轮', 'score': ai_score()}, '待审核'),
    ({'parse_status': '人工已复核', 'decision': '进入下一轮', 'score': ai_score()}, '通过'),
    ({'parse_status': '人工已复核', 'decision': '淘汰', 'score': ai_score()}, '未通过'),
    ({'parse_status': '人工已复核', 'decision': '保留', 'score': ai_score()}, '保留'),
    ({'parse_status': '人工已复核', 'decision': '进入下一轮', 'score': ai_score(requires_reassessment=True)}, '需重新审核'),
])
def test_review_classification_requires_saved_human_review(candidate, expected):
    assert batches.review_status(candidate) == expected


@pytest.mark.parametrize('decisions,expected_count,expected', [
    ([None, None], 2, '待审核'),
    (['暂不推荐'], 2, '待审核'),
    (['暂不推荐', None], 2, '待审核'),
    (['暂不推荐', '暂不推荐'], 2, '未通过'),
    (['推荐至该岗位', None], 2, '通过'),
    (['作为备选岗位', None], 2, '保留'),
])
def test_fit_review_uses_manual_decisions_and_does_not_reject_missing_jobs(decisions, expected_count, expected):
    matches = [dict(decision=decision, score=ai_score()) for decision in decisions]
    candidate = {'parse_status': '人工已复核'}
    assert batches.review_status(candidate, matches, fit=True, expected_jobs=expected_count) == expected
    matches[-1]['score']['requires_reassessment'] = True
    assert batches.review_status(candidate, matches, fit=True, expected_jobs=expected_count) == '需重新审核'


def test_fit_saved_decision_needs_confirmed_candidate_fields():
    matches = [{'decision': '推荐至该岗位', 'score': ai_score()}]
    assert batches.review_status({'parse_status': '解析成功'}, matches, fit=True, expected_jobs=1) == '待审核'


def test_batch_title_supports_named_and_legacy_tasks():
    task = {'id': 'old', 'created_at': '2026-09-28T10:30:00+08:00', 'job_id': 'job'}
    jobs = {'job': {'name': '招聘专员'}}
    assert batches.batch_title(task, jobs) == '2026-09-28 10:30 · 招聘专员'
    assert batches.batch_title({**task, 'batch_name': '九月第二批'}, jobs) == '九月第二批'
    assert batches.batch_title({'id': 'fit', 'task_mode': '人找岗位'}) == '人才适岗'


def test_batch_name_is_persisted_and_legacy_schema_migrates(tmp_path):
    path = tmp_path / 'legacy-batches.db'
    init_db(path)
    jobs = workflow.get_jobs(path)
    task = workflow.create_task(jobs[0]['id'], ['fictional.pdf'], '招聘人员', path, batch_name='  九月批次  ')
    fit = workflow.create_fit_task([jobs[0]['id'], jobs[1]['id']], ['fictional.pdf'], '招聘人员', path, batch_name='适岗批次')
    stored = {item['id']: item for item in workflow.get_tasks(path)}
    assert stored[task]['batch_name'] == '九月批次'
    assert stored[fit]['batch_name'] == '适岗批次'
    with db.connect(path) as conn:
        conn.execute('ALTER TABLE tasks DROP COLUMN batch_name')
    db.init_db(path, seed=False)
    migrated = {item['id']: item for item in workflow.get_tasks(path)}
    assert migrated[task]['batch_name'] == ''
    assert migrated[fit]['job_ids'] == [jobs[0]['id'], jobs[1]['id']]
    assert jobs[0]['name'] in batches.batch_title(migrated[task], {j['id']: j for j in jobs})


def test_csv_preserves_unicode_rows_and_neutralizes_formula_cells():
    records = [{'姓名': '测试甲', '审核状态': '待审核', '意见': '=1+1', '分数': 96},
               {'姓名': '  @SUM(A1)', '审核状态': '通过', '意见': '第一行\n第二行', '分数': None},
               {'姓名': '测试乙', '审核状态': '保留', '意见': '\t+1+1', '分数': 0}]
    raw = batches.safe_csv(records)
    assert raw.startswith(b'\xef\xbb\xbf')
    parsed = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    assert parsed[0]['姓名'] == '测试甲' and parsed[0]['意见'] == "'=1+1"
    assert parsed[1]['姓名'] == "'  @SUM(A1)" and parsed[1]['意见'] == '第一行\n第二行'
    assert parsed[2]['意见'] == "'\t+1+1" and parsed[2]['分数'] == '0'


def test_csv_hidden_bom_cannot_bypass_formula_protection():
    value = '\ufeff=1+1'
    raw = batches.safe_csv([{'意见': value}])
    result = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    assert result[0]['意见'] == "'" + value


def insert_candidate(path, task, job, cid, filename='same.pdf', **updates):
    now = db.now_iso()
    values = dict(id=cid, task_id=task, job_id=job, full_name=cid + '姓名', masked_name='测*',
                  source_filename=filename, original_path='', redacted_path='', structured_path='',
                  redaction_status='已检查', parse_status='解析成功',
                  parsed_json=json.dumps({'candidate_code': cid, 'full_name': cid + '姓名'}),
                  score_json=json.dumps(ai_score()), created_at=now, updated_at=now)
    values.update(updates)
    with db.connect(path) as conn:
        conn.execute(f'INSERT INTO candidates ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', tuple(values.values()))


def test_snapshot_separates_batches_and_includes_unparsed_files(tmp_path):
    path = tmp_path / 'batches.db'
    init_db(path)
    job = workflow.get_jobs(path)[0]['id']
    first = workflow.create_task(job, ['same.pdf', 'broken.pdf'], '招聘人员', path, batch_name='第一批')
    second = workflow.create_task(job, ['same.pdf'], '招聘人员', path, batch_name='第二批')
    insert_candidate(path, first, job, 'A')
    insert_candidate(path, second, job, 'B', parse_status='人工已复核', decision='进入下一轮')
    with db.connect(path) as conn:
        conn.execute('UPDATE tasks SET failure_count=1,failure_reasons_json=? WHERE id=?',
                     (json.dumps([{'file': 'broken.pdf', 'reason': '虚构文件解析失败'}]), first))
    a, b = batches.batch_snapshot(first, path), batches.batch_snapshot(second, path)
    assert {r['candidate_id'] for r in a['rows']} == {'A', None}
    assert {r['candidate_id'] for r in b['rows']} == {'B'}
    assert a['summary']['待审核'] == 2 and a['summary']['通过'] == 0 and a['summary']['failures'] == 1
    assert b['summary']['通过'] == 1 and b['summary']['total'] == 1
    missing = next(r for r in a['rows'] if not r['candidate_id'])
    assert missing['原始文件'] == 'broken.pdf' and missing['分析状态'] == '解析待重试'
    assert missing['处理说明'] == '虚构文件解析失败'


@pytest.mark.parametrize('fit', [False, True])
def test_snapshot_export_status_matches_formal_batch_report_requirements(tmp_path, fit):
    from matching_core.services.batch_reports import batch_report_readiness
    path = tmp_path / 'readiness.db'
    init_db(path)
    job = workflow.get_jobs(path)[0]['id']
    task = (workflow.create_fit_task([job], ['same.pdf'], '招聘人员', path) if fit else
            workflow.create_task(job, ['same.pdf'], '招聘人员', path))
    insert_candidate(path, task, job, 'unready', parse_status='解析成功' if fit else '人工已复核',
                     decision=None if fit else '进入下一轮', score_json=json.dumps(ai_score() if fit else ai_score(None)))
    if fit:
        with db.connect(path) as conn:
            conn.execute('INSERT INTO candidate_job_matches(task_id,candidate_id,job_id,score_json,decision,updated_at) VALUES(?,?,?,?,?,?)',
                         (task, 'unready', job, json.dumps(ai_score()), '推荐至该岗位', db.now_iso()))
    snapshot = batches.batch_snapshot(task, path)
    ready, _ = batch_report_readiness(snapshot['candidates'][0], snapshot['matches'], snapshot['jobs'], fit)
    assert ready is False
    assert snapshot['rows'][0]['报告状态'] != '可导出'
    assert snapshot['summary']['exportable'] == 0


def ui_snapshot(task_id, count=23):
    candidates, records = [], []
    for i in range(count):
        cid = f'{task_id}-{i:02d}'
        candidates.append({'id': cid, 'job_id': 'job', 'full_name': cid + '姓名', 'parsed': {'candidate_code': cid}})
        records.append({'candidate_id': cid, '姓名': cid + '姓名', '候选人编号': cid,
                        '原始文件': cid + '.pdf', '审核状态': '通过' if i % 2 == 0 else '待审核',
                        '报告状态': '可导出' if i % 2 == 0 else '待人工确认', '综合匹配度': 96,
                        '分析状态': '分析完成', '人工结论': '进入下一轮' if i % 2 == 0 else '未确认'})
    return {'task': {'id': task_id, 'batch_name': task_id, 'task_mode': '岗位找人'},
            'rows': records, 'candidates': candidates, 'matches': [], 'jobs': {'job': {'name': '岗位'}},
            'summary': {'total': count, '通过': (count + 1) // 2, '待审核': count // 2,
                        '未通过': 0, '保留': 0, '需重新审核': 0}}


