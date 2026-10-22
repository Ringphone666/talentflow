import json
from pathlib import Path

import pytest

from matching_core import db
from matching_core.services import talent_library as library


@pytest.fixture
def material_library(tmp_path, monkeypatch):
    database = tmp_path / 'materials.db'
    db.init_db(database)

    def parse(path, allow_ocr=False):
        text = Path(path).read_text(encoding='utf-8')
        if text == '无法识别':
            raise ValueError('无法识别简历')
        return ({'full_name': '待人工确认', 'masked_name': '待人工确认',
                 'parse_status': '部分字段待人工确认',
                 'fields': {'education': {'label': '教育经历', 'value': '本科', 'status': '已提取',
                            'evidence': '教育经历：本科', 'source_file': Path(path).name, 'location': '第1行'}},
                 'raw_evidence': [{'file': Path(path).name, 'location': '第1行', 'text': '教育经历：本科'},
                                  {'file': Path(path).name, 'location': '第2行', 'text': '工作经历：负责客户服务'}]},
                {'detected': False, 'types': []}, text)

    monkeypatch.setattr(library, 'parse_material', parse)
    monkeypatch.setattr(library, 'enrich_candidate', lambda parsed: parsed)
    batch_id = library.create_batch('测试人才', '社招', '招聘人员', database)

    def add(name='简历.txt', text='教育经历：本科\n工作经历：负责客户服务'):
        path = tmp_path / name
        path.write_text(text, encoding='utf-8')
        result = library.import_files(batch_id, [path], '招聘人员', database)
        return (result['imported'] or result['failed'])[0]

    return database, batch_id, add


def test_correction_saves_facts_name_status_snapshots_and_audit_without_changing_original(material_library):
    database, _, add = material_library
    before = add()
    old_files = {key: Path(before[key]).read_bytes() for key in ('original_path', 'redacted_path', 'structured_path')}
    updated = library.update_entry_material(before['id'], {'education': '硕士，信息管理',
        'interview_evaluation': '能清楚说明客户服务案例', 'additional_material': '已核对学历原件'},
        '用人部门', database, full_name='测试人员', confirmed=True, expected_material_version=0)
    assert updated['full_name'] == '测试人员' and updated['masked_name'] == '测***'
    assert updated['parse_status'] == '人工已复核'
    assert updated['material_version'] == 1 and updated['parsed']['manual_confirmed']
    assert updated['parsed']['fields']['education']['value'] == '硕士，信息管理'
    assert updated['original_path'] == before['original_path']
    assert updated['structured_path'] != before['structured_path']
    assert updated['redacted_path'] != before['redacted_path']
    for key, content in old_files.items():
        assert Path(before[key]).read_bytes() == content
    assert json.loads(Path(updated['structured_path']).read_text(encoding='utf-8'))['parsed'] == updated['parsed']
    revised_text = Path(updated['redacted_path']).read_text(encoding='utf-8')
    assert '硕士，信息管理' in revised_text and '教育经历：本科' not in revised_text
    assert '工作经历：负责客户服务' in revised_text
    audit = db.rows("SELECT * FROM audits WHERE operation_type='确认人员资料'", db_path=database)
    assert len(audit) == 1 and audit[0]['object_id'] == before['id']
    with pytest.raises(ValueError, match='已被其他操作更新'):
        library.update_entry_material(before['id'], {'education': '过期修改'}, '招聘人员', database,
                                      expected_material_version=0)
    assert library.get_entry(before['id'], database)['material_version'] == 1


def test_failed_parse_can_be_filled_by_human_but_name_alone_is_not_usable(material_library):
    database, batch, add = material_library
    failed = add('扫描.pdf', '无法识别')
    with pytest.raises(ValueError, match='有效简历资料'):
        library.update_entry_material(failed['id'], {}, '招聘人员', database, full_name='补录人员')
    assert library.get_entry(failed['id'], database)['status'] == '解析失败'
    draft = library.update_entry_material(failed['id'], {'work_experience': '两年仓储管理经验'},
                                          '招聘人员', database, full_name='补录人员', confirmed=False)
    assert draft['status'] == '已解析' and draft['error_message'] == ''
    assert draft['parse_status'] == '待人工确认' and not draft['parsed']['manual_confirmed']
    assert library.get_batch(batch, database)['parsed_count'] == 1
    assert '仓储管理' in Path(draft['redacted_path']).read_text(encoding='utf-8')
    confirmed = library.update_entry_material(failed['id'], {'work_experience': '两年仓储管理经验'},
        '招聘人员', database, full_name='补录人员', confirmed=True, expected_material_version=1)
    assert confirmed['parse_status'] == '人工已复核' and confirmed['material_version'] == 2
    assert Path(confirmed['original_path']).read_text(encoding='utf-8') == '无法识别'


