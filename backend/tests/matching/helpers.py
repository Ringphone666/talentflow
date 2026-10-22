"""测试辅助：用核心公开函数组合出的同步流程，仅供回归测试使用。"""
from matching_core.config import DB_PATH
from matching_core.db import decode_candidate, rows
from matching_core.services import workflow as w


def update_candidate_fields(candidate_id, fields, operator, db_path=DB_PATH):
    w.update_candidate_material(candidate_id, fields, operator, db_path, confirmed=True)


def get_talent_pool(db_path=DB_PATH):
    raw = rows("SELECT * FROM candidates WHERE source_candidate_id IS NULL ORDER BY created_at DESC, id DESC",
               db_path=db_path)
    return [decode_candidate(item) for item in raw]


def _sources(source_candidate_ids, db_path):
    if not source_candidate_ids:
        raise ValueError("至少选择一名已解析候选人")
    return [w.get_candidate(candidate_id, db_path) for candidate_id in dict.fromkeys(source_candidate_ids)]


def create_task_from_talent_pool(job_id, source_candidate_ids, operator, db_path=DB_PATH, batch_name=""):
    sources = _sources(source_candidate_ids, db_path)
    task_id = w.create_task(job_id, [source["source_filename"] for source in sources], operator, db_path,
                            audit_operation="人员库选用", batch_name=batch_name)
    return task_id, w._reuse_candidates_in_task(task_id, source_candidate_ids, operator, db_path)


def create_fit_task_from_talent_pool(job_ids, source_candidate_ids, operator, db_path=DB_PATH, batch_name=""):
    sources = _sources(source_candidate_ids, db_path)
    task_id = w.create_fit_task(job_ids, [source["source_filename"] for source in sources], operator, db_path,
                                audit_operation="人员库选用", batch_name=batch_name)
    return task_id, w._reuse_candidates_in_task(task_id, source_candidate_ids, operator, db_path)


def create_job_from_description(path, template_job_id, operator, name_override="", sequence_override="",
                                level_override="", db_path=DB_PATH):
    prepared = w.prepare_job_import(path, template_job_id, db_path)
    return w.create_job(
        name_override.strip() or prepared["name"], sequence_override.strip() or prepared["sequence"],
        level_override.strip() or prepared["level"], prepared["jd_version"], prepared["responsibilities"],
        prepared["requirements"], prepared["hard_conditions"], prepared["dimensions"], prepared["weights"],
        prepared["scope"], operator, db_path, extra_sections=prepared["extra_sections"],
    )
