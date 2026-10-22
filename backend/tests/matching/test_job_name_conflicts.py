import pytest

from .fixture_data import init_db
from matching_core.db import rows
from matching_core.services import workflow as w


@pytest.fixture
def jobs_db(tmp_path):
    path = tmp_path / 'jobs.db'
    init_db(path)
    return path


def create(path, name, **options):
    return w.create_job(name, '技术类', 'P4', 'JD-NEW', ['新岗位职责'], ['新任职要求'],
                        ['持有有效资格证'], [{'name': '专业能力', 'keywords': ['专业知识']}],
                        {'专业能力': 100}, '新的适用范围', '招聘人员', path,
                        extra_sections={'地点': '广州'}, **options)


def test_deleted_name_can_be_created_again_without_changing_archived_job(jobs_db):
    old = w.get_jobs(jobs_db)[0]
    w.archive_job(old['id'], '招聘人员', jobs_db)
    archived = w.get_job(old['id'], jobs_db)
    new_id = create(jobs_db, old['name'])
    assert new_id != old['id']
    assert w.get_job(old['id'], jobs_db) == archived
    assert len([j for j in w.get_jobs(jobs_db) if j['name'] == old['name']]) == 1
    # Editing the newly created job must not collide with the archived namesake.
    w.update_job_profile(new_id, old['name'], '技术类', 'P5', 'v2', ['更新职责'], ['更新要求'], [], '', '招聘人员', jobs_db)
    with pytest.raises(ValueError, match='已有同名'):
        w.restore_job(old['id'], '招聘人员', jobs_db)
    assert w.get_job(old['id'], jobs_db) == archived


def test_live_duplicate_requires_confirmation_and_updates_all_fields(jobs_db):
    old = w.get_jobs(jobs_db)[0]
    related_before = {table: rows(f'SELECT * FROM {table}', db_path=jobs_db) for table in ('tasks', 'candidates', 'candidate_job_matches', 'reports')}
    with pytest.raises(w.JobNameConflict) as caught:
        create(jobs_db, old['name'])
    assert w.get_job(old['id'], jobs_db) == old
    job_id = create(jobs_db, old['name'], overwrite_job_id=old['id'], overwrite_revision=caught.value.revision)
    updated = w.get_job(job_id, jobs_db)
    assert job_id == old['id']
    assert updated['sequence'] == '技术类' and updated['level'] == 'P4'
    assert updated['responsibilities'] == ['新岗位职责']
    assert updated['requirements'] == ['新任职要求']
    assert updated['hard_conditions'][0]['name'] == '持有有效资格证'
    assert updated['weights'] == {'专业能力': 100}
    assert updated['dimensions'][0]['keywords'] == ['专业知识']
    assert updated['extra_sections'] == {'地点': '广州'}
    assert updated['jd_version'] == 'JD-NEW' and updated['weight_version'] != old['weight_version']
    assert rows("SELECT * FROM audits WHERE operation_type='岗位覆盖'", db_path=jobs_db)
    for table, before in related_before.items():
        assert rows(f'SELECT * FROM {table}', db_path=jobs_db) == before


def test_stale_confirmation_cannot_overwrite_later_edits(jobs_db):
    old = w.get_jobs(jobs_db)[0]
    with pytest.raises(w.JobNameConflict) as caught:
        create(jobs_db, old['name'])
    w.update_job_profile(old['id'], old['name'], old['sequence'], '最新职级', old['jd_version'],
                         old['responsibilities'], old['requirements'], old['hard_conditions'], old['scope'], '招聘人员', jobs_db)
    with pytest.raises(w.JobNameConflict, match='发生变更'):
        create(jobs_db, old['name'], overwrite_job_id=old['id'], overwrite_revision=caught.value.revision)
    assert w.get_job(old['id'], jobs_db)['level'] == '最新职级'


def test_confirmation_for_deleted_job_does_not_create_or_replace_silently(jobs_db):
    old = w.get_jobs(jobs_db)[0]
    with pytest.raises(w.JobNameConflict) as caught:
        create(jobs_db, old['name'])
    w.archive_job(old['id'], '招聘人员', jobs_db)
    before = w.get_jobs(jobs_db, include_inactive=True)
    with pytest.raises(ValueError, match='已删除或改名'):
        create(jobs_db, old['name'], overwrite_job_id=old['id'], overwrite_revision=caught.value.revision)
    assert w.get_jobs(jobs_db, include_inactive=True) == before