def test_busy_unauthorized_and_sensitive_edits_do_not_change_material(material_library):
    database, _, add = material_library
    entry = add()
    with pytest.raises(PermissionError):
        library.update_entry_material(entry['id'], {'skills': '未经授权'}, '未知角色', database)
    with pytest.raises(ValueError, match='脱敏'):
        library.update_entry_material(entry['id'], {'additional_material': '手机号13812345678'}, '招聘人员', database)
    with db.connect(database) as conn:
        conn.execute("UPDATE talent_entries SET status='待解析' WHERE id=?", (entry['id'],))
    with pytest.raises(ValueError, match='正在解析'):
        library.update_entry_material(entry['id'], {'skills': '应等待解析完成'}, '招聘人员', database)
    with pytest.raises(ValueError, match='正在解析'):
        library.retry_entry(entry['id'], '招聘人员', database)
    assert library.get_entry(entry['id'], database)['material_version'] == 0


def test_retry_does_not_overwrite_confirmed_or_modified_facts(material_library, monkeypatch):
    database, _, add = material_library
    entry = add()
    updated = library.update_entry_material(entry['id'], {'education': '硕士'}, '招聘人员', database, confirmed=False)
    monkeypatch.setattr(library, 'parse_material', lambda *a, **k: pytest.fail('不能重新解析已人工修改资料'))
    with pytest.raises(ValueError, match='已有人工修改或确认'):
        library.retry_entry(entry['id'], '招聘人员', database)
    assert library.get_entry(entry['id'], database) == updated


def test_save_failure_rolls_back_db_and_removes_only_new_snapshot_files(material_library, monkeypatch):
    database, batch, add = material_library
    entry = add()
    folder = Path(entry['structured_path']).parent
    previous = set(folder.iterdir())
    original_write = Path.write_text

    def fail_json(self, *args, **kwargs):
        if self.name.startswith('review_') and self.suffix == '.json':
            raise OSError('测试写入失败')
        return original_write(self, *args, **kwargs)

    monkeypatch.setattr(Path, 'write_text', fail_json)
    with pytest.raises(OSError, match='测试写入失败'):
        library.update_entry_material(entry['id'], {'education': '硕士'}, '招聘人员', database)
    assert library.get_entry(entry['id'], database) == entry
    assert set(folder.iterdir()) == previous


def test_new_matching_tasks_reuse_corrected_facts_and_keep_previous_task_snapshot(material_library):
    from .fixture_data import init_db
    from matching_core.services import workflow

    database, batch, add = material_library
    init_db(database)
    entry = add()
    job_id = workflow.get_jobs(database)[0]['id']
    old_task = workflow.create_task(job_id, [entry['source_filename']], '招聘人员', database)
    old_candidate_id = workflow._clone_candidate_for_task(entry['id'], old_task, job_id, '招聘人员', database)
    old_candidate = workflow.get_candidate(old_candidate_id, database)
    old_text = Path(old_candidate['redacted_path']).read_text(encoding='utf-8')
    library.update_entry_material(entry['id'], {'education': '硕士，计算机应用'}, '招聘人员', database, full_name='更正姓名')
    task_id = workflow.prepare_talent_task([job_id], [entry['id']], batch, '招聘人员', database)
    if isinstance(task_id, dict):
        task_id = task_id['task_id']
    new_candidate_id = workflow._clone_candidate_for_task(entry['id'], task_id, job_id, '招聘人员', database)
    new_candidate = workflow.get_candidate(new_candidate_id, database)
    assert new_candidate['full_name'] == '更正姓名'
    assert new_candidate['parsed']['fields']['education']['value'] == '硕士，计算机应用'
    assert '硕士，计算机应用' in Path(new_candidate['redacted_path']).read_text(encoding='utf-8')
    assert workflow.get_candidate(old_candidate_id, database)['parsed'] == old_candidate['parsed']
    assert Path(old_candidate['redacted_path']).read_text(encoding='utf-8') == old_text


