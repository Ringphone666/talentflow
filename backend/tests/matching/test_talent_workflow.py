"""Independent talent batches feed both workflows without reparsing or cross-batch mixing."""
import json
from pathlib import Path

import pytest

from .fixture_data import init_db
from matching_core.db import connect, row
from matching_core.services import talent_library as library, workflow as w, task_queue as q


@pytest.fixture
def talent_setup(tmp_path, monkeypatch):
    database = tmp_path / 'library.db'
    init_db(database)
    monkeypatch.setattr(w, 'QUEUE_DIR', q.QUEUE_DIR)
    monkeypatch.setattr(library, 'enrich_candidate', lambda parsed: parsed)
    def parse(path, **kwargs):
        text = '姓名：测试人才\n技能：软件开发与项目管理'
        return dict(full_name='测试人才', masked_name='测*', parse_status='解析成功',
                    fields={}, raw_evidence=[dict(text=text, file=path.name, location='第1行')]), dict(detected=False, types=[]), text
    monkeypatch.setattr(library, 'parse_material', parse)
    source = tmp_path / '测试简历.txt'
    source.write_text('synthetic resume', encoding='utf-8')
    batch = library.create_batch('九月校招', '校招', '招聘人员', database)
    imported = library.import_files(batch, [source], '招聘人员', database)
    entry = imported['imported'][0]
    def score(result, *args):
        result.update(total=80, scoring_method='ai_semantic_v1',
                      dimensions=[dict(dimension='专业能力', score=80, weight=100, evidence_available=True)],
                      reasoning_analysis={'status': '调用成功'})
    monkeypatch.setattr(w, 'analyze_score', score)
    return database, batch, entry, source


@pytest.mark.parametrize('fit', [False, True])
def test_library_selection_feeds_both_flows_and_replay_does_not_duplicate(talent_setup, monkeypatch, fit):
    database, batch, entry, source = talent_setup
    jobs = ['JOB-TECH-001', 'JOB-SALES-001'] if fit else ['JOB-TECH-001']
    task = w.prepare_talent_task(jobs, [entry['id']], batch, '招聘人员', database, fit=fit)
    saved = row('SELECT * FROM tasks WHERE id=?', (task,), database)
    assert saved['talent_batch_id'] == batch and saved['batch_name'] == '九月校招'
    monkeypatch.setattr(w, 'parse_material', lambda *a, **k: pytest.fail('must reuse parsed talent material'))
    created = w._reuse_candidates_in_task(task, [entry['id']], '招聘人员', database)
    assert len(created) == 1
    candidate = w.get_candidate(created[0], database)
    assert candidate['source_candidate_id'] == entry['id']
    assert candidate['original_path'] == entry['original_path']
    assert len(w.get_candidate_job_matches(task_id=task, db_path=database)) == (2 if fit else 0)
    assert w._reuse_candidates_in_task(task, [entry['id']], '招聘人员', database) == created
    assert len(w.get_candidates(task, database)) == 1
    history = w.get_talent_match_history(entry['id'], database)
    assert [item['id'] for item in history] == created
    w.delete_task(task, '招聘人员', database)
    assert Path(library.get_entry(entry['id'], database)['original_path']).is_file()
    assert Path(library.get_entry(entry['id'], database)['redacted_path']).is_file()


def test_invalid_cross_batch_failed_material_and_permissions_do_not_create_tasks(talent_setup):
    database, batch, entry, source = talent_setup
    other = library.create_batch('九月社招', '社招', '招聘人员', database)
    for operator, batch_id in [('用人部门', batch), ('招聘人员', other)]:
        with pytest.raises((PermissionError, ValueError)):
            w.prepare_talent_task(['JOB-TECH-001'], [entry['id']], batch_id, operator, database)
    with connect(database) as conn:
        conn.execute("UPDATE talent_entries SET status='解析失败' WHERE id=?", (entry['id'],))
    with pytest.raises(ValueError):
        w.prepare_talent_task(['JOB-TECH-001'], [entry['id']], batch, '招聘人员', database)
    assert w.get_tasks(database) == []


def test_library_clone_failure_is_retryable_from_saved_source(talent_setup, monkeypatch):
    database, batch, entry, source = talent_setup
    task = w.prepare_talent_task(['JOB-TECH-001'], [entry['id']], batch, '招聘人员', database)
    clone = w._clone_candidate_for_task
    def fail_once(*args):
        raise OSError('temporary error')
    monkeypatch.setattr(w, '_clone_candidate_for_task', fail_once)
    assert w._reuse_candidates_in_task(task, [entry['id']], '招聘人员', database) == []
    failure = json.loads(row('SELECT failure_reasons_json FROM tasks WHERE id=?', (task,), database)['failure_reasons_json'])[0]
    assert failure['source_entry_id'] == entry['id']
    monkeypatch.setattr(w, '_clone_candidate_for_task', clone)
    assert w.retry_failed_task(task, '招聘人员', database) == 1
    assert len(w.get_candidates(task, database)) == 1


def test_talent_queue_persists_and_recovers_library_selection(talent_setup, monkeypatch):
    from concurrent.futures import Future
    database, batch, entry, source = talent_setup
    task = w.prepare_talent_task(['JOB-TECH-001'], [entry['id']], batch, '招聘人员', database)
    calls = []
    class Executor:
        def submit(self, function, *args):
            calls.append((function, args))
            return Future()
    monkeypatch.setattr(q, '_executor', Executor())
    monkeypatch.setattr(q, '_futures', {})
    first = q.enqueue_talent_task(task, [entry['id']], '招聘人员', database)
    assert q.enqueue_talent_task(task, [entry['id']], '招聘人员', database) is first
    assert len(calls) == 1
    monkeypatch.setattr(q, '_futures', {})
    assert q.recover_pending_tasks(database) == [task]
    # 参数依次为：任务编号、数据库、处理函数，以及处理函数自身的参数。
    assert calls[-1][1][4] == [entry['id']]