def test_invalid_replacement_does_not_change_job(jobs_db):
    old = w.get_jobs(jobs_db)[0]
    with pytest.raises(w.JobNameConflict) as caught:
        create(jobs_db, old['name'])
    with pytest.raises(ValueError, match='100%'):
        w.create_job(old['name'], '技术类', 'P4', '', ['职责'], ['要求'], [],
                     [{'name': '能力'}], {'能力': 50}, '', '招聘人员', jobs_db,
                     overwrite_job_id=old['id'], overwrite_revision=caught.value.revision)
    assert w.get_job(old['id'], jobs_db) == old


def test_permanent_deletion_only_removes_archived_unreferenced_jobs(jobs_db):
    job_id = create(jobs_db, '可彻底删除岗位')
    with pytest.raises(ValueError, match='先将岗位'):
        w.permanently_delete_job(job_id, '招聘人员', jobs_db)
    w.archive_job(job_id, '招聘人员', jobs_db)
    for role in ('用人部门', '面试官'):
        with pytest.raises(ValueError, match='只有招聘人员'):
            w.permanently_delete_job(job_id, role, jobs_db)
    w.permanently_delete_job(job_id, '招聘人员', jobs_db)
    assert not rows('SELECT * FROM jobs WHERE id=?', (job_id,), jobs_db)
    assert rows("SELECT * FROM audits WHERE operation_type='岗位彻底删除' AND object_id=?", (job_id,), jobs_db)


def test_permanent_delete_blocks_running_tasks_then_purges_json_references(jobs_db):
    import json
    from matching_core.db import connect
    job_id = create(jobs_db, '有历史任务岗位')
    task_id = w.create_task(job_id, [], '招聘人员', jobs_db)
    w.archive_job(job_id, '招聘人员', jobs_db)
    with pytest.raises(ValueError, match='仍在处理中'):
        w.permanently_delete_job(job_id, '招聘人员', jobs_db)
    other_id = w.get_jobs(jobs_db)[0]['id']
    with connect(jobs_db) as conn:
        conn.execute('UPDATE tasks SET job_id=?,job_ids_json=? WHERE id=?', (other_id, json.dumps([other_id, job_id]), task_id))
    with pytest.raises(ValueError, match='仍在处理中'):
        w.permanently_delete_job(job_id, '招聘人员', jobs_db)
    assert w.get_job(job_id, jobs_db)
    with connect(jobs_db) as conn:
        conn.execute("UPDATE tasks SET status='已完成' WHERE id=?", (task_id,))
    w.permanently_delete_job(job_id, '招聘人员', jobs_db)
    assert not rows('SELECT id FROM jobs WHERE id=?', (job_id,), jobs_db)
    assert not rows('SELECT id FROM tasks WHERE id=?', (task_id,), jobs_db)
    assert w.get_job(other_id, jobs_db)


def test_purge_cleans_related_history_files_and_preserves_unrelated_tasks(jobs_db, tmp_path, monkeypatch):
    from .test_demo import processed_candidate
    from matching_core.db import connect
    from matching_core.config import REPORT_DIR
    target_task, candidate_id = processed_candidate(jobs_db)
    candidate = w.get_candidate(candidate_id, jobs_db)
    target_job = candidate['job_id']
    other_job = next(j['id'] for j in w.get_jobs(jobs_db) if j['id'] != target_job)
    other_task = w.create_task(other_job, [], '招聘人员', jobs_db)
    report_dir = tmp_path / 'reports'
    report_dir.mkdir()
    monkeypatch.setattr(w, 'REPORT_DIR', report_dir)
    report_file = report_dir / 'candidate.docx'; report_file.write_text('test report')
    original_path = __import__('pathlib').Path(candidate['original_path'])
    with connect(jobs_db) as conn:
        conn.execute("INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)", (candidate_id, str(report_file), 'today', '招聘人员'))
        conn.execute("INSERT INTO candidate_job_matches(task_id,candidate_id,job_id,updated_at) VALUES(?,?,?,?)", (target_task, candidate_id, target_job, 'today'))
    w.archive_job(target_job, '招聘人员', jobs_db)
    w.permanently_delete_job(target_job, '招聘人员', jobs_db)
    assert not report_file.exists() and not original_path.exists()
    assert not rows('SELECT * FROM candidates WHERE id=?', (candidate_id,), jobs_db)
    assert not rows('SELECT * FROM candidate_job_matches WHERE job_id=?', (target_job,), jobs_db)
    assert not rows('SELECT * FROM reports WHERE candidate_id=?', (candidate_id,), jobs_db)
    assert not rows('SELECT * FROM tasks WHERE id=?', (target_task,), jobs_db)
    assert rows('SELECT * FROM tasks WHERE id=?', (other_task,), jobs_db)
    assert w.get_job(other_job, jobs_db)
    with connect(jobs_db) as conn:
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
