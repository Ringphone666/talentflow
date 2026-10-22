from __future__ import annotations

import json
import shutil
import uuid
import copy
import hashlib
from pathlib import Path
from typing import Any

from matching_core.config import DB_PATH, ORIGINAL_DIR, REDACTED_DIR, STRUCTURED_DIR, REPORT_DIR, QUEUE_DIR, ensure_directories, portable_path
from matching_core.db import connect, decode_candidate, decode_candidate_job_match, decode_job, now_iso, row, rows
from matching_core.services.audit import record_audit
from matching_core.services.parser import parse_material
from matching_core.services.model_adapter import enrich_candidate
from matching_core.services.privacy import contains_unmasked_sensitive
from matching_core.services.scoring import calculate_score, evaluate_fit_metadata, validate_weights, score_value, score_sort_key, annotate_score_evidence
from matching_core.services.tagger import build_tags
from matching_core.services.candidate_scoring import add_ai_score
from matching_core.services.retrieval import add_retrieval
from matching_core.services.material_review import prepare_material_update, material_for_analysis, material_text


def _max_task_people() -> int:
    import os
    try:
        return max(1, min(500, int(os.getenv("TALENTFLOW_MATCHING_UPLOAD_LIMIT", "20"))))
    except ValueError:
        return 20


# 单个匹配任务的人数上限，默认 20，可通过 TALENTFLOW_MATCHING_UPLOAD_LIMIT 调整。
MAX_TASK_PEOPLE = _max_task_people()


def analyze_score(score, parsed, job, object_id, operator, db_path):
    parsed = material_for_analysis(parsed)
    retrieval = add_retrieval(score, parsed, job)
    record_audit("语义证据检索", "候选人岗位", object_id, {},
                 {k:v for k,v in retrieval.items() if k != "evidence"}, operator, db_path)
    add_ai_score(score, parsed, job)
    state = score["reasoning_analysis"]
    record_audit("模型匹配分析", "候选人岗位", object_id, {},
                 {"model": state["model"], "status": state["status"], "reason": state["reason"]}, operator, db_path)
    return score


def get_jobs(db_path: Path | str = DB_PATH, include_inactive: bool = False) -> list[dict]:
    sql = "SELECT * FROM jobs ORDER BY id" if include_inactive else "SELECT * FROM jobs WHERE is_active=1 ORDER BY id"
    return [decode_job(x) for x in rows(sql, db_path=db_path)]


def get_job(job_id: str, db_path: Path | str = DB_PATH) -> dict:
    result = row("SELECT * FROM jobs WHERE id=?", (job_id,), db_path)
    if not result:
        raise KeyError(f"岗位不存在：{job_id}")
    return decode_job(result)


def _job_lines(values: list[str] | tuple[str, ...]) -> list[str]:
    return [str(value).strip() for value in values if str(value).strip()]


def _job_hard_conditions(values: list[str] | list[dict], existing: list[dict] | None = None) -> list[dict]:
    existing_by_name = {item["name"]: item for item in (existing or [])}
    result = []
    for value in values:
        if isinstance(value, dict):
            name = str(value.get("name", "")).strip()
            item = copy.deepcopy(value)
        else:
            name = str(value).strip()
            item = copy.deepcopy(existing_by_name.get(name, {}))
        if not name:
            continue
        item["name"] = name
        item.setdefault("keywords", [name])
        item.setdefault("negative_keywords", [])
        result.append(item)
    return result


def _equal_weights(dimensions: list[dict]) -> dict[str, float]:
    if not dimensions:
        raise ValueError("岗位至少需要一个胜任力维度")
    value = round(100.0 / len(dimensions), 2)
    weights = {item["name"]: value for item in dimensions}
    last = dimensions[-1]["name"]
    weights[last] = round(weights[last] + 100.0 - sum(weights.values()), 2)
    return weights


def _job_extra_sections(sections: dict[str, str] | None) -> dict[str, str]:
    """清理用户自定义的岗位栏目，空标题或空内容不入库。"""
    result: dict[str, str] = {}
    for raw_name, raw_content in (sections or {}).items():
        name = str(raw_name).strip()
        content = str(raw_content).strip()
        if name and content:
            result[name] = content
    return result


class JobNameConflict(ValueError):
    def __init__(self, job, changed=False):
        self.job = job
        self.revision = hashlib.sha256(json.dumps(job, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        super().__init__('该岗位已发生变更，请重新确认是否覆盖。' if changed else f'已有岗位“{job["name"]}”，请选择是否覆盖。')


def create_job(
    name: str,
    sequence: str,
    level: str,
    jd_version: str,
    responsibilities: list[str],
    requirements: list[str],
    hard_conditions: list[str] | list[dict],
    dimensions: list[dict],
    weights: dict[str, float] | None,
    scope: str,
    operator: str,
    db_path: Path | str = DB_PATH,
    extra_sections: dict[str, str] | None = None,
    *,
    overwrite_job_id: str | None = None,
    overwrite_revision: str | None = None,
) -> str:
    name, sequence, level = name.strip(), sequence.strip(), level.strip()
    if not name or not sequence or not level:
        raise ValueError("岗位名称、岗位类别和职级不能为空")
    responsibilities = _job_lines(responsibilities)
    requirements = _job_lines(requirements)
    if not responsibilities or not requirements:
        raise ValueError("岗位职责和任职要求均至少填写一项")
    dimensions = [copy.deepcopy(item) for item in dimensions if str(item.get("name", "")).strip()]
    if not dimensions:
        raise ValueError("岗位至少需要一个胜任力维度")
    weights = dict(weights or _equal_weights(dimensions))
    if set(weights) != {item["name"] for item in dimensions}:
        weights = _equal_weights(dimensions)
    validate_weights(weights)
    job_id = f"JOB-{uuid.uuid4().hex[:8].upper()}"
    now = now_iso()
    hard = _job_hard_conditions(hard_conditions)
    extras = _job_extra_sections(extra_sections)
    before = {}
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute('SELECT * FROM jobs WHERE name=? AND is_active=1', (name,)).fetchone()
        if existing:
            before = decode_job(existing)
            conflict = JobNameConflict(before)
            if overwrite_job_id != before['id']:
                raise conflict
            if overwrite_revision != conflict.revision:
                raise JobNameConflict(before, changed=True)
            job_id = before['id']
        elif overwrite_job_id:
            raise ValueError('原岗位已删除或改名，本次未覆盖。请重新点击新增岗位。')
        values = (
            name, sequence, level, jd_version.strip() or f"JD-{job_id}",
            "\n".join(responsibilities), "\n".join(requirements),
            json.dumps(hard, ensure_ascii=False), json.dumps(dimensions, ensure_ascii=False),
            json.dumps(weights, ensure_ascii=False), f"W-REPLACE-{uuid.uuid4().hex[:8]}" if before else "W-NEW-1.0",
            scope.strip() or "人工新增岗位", json.dumps(extras, ensure_ascii=False), now,
        )
        if before:
            conn.execute('''UPDATE jobs SET name=?,sequence=?,level=?,jd_version=?,responsibilities=?,requirements=?,
                hard_conditions_json=?,dimensions_json=?,weights_json=?,weight_version=?,scope=?,extra_sections_json=?,updated_at=?
                WHERE id=?''', (*values, job_id))
        else:
            conn.execute('''INSERT INTO jobs(id,name,sequence,level,jd_version,responsibilities,requirements,
                hard_conditions_json,dimensions_json,weights_json,weight_version,scope,extra_sections_json,updated_at,is_active)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)''', (job_id, *values))
        after = decode_job(conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())
    record_audit(
        "岗位覆盖" if before else "岗位新增", "岗位", job_id, before, after,
        operator, db_path,
    )
    if before:
        _invalidate_job_assessments(job_id, "岗位资料或评分标准已覆盖更新", db_path)
    return job_id


def prepare_job_import(
    path: str | Path,
    template_job_id: str | None = None,
    db_path: Path | str = DB_PATH,
) -> dict:
    """Parse an import for review without creating a job or borrowing job requirements."""
    path = Path(path)
    from matching_core.services.job_extraction import extract_job_with_ai
    parsed = extract_job_with_ai(path)
    return _prepare_parsed_job(path, parsed, template_job_id, db_path)


def prepare_job_imports(path, template_job_id=None, db_path=DB_PATH):
    from matching_core.services.job_extraction import extract_jobs_with_ai
    results = extract_jobs_with_ai(path)
    return [dict(item, draft=_prepare_parsed_job(Path(path), item['parsed'], template_job_id, db_path) if item['parsed'] else None)
            for item in results]


def _prepare_parsed_job(path, parsed, template_job_id, db_path):
    metadata = parsed["metadata"]
    scorecard_basis, scorecard_error = [], ''
    dimensions = copy.deepcopy(parsed["dimensions"])
    if dimensions:
        explicit = parsed.get('weights', {})
        if set(explicit) == {d['name'] for d in dimensions}:
            try:
                validate_weights(explicit)
                weights = dict(explicit)
                model_source = "文件明确维度及权重"
            except ValueError:
                weights = dict(explicit)
                model_source = "文件明确维度及权重（合计需人工校正）"
        else:
            weights = {d['name']: explicit.get(d['name'], 0) for d in dimensions}
            model_source = "文件明确维度（缺失权重待补充）"
            from matching_core.services.job_scorecard import generate_job_scorecard
            try:
                suggestion = generate_job_scorecard(dict(parsed, name=metadata.get('name', '')))
                dimensions, weights = suggestion['dimensions'], suggestion['weights']
                scorecard_basis = suggestion['basis']
                model_source = "文件明确维度及已有权重，AI补充缺失权重（待人工确认）"
            except ValueError as exc:
                scorecard_error = str(exc)
    elif template_job_id:
        template = get_job(template_job_id, db_path)
        dimensions = copy.deepcopy(template["dimensions"])
        weights = dict(template["weights"])
        model_source = f"借用{template['name']}"
    else:
        weights = {}
        model_source = "AI评分建议待生成"
        from matching_core.services.job_scorecard import generate_job_scorecard
        try:
            suggestion = generate_job_scorecard(dict(parsed, name=metadata.get('name', '')))
            dimensions, weights = suggestion['dimensions'], suggestion['weights']
            scorecard_basis = suggestion['basis']
            model_source = "AI根据岗位说明书生成（待人工确认）"
        except ValueError as exc:
            scorecard_error = str(exc)
    return {
        "name": metadata.get("name", ""),
        "sequence": metadata.get("sequence", ""),
        "level": metadata.get("level", ""),
        "jd_version": metadata.get("jd_version", ""),
        "responsibilities": parsed["responsibilities"],
        "requirements": parsed["requirements"],
        "hard_conditions": parsed["hard_conditions"],
        "dimensions": dimensions,
        "weights": weights,
        "scope": f"导入岗位说明书：{path.name}；评分标准来源：{model_source}",
        "extra_sections": {"资料来源": path.name, "评分标准来源": model_source, "信息提取模型": "chat-primary"},
        "warning": parsed["warning"],
        "status": parsed["status"],
        "source_text": parsed.get("source_text", ""),
        "model_source": model_source,
        "scorecard_basis": scorecard_basis,
        "scorecard_error": scorecard_error,
        "source_dimensions": copy.deepcopy(parsed['dimensions']),
        "source_weights": dict(parsed.get('weights', {})),
    }


def update_job_profile(
    job_id: str,
    name: str,
    sequence: str,
    level: str,
    jd_version: str,
    responsibilities: list[str],
    requirements: list[str],
    hard_conditions: list[str],
    scope: str,
    operator: str,
    db_path: Path | str = DB_PATH,
    extra_sections: dict[str, str] | None = None,
) -> None:
    job = get_job(job_id, db_path)
    name, sequence, level = name.strip(), sequence.strip(), level.strip()
    if not name or not sequence or not level:
        raise ValueError("岗位名称、岗位类别和职级不能为空")
    duplicate = row("SELECT id FROM jobs WHERE name=? AND id<>? AND is_active=1", (name, job_id), db_path)
    if duplicate:
        raise ValueError("该岗位名称已被其他岗位使用")
    responsibilities = _job_lines(responsibilities)
    requirements = _job_lines(requirements)
    if not responsibilities or not requirements:
        raise ValueError("岗位职责和任职要求均至少填写一项")
    hard = _job_hard_conditions(hard_conditions, job["hard_conditions"])
    extras = job.get("extra_sections", {}) if extra_sections is None else _job_extra_sections(extra_sections)
    before = {key: job[key] for key in ("name", "sequence", "level", "jd_version", "responsibilities", "requirements", "hard_conditions", "scope", "extra_sections")}
    after = {
        "name": name, "sequence": sequence, "level": level,
        "jd_version": jd_version.strip() or job["jd_version"],
        "responsibilities": responsibilities, "requirements": requirements,
        "hard_conditions": hard, "scope": scope.strip() or job["scope"], "extra_sections": extras,
    }
    with connect(db_path) as conn:
        conn.execute(
            """UPDATE jobs SET name=?,sequence=?,level=?,jd_version=?,responsibilities=?,requirements=?,
            hard_conditions_json=?,scope=?,extra_sections_json=?,updated_at=? WHERE id=?""",
            (
                after["name"], after["sequence"], after["level"], after["jd_version"],
                "\n".join(after["responsibilities"]), "\n".join(after["requirements"]),
                json.dumps(after["hard_conditions"], ensure_ascii=False), after["scope"],
                json.dumps(after["extra_sections"], ensure_ascii=False), now_iso(), job_id,
            ),
        )
    record_audit("岗位修改", "岗位", job_id, before, after, operator, db_path)
    if any(before.get(key) != after.get(key) for key in ("name", "responsibilities", "requirements", "hard_conditions")):
        _invalidate_job_assessments(job_id, "岗位职责、要求或硬性条件已修改", db_path)


def _invalidate_job_assessments(job_id, reason, db_path):
    changed = []
    with connect(db_path) as conn:
        for record in conn.execute("SELECT * FROM candidates WHERE job_id=?", (job_id,)).fetchall():
            candidate = decode_candidate(record)
            score = candidate["score"]
            score.update(requires_reassessment=True, reassessment_reason=reason)
            conn.execute("UPDATE candidates SET score_json=?,updated_at=? WHERE id=?",
                         (json.dumps(score, ensure_ascii=False), now_iso(), candidate["id"]))
            changed.append((candidate, score))
        for record in conn.execute("SELECT id,score_json FROM candidate_job_matches WHERE job_id=?", (job_id,)).fetchall():
            score = json.loads(record["score_json"])
            score.update(requires_reassessment=True, reassessment_reason=reason)
            conn.execute("UPDATE candidate_job_matches SET score_json=?,updated_at=? WHERE id=?",
                         (json.dumps(score, ensure_ascii=False), now_iso(), record["id"]))
    for candidate, score in changed:
        _sync_candidate_snapshot(candidate, score=score)


def archive_job(job_id: str, operator: str, db_path: Path | str = DB_PATH) -> None:
    job = get_job(job_id, db_path)
    if not job.get("is_active", 1):
        return
    with connect(db_path) as conn:
        conn.execute("UPDATE jobs SET is_active=0,updated_at=? WHERE id=?", (now_iso(), job_id))
    record_audit("岗位删除", "岗位", job_id, {"状态": "使用中"}, {"状态": "已删除，历史保留"}, operator, db_path)


def restore_job(job_id: str, operator: str, db_path: Path | str = DB_PATH) -> None:
    job = get_job(job_id, db_path)
    if job.get("is_active", 1):
        return
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute('SELECT id FROM jobs WHERE name=? AND is_active=1 AND id<>?', (job['name'], job_id)).fetchone():
            raise ValueError('已有同名的在用岗位，无法恢复。请先修改或删除在用岗位，再恢复此记录。')
        conn.execute("UPDATE jobs SET is_active=1,updated_at=? WHERE id=?", (now_iso(), job_id))
    record_audit("岗位恢复", "岗位", job_id, {"状态": "已删除"}, {"状态": "使用中"}, operator, db_path)


def permanently_delete_job(job_id: str, operator: str, db_path: Path | str = DB_PATH) -> None:
    """Purge an archived job and its task history in one database transaction."""
    from matching_core.services.auth import can
    from matching_core.services.audit import _safe
    if not can(operator, 'edit_job'):
        raise ValueError('只有招聘人员可以彻底删除岗位')
    files = []
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not record:
            raise ValueError('该岗位已不存在，请刷新列表。')
        job = decode_job(record)
        if job['is_active']:
            raise ValueError('请先将岗位移入“已删除岗位”，再彻底删除。')
        tasks = [dict(r) for r in conn.execute('SELECT * FROM tasks')
                 if r['job_id'] == job_id or job_id in json.loads(r['job_ids_json'])]
        task_ids = {r['id'] for r in tasks}
        # Include task ownership of legacy rows even if the task job list is stale.
        task_ids.update(r[0] for r in conn.execute('SELECT task_id FROM candidates WHERE job_id=? UNION SELECT task_id FROM candidate_job_matches WHERE job_id=?', (job_id, job_id)))
        all_tasks = {r['id']: dict(r) for r in conn.execute('SELECT * FROM tasks')}
        if any(all_tasks[tid]['status'] in {'待处理', '处理中'} for tid in task_ids):
            raise ValueError('关联任务仍在处理中，本次未删除；请等待任务完成或失败后再删除。')
        candidates = [dict(r) for r in conn.execute('SELECT * FROM candidates') if r['task_id'] in task_ids]
        candidate_ids = {r['id'] for r in candidates}
        reports = [dict(r) for r in conn.execute('SELECT * FROM reports') if r['candidate_id'] in candidate_ids]
        for report in reports:
            files.append((report['path'], (REPORT_DIR,)))
            conn.execute('DELETE FROM reports WHERE id=?', (report['id'],))
        for candidate in candidates:
            cid = candidate['id']
            for field in ('original_path', 'redacted_path', 'structured_path'):
                files.append((candidate[field], (ORIGINAL_DIR, REDACTED_DIR, STRUCTURED_DIR)))
            conn.execute('DELETE FROM candidate_job_matches WHERE candidate_id=?', (cid,))
            # Reused copies in unrelated tasks keep their own evidence and scores.
            conn.execute('UPDATE candidates SET source_candidate_id=NULL WHERE source_candidate_id=?', (cid,))
            conn.execute('DELETE FROM candidates WHERE id=?', (cid,))
        for tid in task_ids:
            conn.execute('DELETE FROM candidate_job_matches WHERE task_id=?', (tid,))
            conn.execute('DELETE FROM tasks WHERE id=?', (tid,))
            files.append((QUEUE_DIR / f'{tid}.json', (QUEUE_DIR,)))
        conn.execute('DELETE FROM candidate_job_matches WHERE job_id=?', (job_id,))
        conn.execute('DELETE FROM jobs WHERE id=?', (job_id,))
        before = dict(job=job, task_ids=sorted(task_ids), candidate_ids=sorted(candidate_ids), report_count=len(reports))
        conn.execute('INSERT INTO audits(operation_time,operation_type,object_type,object_id,before_json,after_json,operator) VALUES(?,?,?,?,?,?,?)',
                     (now_iso(), '岗位彻底删除', '岗位', job_id, _safe(before), _safe({'关联历史数据': '已删除'}), operator))
        # Files referenced by surviving candidates/reports must remain available.
        referenced = {str(r[field]) for r in conn.execute('SELECT * FROM candidates') for field in ('original_path', 'redacted_path', 'structured_path')}
        referenced.update(str(r['path']) for r in conn.execute('SELECT path FROM reports'))
    for path, roots in files:
        if str(path) not in referenced:
            _remove_generated_file(path or '', roots)


def get_tasks(db_path: Path | str = DB_PATH) -> list[dict]:
    result = rows("SELECT * FROM tasks ORDER BY created_at DESC", db_path=db_path)
    for item in result:
        item["failure_reasons"] = json.loads(item.pop("failure_reasons_json"))
        item["job_ids"] = json.loads(item.pop("job_ids_json", "[]"))
        if not item["job_ids"]:
            item["job_ids"] = [item["job_id"]]
        item.setdefault("task_mode", "岗位找人")
    return result


def get_candidates(task_id: str | None = None, db_path: Path | str = DB_PATH) -> list[dict]:
    raw = rows("SELECT * FROM candidates WHERE task_id=? ORDER BY id", (task_id,), db_path) if task_id else rows("SELECT * FROM candidates ORDER BY created_at DESC", db_path=db_path)
    return [decode_candidate(x) for x in raw]


def get_reports(candidate_id: str | None = None, db_path: Path | str = DB_PATH) -> list[dict]:
    """Return generated report records for the optional candidate."""
    if candidate_id:
        records = rows(
            "SELECT * FROM reports WHERE candidate_id=? ORDER BY generated_at DESC, id DESC",
            (candidate_id,),
            db_path,
        )
    else:
        records = rows("SELECT * FROM reports ORDER BY generated_at DESC, id DESC", db_path=db_path)
    for record in records:
        record["path"] = portable_path(record["path"])
    return records


def _remove_generated_file(path_value: str | Path, roots: tuple[Path, ...]) -> None:
    """Remove only files that live below one of the application's data roots."""
    try:
        path = Path(path_value).resolve()
        allowed = any(path == root.resolve() or root.resolve() in path.parents for root in roots)
        if allowed and path.is_file():
            path.unlink()
    except (OSError, RuntimeError):
        return


def _referenced_material_paths(conn) -> set[Path]:
    """Reused candidate records can share original and sanitized source files."""
    references = {Path(record[field]).resolve() for record in conn.execute(
        "SELECT original_path,redacted_path,structured_path FROM candidates")
        for field in ("original_path", "redacted_path", "structured_path") if record[field]}
    references.update(Path(record["path"]).resolve() for record in conn.execute("SELECT path FROM reports") if record["path"])
    return references


def _remove_unreferenced_files(files, referenced):
    for value, roots in files:
        if value and Path(value).resolve() not in referenced:
            _remove_generated_file(value, roots)


def delete_candidate(candidate_id: str, operator: str, db_path: Path | str = DB_PATH) -> None:
    """Delete one candidate and generated derivatives while preserving audit rows."""
    candidate = get_candidate(candidate_id, db_path)
    dependent = rows("SELECT id FROM candidates WHERE source_candidate_id=?", (candidate_id,), db_path)
    if dependent:
        raise ValueError("该候选人已被人员库任务复用，请先删除关联的复用任务后再删除原始候选人")
    reports = get_reports(candidate_id, db_path)
    before = {
        "候选人编号": candidate["parsed"].get("candidate_code", candidate_id),
        "姓名": candidate.get("full_name", ""),
        "任务": candidate.get("task_id", ""),
        "报告数": len(reports),
    }
    files = [(report.get("path", ""), (REPORT_DIR,)) for report in reports]
    files.extend((candidate.get(field), (ORIGINAL_DIR, REDACTED_DIR, STRUCTURED_DIR))
                 for field in ("original_path", "redacted_path", "structured_path"))
    with connect(db_path) as conn:
        conn.execute("DELETE FROM reports WHERE candidate_id=?", (candidate_id,))
        conn.execute("DELETE FROM candidate_job_matches WHERE candidate_id=?", (candidate_id,))
        conn.execute("DELETE FROM candidates WHERE id=?", (candidate_id,))
        referenced = _referenced_material_paths(conn)
    _remove_unreferenced_files(files, referenced)
    record_audit("候选人删除", "候选人", candidate_id, before, {"状态": "已删除", "报告及解析文件": "已清理"}, operator, db_path)


def delete_task(task_id: str, operator: str, db_path: Path | str = DB_PATH) -> None:
    """Delete a completed task and its candidates, matches, reports and queue payload."""
    task = row("SELECT * FROM tasks WHERE id=?", (task_id,), db_path)
    if not task:
        raise KeyError(f"任务不存在：{task_id}")
    if task.get("status") in {"待处理", "处理中"}:
        raise ValueError("任务正在处理中，完成或失败后才能删除")
    candidates = get_candidates(task_id, db_path)
    all_reports = get_reports(db_path=db_path)
    candidate_ids = {item["id"] for item in candidates}
    report_rows = [item for item in all_reports if item.get("candidate_id") in candidate_ids]
    before = {"状态": task.get("status"), "任务模式": task.get("task_mode"), "文件数": task.get("total_files", 0), "候选人数": len(candidates), "报告数": len(report_rows)}
    files = [(report.get("path", ""), (REPORT_DIR,)) for report in report_rows]
    files.extend((candidate.get(field), (ORIGINAL_DIR, REDACTED_DIR, STRUCTURED_DIR))
                 for candidate in candidates for field in ("original_path", "redacted_path", "structured_path"))
    with connect(db_path) as conn:
        conn.execute("DELETE FROM reports WHERE candidate_id IN (SELECT id FROM candidates WHERE task_id=?)", (task_id,))
        conn.execute("DELETE FROM candidate_job_matches WHERE task_id=?", (task_id,))
        conn.execute("UPDATE candidates SET source_candidate_id=NULL WHERE source_candidate_id IN (SELECT id FROM candidates WHERE task_id=?)", (task_id,))
        conn.execute("DELETE FROM candidates WHERE task_id=?", (task_id,))
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        referenced = _referenced_material_paths(conn)
    _remove_unreferenced_files(files, referenced)
    _remove_generated_file(QUEUE_DIR / f"{task_id}.json", (QUEUE_DIR,))
    record_audit("批量任务删除", "批量任务", task_id, before, {"状态": "已删除", "关联候选人和报告": "已清理"}, operator, db_path)


def delete_report(report_id: int, operator: str, db_path: Path | str = DB_PATH) -> None:
    """Delete a generated report file/record without touching the candidate."""
    report = row("SELECT * FROM reports WHERE id=?", (report_id,), db_path)
    if not report:
        raise KeyError(f"报告不存在：{report_id}")
    with connect(db_path) as conn:
        conn.execute("DELETE FROM reports WHERE id=?", (report_id,))
        referenced = _referenced_material_paths(conn)
    _remove_unreferenced_files([(report.get('path', ''), (REPORT_DIR,))], referenced)
    record_audit("报告删除", "报告", str(report_id), {"候选人": report.get("candidate_id"), "报告路径": report.get("path")}, {"状态": "已删除"}, operator, db_path)


def get_candidate(candidate_id: str, db_path: Path | str = DB_PATH) -> dict:
    result = row("SELECT * FROM candidates WHERE id=?", (candidate_id,), db_path)
    if not result:
        raise KeyError(f"候选人不存在：{candidate_id}")
    return decode_candidate(result)


def create_task(
    job_id: str,
    filenames: list[str],
    operator: str,
    db_path: Path | str = DB_PATH,
    audit_operation: str = "文件上传",
    batch_name: str = "",
) -> str:
    task_id = f"TASK-{uuid.uuid4().hex[:8].upper()}"
    now = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO tasks(
            id,job_id,task_mode,job_ids_json,status,total_files,created_at,updated_at,batch_name
            ) VALUES(?,?,?,?,?,?,?,?,?)""",
            (task_id, job_id, "岗位找人", json.dumps([job_id], ensure_ascii=False), "待处理", len(filenames), now, now, batch_name.strip()[:100]),
        )
    record_audit(audit_operation, "批量任务", task_id, {}, {"文件数": len(filenames), "文件名": filenames}, operator, db_path)
    return task_id


def create_fit_task(
    job_ids: list[str],
    filenames: list[str],
    operator: str,
    db_path: Path | str = DB_PATH,
    audit_operation: str = "文件上传",
    batch_name: str = "",
) -> str:
    unique_job_ids = list(dict.fromkeys(job_ids))
    if not unique_job_ids:
        raise ValueError("至少选择一个参与匹配的岗位")
    for job_id in unique_job_ids:
        get_job(job_id, db_path)
    task_id = f"FIT-{uuid.uuid4().hex[:8].upper()}"
    now = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO tasks(
            id,job_id,task_mode,job_ids_json,status,total_files,created_at,updated_at,batch_name
            ) VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                task_id,
                unique_job_ids[0],
                "人找岗位",
                json.dumps(unique_job_ids, ensure_ascii=False),
                "待处理",
                len(filenames),
                now,
                now,
                batch_name.strip()[:100],
            ),
        )
    record_audit(
        audit_operation,
        "人才适岗任务",
        task_id,
        {},
        {"文件数": len(filenames), "文件名": filenames, "岗位池": unique_job_ids},
        operator,
        db_path,
    )
    return task_id


def _copy_source(source: Path, task_id: str, *, folder: str = "", filename: str | None = None) -> Path:
    ensure_directories()
    target_dir = ORIGINAL_DIR / task_id
    if folder:
        target_dir = target_dir / folder
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / (filename or source.name)
    if source.resolve() != target.resolve():
        shutil.copy2(source, target)
    return target


def process_resume(
    task_id: str,
    job_id: str,
    resume_path: str | Path,
    operator: str,
    minutes_path: str | Path | None = None,
    db_path: Path | str = DB_PATH,
    allow_ocr: bool = False,
) -> str:
    resume_path = Path(resume_path)
    previous_upload = row("SELECT id FROM candidates WHERE task_id=? AND source_filename=?", (task_id, resume_path.name), db_path)
    if previous_upload:
        return previous_upload["id"]
    original = _copy_source(resume_path, task_id)
    minutes_original = None
    if minutes_path:
        minutes_source = Path(minutes_path)
        # Separate companion files on disk and by evidence label when upload names are identical.
        minutes_name = "面试纪要_" + minutes_source.name if minutes_source.name.casefold() == resume_path.name.casefold() else minutes_source.name
        minutes_original = _copy_source(minutes_source, task_id, folder=f"minutes/{resume_path.name}", filename=minutes_name)
    parsed, privacy_info, redacted_text = parse_material(original, minutes_original, allow_ocr=allow_ocr)
    parsed = enrich_candidate(parsed)
    code = parsed.get("candidate_code")
    if not code or code == "待人工确认":
        code = f"CAND-{uuid.uuid4().hex[:8].upper()}"
        parsed["candidate_code"] = code
    candidate_id = f"{task_id}-{code}"
    if row("SELECT id FROM candidates WHERE id=?", (candidate_id,), db_path):
        candidate_id += "-" + uuid.uuid4().hex[:6].upper()
    redacted_dir = REDACTED_DIR / task_id
    structured_dir = STRUCTURED_DIR / task_id
    redacted_dir.mkdir(parents=True, exist_ok=True)
    structured_dir.mkdir(parents=True, exist_ok=True)
    safe_code = "".join(char if char.isalnum() or char in "-_" else "-" for char in candidate_id)
    redacted_path = redacted_dir / f"{safe_code}.txt"
    structured_path = structured_dir / f"{safe_code}.json"
    if contains_unmasked_sensitive(redacted_text):
        raise AssertionError("脱敏后文本仍包含未遮蔽敏感信息")
    redacted_path.write_text(redacted_text, encoding="utf-8")
    job = get_job(job_id, db_path)
    tags = build_tags(redacted_text, job, parsed.get("raw_evidence"))
    score = calculate_score(tags, job, redacted_text)
    analyze_score(score, parsed, job, candidate_id, operator, db_path)
    payload = {"parsed": parsed, "tags": tags, "score": score, "privacy": privacy_info}
    structured_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    now = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO candidates(
            id,task_id,job_id,full_name,masked_name,source_filename,original_path,redacted_path,structured_path,
            sensitive_detected,sensitive_types_json,redaction_status,parse_status,parsed_json,tags_json,
            score_json,review_comment,decision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                candidate_id, task_id, job_id, parsed["full_name"], parsed["masked_name"], resume_path.name, str(original),
                str(redacted_path), str(structured_path), int(privacy_info["detected"]),
                json.dumps(privacy_info["types"], ensure_ascii=False), "已脱敏" if privacy_info["detected"] else "未检测到敏感信息",
                parsed["parse_status"], json.dumps(parsed, ensure_ascii=False), json.dumps(tags, ensure_ascii=False),
                json.dumps(score, ensure_ascii=False), "", None, now, now,
            ),
        )
    record_audit("脱敏处理", "候选人", candidate_id, {"原始文件": resume_path.name}, {"状态": "已处理", "敏感类型": privacy_info["types"]}, operator, db_path)
    record_audit("模型辅助解析", "候选人", candidate_id, {}, parsed["model_analysis"], operator, db_path)
    record_audit("OCR解析", "候选人", candidate_id, {}, {"已确认外发": allow_ocr, "简历": parsed.get("ocr_analysis", {}), "纪要": parsed.get("minutes_ocr_analysis", {})}, operator, db_path)
    return candidate_id


def process_task(
    task_id: str,
    job_id: str,
    resume_paths: list[str | Path],
    operator: str,
    minutes_map: dict[str, str | Path] | None = None,
    db_path: Path | str = DB_PATH,
    allow_ocr: bool = False,
) -> list[str]:
    candidates: list[str] = []
    failures: list[dict] = []
    minutes_map = minutes_map or {}
    with connect(db_path) as conn:
        conn.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", ("处理中", now_iso(), task_id))
    for index, path in enumerate(resume_paths, 1):
        try:
            stem = Path(path).stem
            minutes_path = minutes_map.get(stem) or minutes_map.get(stem.split("_")[0])
            candidate_id = process_resume(task_id, job_id, path, operator, minutes_path, db_path, allow_ocr=allow_ocr)
            candidates.append(candidate_id)
            issue = _score_analysis_issue(get_candidate(candidate_id, db_path)["score"])
            if issue:
                failures.append({"file": Path(path).name, "candidate_id": candidate_id, "stage": "analysis", "reason": issue})
        except Exception as exc:
            failures.append({"file": Path(path).name, "reason": f"{type(exc).__name__}: {exc}"})
        with connect(db_path) as conn:
            conn.execute(
                "UPDATE tasks SET processed_count=?,success_count=?,failure_count=?,failure_reasons_json=?,updated_at=? WHERE id=?",
                (index, index - len(failures), len(failures), json.dumps(failures, ensure_ascii=False), now_iso(), task_id),
            )
    with connect(db_path) as conn:
        conn.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", ("已完成" if not failures else "部分失败", now_iso(), task_id))
    return candidates


def _score_analysis_issue(score: dict) -> str:
    """Distinguish a finished model attempt from usable assessment results."""
    state = score.get("reasoning_analysis", {})
    attempt = state.get("last_attempt", state)
    if score.get("scoring_method") == "ai_semantic_v1" and attempt.get("status") != "调用成功":
        return "AI分析未完成：" + attempt.get("reason", "服务未返回有效结果")
    if score_value(score) is None and attempt.get('status') != '调用成功':
        return "当前材料没有可计分证据，请补充岗位相关材料后重新分析"
    return ""


def _retain_assessment_on_failure(new_score: dict, previous: dict) -> dict:
    """A failed retry must not erase a previously usable assessment."""
    issue = _score_analysis_issue(new_score)
    if issue and score_value(previous) is not None:
        retained = copy.deepcopy(previous)
        attempt = copy.deepcopy(new_score.get("reasoning_analysis", {}))
        if attempt.get("status") == "调用成功":
            attempt.update(status="无可计分证据", reason=issue)
        retained.setdefault("reasoning_analysis", {})["last_attempt"] = attempt
        return retained
    return new_score


def _write_task_progress(task_id, processed, failures, total, db_path, *, finished=False):
    with connect(db_path) as conn:
        conn.execute(
            """UPDATE tasks SET status=?,total_files=?,processed_count=?,success_count=?,
               failure_count=?,failure_reasons_json=?,updated_at=? WHERE id=?""",
            ("部分失败" if finished and failures else "已完成" if finished else "处理中",
             total, processed, max(0, processed - len(failures)), len(failures),
             json.dumps(failures, ensure_ascii=False), now_iso(), task_id),
        )


def _record_primary_match(candidate_id, operator, db_path):
    """把刚完成的首个岗位评分写入适岗矩阵，避免同一岗位重复调用模型。"""
    candidate = get_candidate(candidate_id, db_path)
    job = get_job(candidate["job_id"], db_path)
    metadata = evaluate_fit_metadata(candidate["tags"], job, candidate["score"])
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO candidate_job_matches(
            task_id,candidate_id,job_id,tags_json,score_json,evidence_completeness,
            confidence,recommendation_level,review_comment,decision,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(candidate_id,job_id) DO UPDATE SET
            tags_json=excluded.tags_json,score_json=excluded.score_json,
            evidence_completeness=excluded.evidence_completeness,
            confidence=excluded.confidence,recommendation_level=excluded.recommendation_level,
            updated_at=excluded.updated_at""",
            (candidate["task_id"], candidate_id, job["id"], json.dumps(candidate["tags"], ensure_ascii=False),
             json.dumps(candidate["score"], ensure_ascii=False), metadata["evidence_completeness"],
             metadata["confidence"], metadata["recommendation_level"], "", None, now_iso()),
        )
    record_audit("适岗分析", "候选人", candidate_id, {},
                 {"岗位数量": 1, "岗位匹配度": {job["id"]: candidate["score"].get("total")}, "说明": "沿用首个岗位的评分结果"},
                 operator, db_path)
    return {"candidate_id": candidate_id, "job_id": job["id"], "tags": candidate["tags"], "score": candidate["score"], **metadata}


def _analyze_fit_candidate(candidate_id, job_ids, operator, db_path, *, primary_job_id=None):
    """Try every job, including after a job-specific failure, before progress advances.

    primary_job_id 指刚刚完成评分的首个岗位；该岗位直接沿用结果，不再重复分析。
    """
    problems = []
    for job_id in dict.fromkeys(job_ids):
        try:
            if job_id == primary_job_id:
                result = _record_primary_match(candidate_id, operator, db_path)
            else:
                result = evaluate_candidate_jobs(candidate_id, [job_id], operator, db_path)[0]
            issue = _score_analysis_issue(result["score"])
            if issue:
                problems.append(f"{get_job(job_id, db_path)['name']}：{issue}")
        except Exception as exc:
            problems.append(f"{job_id}：{type(exc).__name__}: {exc}")
    return "；".join(problems)


def _talent_source(source_id, db_path=DB_PATH):
    """Read independent talent entries while retaining legacy reuse compatibility."""
    from matching_core.services.talent_library import get_entry
    try:
        return get_entry(source_id, db_path)
    except KeyError:
        return get_candidate(source_id, db_path)


def prepare_talent_task(job_ids, entry_ids, talent_batch_id, operator, db_path=DB_PATH, *, fit=False, batch_name=''):
    """Validate one named talent batch before creating a background matching task."""
    from matching_core.services.auth import can
    from matching_core.services.talent_library import get_batch, get_entry
    if not can(operator, 'create_task'):
        raise PermissionError('当前账号无权创建匹配任务')
    ids = list(dict.fromkeys(entry_ids))
    if not 1 <= len(ids) <= MAX_TASK_PEOPLE:
        raise ValueError(f'请选择1至{MAX_TASK_PEOPLE}名人员')
    jobs = list(dict.fromkeys(job_ids))
    if len(jobs) < (2 if fit else 1) or (not fit and len(jobs) != 1):
        raise ValueError('人才适岗至少选择两个岗位，岗位选才选择一个岗位')
    for jid in jobs:
        if not get_job(jid, db_path).get('is_active', 1):
            raise ValueError('所选岗位已删除，请重新选择')
    batch = get_batch(talent_batch_id, db_path)
    entries = [get_entry(eid, db_path) for eid in ids]
    if any(entry['batch_id'] != talent_batch_id for entry in entries):
        raise ValueError('所选人员不属于同一批次，请重新选择')
    if any(entry['status'] != '已解析' or not Path(entry['redacted_path']).is_file() for entry in entries):
        raise ValueError('所选人员有未完成解析的简历，请先在人员库处理')
    name = batch_name.strip() or batch['name']
    names = [entry['source_filename'] for entry in entries]
    task_id = (create_fit_task(jobs, names, operator, db_path, '人员库选用', name) if fit else
               create_task(jobs[0], names, operator, db_path, '人员库选用', name))
    with connect(db_path) as conn:
        conn.execute('UPDATE tasks SET talent_batch_id=? WHERE id=?', (talent_batch_id, task_id))
    return task_id


def get_talent_match_history(entry_id, db_path=DB_PATH):
    from matching_core.services.talent_library import get_entry
    entry = get_entry(entry_id, db_path)
    legacy = entry.get('legacy_candidate_id') or ''
    data = rows('SELECT * FROM candidates WHERE source_candidate_id=? OR id=? OR (?<>\'\' AND source_candidate_id=?) ORDER BY created_at DESC',
                (entry_id, legacy, legacy, legacy), db_path)
    tasks = {task['id']: task for task in get_tasks(db_path)}
    result = []
    for item in data:
        candidate = decode_candidate(item)
        task = tasks.get(candidate['task_id'], {})
        candidate.update(task_name=task.get('batch_name') or candidate['task_id'], task_mode=task.get('task_mode', '岗位找人'),
                         reports=get_reports(candidate['id'], db_path))
        result.append(candidate)
    return result


def _clone_candidate_for_task(
    source_candidate_id: str,
    task_id: str,
    job_id: str,
    operator: str,
    db_path: Path | str = DB_PATH,
) -> str:
    """复用已脱敏材料创建任务内候选人，不重新复制或解析原始 PDF。"""
    source = _talent_source(source_candidate_id, db_path)
    existing = row('SELECT id FROM candidates WHERE task_id=? AND source_candidate_id=?', (task_id, source_candidate_id), db_path)
    if existing:
        return existing['id']
    redacted_path = Path(source["redacted_path"])
    if not redacted_path.exists():
        raise FileNotFoundError(f"脱敏材料不存在：{redacted_path}")
    redacted_text = redacted_path.read_text(encoding="utf-8")
    if contains_unmasked_sensitive(redacted_text):
        raise ValueError("人员库材料包含未脱敏敏感信息，禁止复用")

    job = get_job(job_id, db_path)
    parsed = json.loads(json.dumps(source["parsed"], ensure_ascii=False))
    analysis_material = material_for_analysis(parsed)
    if parsed.get('material_version'):
        redacted_text = material_text(parsed)
    tags = build_tags(redacted_text, job, analysis_material.get("raw_evidence"))
    score = calculate_score(tags, job, redacted_text)
    analyze_score(score, parsed, job, task_id + ":" + source_candidate_id, operator, db_path)
    code = parsed.get("candidate_code") or f"CAND-{uuid.uuid4().hex[:8].upper()}"
    candidate_id = f"{task_id}-{code}"
    if row("SELECT id FROM candidates WHERE id=?", (candidate_id,), db_path):
        candidate_id = f"{candidate_id}-{uuid.uuid4().hex[:6].upper()}"

    structured_dir = STRUCTURED_DIR / task_id
    structured_dir.mkdir(parents=True, exist_ok=True)
    safe_code = "".join(char if char.isalnum() or char in "-_" else "-" for char in str(code))
    structured_path = structured_dir / f"{safe_code}_{uuid.uuid4().hex[:6]}.json"
    privacy_info = {
        "detected": bool(source["sensitive_detected"]),
        "types": source["sensitive_types"],
        "status": source["redaction_status"],
    }
    structured_path.write_text(
        json.dumps({"parsed": parsed, "tags": tags, "score": score, "privacy": privacy_info}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    root_source_id = source.get("source_candidate_id") or source["id"]
    now = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO candidates(
            id,task_id,job_id,source_candidate_id,full_name,masked_name,source_filename,original_path,redacted_path,structured_path,
            sensitive_detected,sensitive_types_json,redaction_status,parse_status,parsed_json,tags_json,
            score_json,review_comment,decision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                candidate_id,
                task_id,
                job_id,
                root_source_id,
                source["full_name"],
                source["masked_name"],
                source["source_filename"],
                source["original_path"],
                source["redacted_path"],
                str(structured_path),
                source["sensitive_detected"],
                json.dumps(source["sensitive_types"], ensure_ascii=False),
                source["redaction_status"],
                source["parse_status"],
                json.dumps(parsed, ensure_ascii=False),
                json.dumps(tags, ensure_ascii=False),
                json.dumps(score, ensure_ascii=False),
                "",
                None,
                now,
                now,
            ),
        )
    record_audit(
        "人员材料复用",
        "候选人",
        candidate_id,
        {},
        {"来源候选人": root_source_id, "来源文件": source["source_filename"], "目标任务": task_id, "重新评分岗位": job_id},
        operator,
        db_path,
    )
    return candidate_id


def _reuse_candidates_in_task(
    task_id: str,
    source_candidate_ids: list[str],
    operator: str,
    db_path: Path | str = DB_PATH,
) -> list[str]:
    task = row("SELECT * FROM tasks WHERE id=?", (task_id,), db_path)
    if not task:
        raise KeyError(f"任务不存在：{task_id}")
    unique_source_ids = list(dict.fromkeys(source_candidate_ids))
    created: list[str] = []
    failures: list[dict] = []
    with connect(db_path) as conn:
        conn.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?", ("处理中", now_iso(), task_id))
    for index, source_candidate_id in enumerate(unique_source_ids, 1):
        label = source_candidate_id
        try:
            label = _talent_source(source_candidate_id, db_path).get("source_filename") or source_candidate_id
            already = row('SELECT id FROM candidates WHERE task_id=? AND source_candidate_id=?', (task_id, source_candidate_id), db_path)
            candidate_id = _clone_candidate_for_task(source_candidate_id, task_id, task["job_id"], operator, db_path)
            created.append(candidate_id)
            if task["task_mode"] == "人找岗位":
                # 新建的人员刚对首个岗位评过分；恢复执行时已有记录则全部岗位重新核对。
                issue = _analyze_fit_candidate(candidate_id, json.loads(task["job_ids_json"]), operator, db_path,
                                               primary_job_id=None if already else task["job_id"])
            else:
                issue = _score_analysis_issue(get_candidate(candidate_id, db_path)["score"])
            if issue:
                failures.append({"file": label, "source_entry_id": source_candidate_id, "candidate_id": candidate_id,
                                 "stage": "analysis", "reason": issue})
        except Exception as exc:
            failures.append({"file": label, "source_entry_id": source_candidate_id, "reason": f"{type(exc).__name__}: {exc}"})
        with connect(db_path) as conn:
            conn.execute(
                """UPDATE tasks SET processed_count=?,success_count=?,failure_count=?,
                failure_reasons_json=?,updated_at=? WHERE id=?""",
                (index, index - len(failures), len(failures), json.dumps(failures, ensure_ascii=False), now_iso(), task_id),
            )
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET status=?,updated_at=? WHERE id=?",
            ("已完成" if not failures else "部分失败", now_iso(), task_id),
        )
    return created


def evaluate_candidate_jobs(
    candidate_id: str,
    job_ids: list[str],
    operator: str,
    db_path: Path | str = DB_PATH,
) -> list[dict]:
    candidate = get_candidate(candidate_id, db_path)
    redacted_text = Path(candidate["redacted_path"]).read_text(encoding="utf-8")
    analysis_material = material_for_analysis(candidate['parsed'])
    if candidate['parsed'].get('material_version'):
        redacted_text = material_text(candidate['parsed'])
    results: list[dict] = []
    for job_id in list(dict.fromkeys(job_ids)):
        job = get_job(job_id, db_path)
        tags = build_tags(redacted_text, job, analysis_material.get("raw_evidence"))
        score = calculate_score(tags, job, redacted_text)
        analyze_score(score, candidate["parsed"], job, candidate_id + ":" + job_id, operator, db_path)
        existing = get_candidate_job_matches(candidate_id=candidate_id, db_path=db_path)
        previous = next((item for item in existing if item["job_id"] == job_id), None)
        if previous:
            score = _retain_assessment_on_failure(score, previous["score"])
        metadata = evaluate_fit_metadata(tags, job, score)
        now = now_iso()
        with connect(db_path) as conn:
            conn.execute(
                """INSERT INTO candidate_job_matches(
                task_id,candidate_id,job_id,tags_json,score_json,evidence_completeness,
                confidence,recommendation_level,review_comment,decision,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(candidate_id,job_id) DO UPDATE SET
                tags_json=excluded.tags_json,score_json=excluded.score_json,
                evidence_completeness=excluded.evidence_completeness,
                confidence=excluded.confidence,recommendation_level=excluded.recommendation_level,
                updated_at=excluded.updated_at""",
                (
                    candidate["task_id"],
                    candidate_id,
                    job_id,
                    json.dumps(tags, ensure_ascii=False),
                    json.dumps(score, ensure_ascii=False),
                    metadata["evidence_completeness"],
                    metadata["confidence"],
                    metadata["recommendation_level"],
                    "",
                    None,
                    now,
                ),
            )
            if job_id == candidate["job_id"]:
                conn.execute("UPDATE candidates SET tags_json=?,score_json=?,updated_at=? WHERE id=?",
                             (json.dumps(tags, ensure_ascii=False), json.dumps(score, ensure_ascii=False), now, candidate_id))
        if job_id == candidate["job_id"]:
            _sync_candidate_snapshot(candidate, tags=tags, score=score)
        results.append({"candidate_id": candidate_id, "job_id": job_id, "tags": tags, "score": score, **metadata})
    record_audit(
        "适岗分析",
        "候选人",
        candidate_id,
        {},
        {"岗位数量": len(results), "岗位匹配度": {item["job_id"]: item["score"]["total"] for item in results}},
        operator,
        db_path,
    )
    return results


def process_fit_task(
    task_id: str,
    resume_paths: list[str | Path],
    operator: str,
    minutes_map: dict[str, str | Path] | None = None,
    db_path: Path | str = DB_PATH,
    allow_ocr: bool = False,
) -> list[str]:
    task = row("SELECT * FROM tasks WHERE id=?", (task_id,), db_path)
    if not task or task.get("task_mode") != "人找岗位":
        raise KeyError(f"人才适岗任务不存在：{task_id}")
    job_ids = json.loads(task["job_ids_json"])
    candidate_ids, failures = [], []
    minutes_map = minutes_map or {}
    total = len(resume_paths)
    _write_task_progress(task_id, 0, failures, total, db_path)
    for index, path in enumerate(resume_paths, 1):
        try:
            stem = Path(path).stem
            minutes_path = minutes_map.get(stem) or minutes_map.get(stem.split("_")[0])
            already = row("SELECT id FROM candidates WHERE task_id=? AND source_filename=?", (task_id, Path(path).name), db_path)
            candidate_id = process_resume(task_id, task["job_id"], path, operator, minutes_path, db_path, allow_ocr=allow_ocr)
            candidate_ids.append(candidate_id)
            issue = _analyze_fit_candidate(candidate_id, job_ids, operator, db_path,
                                           primary_job_id=None if already else task["job_id"])
            if issue:
                failures.append({"file": Path(path).name, "candidate_id": candidate_id, "stage": "analysis", "reason": issue})
        except Exception as exc:
            failures.append({"file": Path(path).name, "stage": "parse", "reason": f"{type(exc).__name__}: {exc}"})
        _write_task_progress(task_id, index, failures, total, db_path)
    _write_task_progress(task_id, total, failures, total, db_path, finished=True)
    return candidate_ids


def get_candidate_job_matches(
    task_id: str | None = None,
    candidate_id: str | None = None,
    db_path: Path | str = DB_PATH,
) -> list[dict]:
    clauses: list[str] = []
    params: list[str] = []
    if task_id:
        clauses.append("task_id=?")
        params.append(task_id)
    if candidate_id:
        clauses.append("candidate_id=?")
        params.append(candidate_id)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    records = rows(f"SELECT * FROM candidate_job_matches{where} ORDER BY candidate_id, id", tuple(params), db_path)
    matches = [decode_candidate_job_match(item) for item in records]
    # 同一人员的岗位按综合匹配度从高到低排列。
    order = {candidate: index for index, candidate in enumerate(dict.fromkeys(item["candidate_id"] for item in matches))}
    return sorted(matches, key=lambda item: (order[item["candidate_id"]], tuple(-value if isinstance(value, (int, float)) else value
                                                                               for value in _descending(score_sort_key(item["score"])))))


def _descending(key):
    return tuple(int(part) if isinstance(part, bool) else part for part in key)


def get_ranked_job_matches(candidate_id: str, db_path: Path | str = DB_PATH) -> list[dict]:
    return sorted(
        get_candidate_job_matches(candidate_id=candidate_id, db_path=db_path),
        key=lambda item: score_sort_key(item["score"]),
        reverse=True,
    )


def save_fit_decision(
    candidate_id: str,
    job_id: str,
    review_comment: str,
    decision: str | None,
    operator: str,
    db_path: Path | str = DB_PATH,
) -> None:
    from matching_core.services.auth import can
    if not can(operator, 'review'):
        raise PermissionError('当前账号无权审核人员资料')
    allowed = (None, "", "推荐至该岗位", "作为备选岗位", "暂不推荐")
    if decision not in allowed:
        raise ValueError("岗位推荐结论值不合法")
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        current = conn.execute('SELECT * FROM candidate_job_matches WHERE candidate_id=? AND job_id=?',
                               (candidate_id, job_id)).fetchone()
        if not current:
            raise KeyError('候选人与岗位的匹配结果不存在')
        _assert_material_review_ready(conn, candidate_id, json.loads(current['score_json']), decision)
        conn.execute(
            """UPDATE candidate_job_matches
            SET review_comment=?,decision=?,updated_at=? WHERE candidate_id=? AND job_id=?""",
            (review_comment, decision or None, now_iso(), candidate_id, job_id),
        )
    record_audit(
        "岗位推荐确认",
        "候选人岗位匹配",
        f"{candidate_id}:{job_id}",
        {"推荐意见": current["review_comment"], "人工结论": current["decision"]},
        {"推荐意见": review_comment, "人工结论": decision or None},
        operator,
        db_path,
    )


def retry_failed_task(task_id: str, operator: str, db_path: Path | str = DB_PATH, *, _queued: bool = False) -> int:
    task = row("SELECT * FROM tasks WHERE id=?", (task_id,), db_path)
    if not task:
        raise KeyError(f"任务不存在：{task_id}")
    failures = json.loads(task["failure_reasons_json"])
    if not failures:
        return 0
    from matching_core.services.auth import can
    if not can(operator, "create_task"):
        raise PermissionError("当前账号无权重新分析任务")
    if not _queued and task["status"] in {"待处理", "处理中"}:
        raise ValueError("任务正在处理中，请等待完成后重试")
    job_ids = json.loads(task["job_ids_json"]) or [task["job_id"]]
    queue_path = QUEUE_DIR / f"{task_id}.json"
    try:
        payload = json.loads(queue_path.read_text(encoding="utf-8")) if queue_path.exists() else {}
    except (OSError, ValueError):
        payload = {}
    with connect(db_path) as conn:
        updated = conn.execute("UPDATE tasks SET status='处理中',updated_at=? WHERE id=?" +
                               ("" if _queued else " AND status NOT IN ('待处理','处理中')"), (now_iso(), task_id))
        if not updated.rowcount:
            raise ValueError("任务正在处理中，请等待完成后重试")
    succeeded = 0
    remaining = []
    for item in failures:
        source = ORIGINAL_DIR / task_id / item["file"]
        try:
            candidate_id = item.get("candidate_id")
            if not candidate_id and item.get('source_entry_id'):
                # 来自人员库的人员按人员编号定位（文件名可能重复）；已建过记录时直接沿用。
                candidate_id = _clone_candidate_for_task(item['source_entry_id'], task_id, task['job_id'], operator, db_path)
            if not candidate_id:
                existing = row("SELECT id FROM candidates WHERE task_id=? AND source_filename=?", (task_id, item["file"]), db_path)
                candidate_id = existing["id"] if existing else None
            if not candidate_id:
                if not source.exists():
                    source = next((Path(p) for p in payload.get("resume_paths", []) if Path(p).name == item["file"]), source)
                if not source.exists():
                    raise FileNotFoundError(item["file"])
                stem = source.stem
                minutes = payload.get("minutes_map", {})
                minute_path = minutes.get(stem) or minutes.get(stem.split("_")[0])
                candidate_id = process_resume(task_id, task["job_id"], source, operator, minute_path,
                                              db_path, allow_ocr=payload.get("allow_ocr", False))
            if task.get("task_mode") == "人找岗位":
                issue = _analyze_fit_candidate(candidate_id, job_ids, operator, db_path)
            else:
                issue = _score_analysis_issue(rescore_candidate(candidate_id, operator, db_path))
            if issue:
                remaining.append({**item, "candidate_id": candidate_id, "stage": "analysis", "reason": issue})
            else:
                succeeded += 1
        except Exception as exc:
            remaining.append({**item, "reason": f"{type(exc).__name__}: {exc}"})
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET success_count=success_count+?,failure_count=?,failure_reasons_json=?,status=?,updated_at=? WHERE id=?",
            (succeeded, len(remaining), json.dumps(remaining, ensure_ascii=False), "已完成" if not remaining else "部分失败", now_iso(), task_id),
        )
    record_audit("失败重试", "批量任务", task_id, failures, remaining, operator, db_path)
    return succeeded


def reanalyze_task(task_id: str, operator: str, db_path: Path | str = DB_PATH) -> list[str]:
    """Reassess persisted, sanitized material; never re-upload or replace decisions."""
    from matching_core.services.auth import can
    if not can(operator, "review"):
        raise PermissionError("当前账号无权重新分析任务")
    task = row("SELECT * FROM tasks WHERE id=?", (task_id,), db_path)
    if not task:
        raise KeyError("任务不存在")
    candidates = get_candidates(task_id, db_path)
    if not candidates:
        raise ValueError("任务没有已解析材料，请先重试失败文件")
    job_ids = json.loads(task["job_ids_json"]) or [task["job_id"]]
    filenames = {candidate["source_filename"] for candidate in candidates}
    unresolved_files = [item for item in json.loads(task["failure_reasons_json"])
                        if item.get("stage") != "task" and not item.get("candidate_id") and item.get("file") not in filenames]
    failures, completed = list(unresolved_files), []
    total = len(candidates) + len(unresolved_files)
    _write_task_progress(task_id, len(unresolved_files), failures, total, db_path)
    for index, candidate in enumerate(candidates, 1):
        try:
            issue = (_analyze_fit_candidate(candidate["id"], job_ids, operator, db_path)
                     if task.get("task_mode") == "人找岗位" else
                     _score_analysis_issue(rescore_candidate(candidate["id"], operator, db_path)))
            if issue:
                failures.append({"file": candidate["source_filename"], "candidate_id": candidate["id"], "stage": "analysis", "reason": issue})
            else:
                completed.append(candidate["id"])
        except Exception as exc:
            failures.append({"file": candidate["source_filename"], "candidate_id": candidate["id"], "stage": "analysis", "reason": f"{type(exc).__name__}: {exc}"})
        _write_task_progress(task_id, index + len(unresolved_files), failures, total, db_path)
    _write_task_progress(task_id, total, failures, total, db_path, finished=True)
    record_audit("任务重新分析", "匹配任务", task_id, {}, {"成功人数": len(completed), "失败人数": len(failures)}, operator, db_path)
    return completed


def _sync_candidate_snapshot(candidate, **updates):
    snapshot = Path(candidate.get("structured_path", ""))
    if snapshot.is_file():
        data = json.loads(snapshot.read_text(encoding="utf-8"))
        data.update(updates)
        snapshot.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _next_weight_version(current: str) -> str:
    """权重版本号按修订次数递增：W-NEW-1.0 → W-NEW-1.0-R1 → W-NEW-1.0-R2。"""
    import re
    match = re.fullmatch(r"(.*?)((?:-R\d*)+)", current or "")
    if not match:
        return f"{current}-R1"
    revisions = sum(int(number or 1) for number in re.findall(r"-R(\d*)", match.group(2)))
    return f"{match.group(1)}-R{revisions + 1}"


def normalize_scorecard(dimensions: list[dict], weights: dict[str, float]) -> tuple[list[dict], dict[str, float]]:
    """校验并整理能力标签和权重，不写库。保存岗位前先调用，保证校验不通过时什么都不会被改动。"""
    cleaned, seen = [], set()
    for item in dimensions:
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        if name in seen:
            raise ValueError(f"评分维度“{name}”重复，请合并后保存")
        seen.add(name)
        keywords = list(dict.fromkeys(str(word).strip() for word in item.get("keywords", []) if str(word).strip()))
        cleaned.append({**copy.deepcopy(item), "name": name, "keywords": keywords,
                        "negative_keywords": list(item.get("negative_keywords", []))})
    if not cleaned:
        raise ValueError("岗位至少需要一个胜任力维度")
    weights = {str(name).strip(): float(value) for name, value in weights.items()}
    if set(weights) != seen:
        raise ValueError("评分维度与权重需要一一对应")
    validate_weights(weights)
    return cleaned, weights


def update_job_scorecard(job_id: str, dimensions: list[dict], weights: dict[str, float], operator: str,
                         db_path: Path | str = DB_PATH) -> dict:
    """保存岗位的能力标签（评分维度、证据关键词）和权重。

    只调整权重时沿用已有评分直接重算；维度或关键词有变化时，已有评分标记为需重新分析。
    返回 {"changed": 是否改动了维度或关键词, "synchronized": 同步的人员数}。
    """
    from matching_core.services.auth import can
    if not can(operator, 'edit_job'):
        raise PermissionError('当前角色不能维护岗位评分标准')
    job = get_job(job_id, db_path)
    cleaned, weights = normalize_scorecard(dimensions, weights)

    def signature(items):
        return [(d["name"], list(d.get("keywords", [])), list(d.get("negative_keywords", []))) for d in items]

    if signature(cleaned) == signature(job["dimensions"]):
        synchronized = update_job_weights(job_id, weights, operator, db_path) if weights != job["weights"] else 0
        return {"changed": False, "synchronized": synchronized}
    version = _next_weight_version(job["weight_version"])
    with connect(db_path) as conn:
        conn.execute("UPDATE jobs SET dimensions_json=?,weights_json=?,weight_version=?,updated_at=? WHERE id=?",
                     (json.dumps(cleaned, ensure_ascii=False), json.dumps(weights, ensure_ascii=False), version, now_iso(), job_id))
    record_audit("评分标准修改", "岗位", job_id, {"dimensions": job["dimensions"], "weights": job["weights"]},
                 {"dimensions": cleaned, "weights": weights}, operator, db_path)
    _invalidate_job_assessments(job_id, "岗位能力标签或评分维度已修改", db_path)
    return {"changed": True, "synchronized": 0}


def update_job_weights(job_id: str, weights: dict[str, float], operator: str, db_path: Path | str = DB_PATH) -> int:
    validate_weights(weights)
    job = get_job(job_id, db_path)
    if set(weights) != set(job["weights"]):
        raise ValueError("权重调整不能增删评分维度，请在岗位评分标准中核对维度")
    before = job["weights"]
    version = _next_weight_version(job["weight_version"])
    updated_job = {**job, "weights": weights, "weight_version": version}
    synchronized, changed_candidates = set(), []

    def reweight(score, tags):
        if {item["dimension"] for item in score.get("dimensions", [])} != set(weights):
            score["requires_reassessment"] = True
            return score
        for dimension in score["dimensions"]:
            dimension["weight"] = float(weights[dimension["dimension"]])
        score["job_weight_version"] = version
        return annotate_score_evidence(score, tags)

    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE jobs SET weights_json=?,weight_version=?,updated_at=? WHERE id=?", (json.dumps(weights, ensure_ascii=False), version, now_iso(), job_id))
        for record in conn.execute("SELECT * FROM candidates WHERE job_id=?", (job_id,)).fetchall():
            candidate = decode_candidate(record)
            score = reweight(candidate["score"], candidate["tags"])
            conn.execute("UPDATE candidates SET score_json=?,updated_at=? WHERE id=?",
                         (json.dumps(score, ensure_ascii=False), now_iso(), candidate["id"]))
            changed_candidates.append((candidate, score))
            synchronized.add(candidate["id"])
        for record in conn.execute("SELECT * FROM candidate_job_matches WHERE job_id=?", (job_id,)).fetchall():
            match = decode_candidate_job_match(record)
            score = reweight(match["score"], match["tags"])
            metadata = evaluate_fit_metadata(match["tags"], updated_job, score)
            conn.execute("""UPDATE candidate_job_matches SET score_json=?,evidence_completeness=?,confidence=?,
                         recommendation_level=?,updated_at=? WHERE id=?""",
                         (json.dumps(score, ensure_ascii=False), metadata["evidence_completeness"], metadata["confidence"],
                          metadata["recommendation_level"], now_iso(), match["id"]))
            synchronized.add(match["candidate_id"])
    for candidate, score in changed_candidates:
        _sync_candidate_snapshot(candidate, score=score)
    record_audit("权重修改", "岗位", job_id, before, weights, operator, db_path)
    return len(synchronized)


def rescore_candidate(candidate_id: str, operator: str, db_path: Path | str = DB_PATH) -> dict:
    candidate = get_candidate(candidate_id, db_path)
    job = get_job(candidate["job_id"], db_path)
    text = Path(candidate["redacted_path"]).read_text(encoding="utf-8")
    analysis_material = material_for_analysis(candidate['parsed'])
    if candidate['parsed'].get('material_version'):
        text = material_text(candidate['parsed'])
    tags = build_tags(text, job, analysis_material.get("raw_evidence"))
    score = calculate_score(tags, job, text)
    analyze_score(score, candidate["parsed"], job, candidate_id, operator, db_path)
    score = _retain_assessment_on_failure(score, candidate["score"])
    metadata = evaluate_fit_metadata(tags, job, score)
    with connect(db_path) as conn:
        conn.execute("UPDATE candidates SET tags_json=?,score_json=?,updated_at=? WHERE id=?",
                     (json.dumps(tags, ensure_ascii=False), json.dumps(score, ensure_ascii=False), now_iso(), candidate_id))
    with connect(db_path) as conn:
        conn.execute("""UPDATE candidate_job_matches SET tags_json=?,score_json=?,evidence_completeness=?,
                     confidence=?,recommendation_level=?,updated_at=? WHERE candidate_id=? AND job_id=?""",
                     (json.dumps(tags, ensure_ascii=False), json.dumps(score, ensure_ascii=False), metadata["evidence_completeness"],
                      metadata["confidence"], metadata["recommendation_level"], now_iso(), candidate_id, candidate['job_id']))
    _sync_candidate_snapshot(candidate, tags=tags, score=score)
    record_audit("重新评分", "候选人", candidate_id, candidate["score"], score, operator, db_path)
    return score


def rescore_job_candidates(job_id: str, operator: str, db_path: Path | str = DB_PATH) -> int:
    candidates = [c for c in get_candidates(db_path=db_path) if c["job_id"] == job_id]
    fit_rows = rows("SELECT DISTINCT candidate_id FROM candidate_job_matches WHERE job_id=?", (job_id,), db_path)
    fit_ids = {item["candidate_id"] for item in fit_rows}
    for candidate in candidates:
        if candidate["id"] not in fit_ids:
            rescore_candidate(candidate["id"], operator, db_path)
    for item in fit_rows:
        evaluate_candidate_jobs(item["candidate_id"], [job_id], operator, db_path)
    return len({item["id"] for item in candidates} | fit_ids)


def update_candidate_material(candidate_id, fields, operator, db_path=DB_PATH, *, full_name=None,
                              confirmed=True, expected_material_version=None):
    """Save a reviewable material copy and invalidate every affected job assessment."""
    from matching_core.services.auth import can
    if not can(operator, 'review'):
        raise PermissionError('当前账号无权修改人员资料')
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = conn.execute('SELECT * FROM candidates WHERE id=?', (candidate_id,)).fetchone()
        if not record:
            raise KeyError('候选人不存在，请刷新列表')
        candidate = decode_candidate(record)
        task = conn.execute('SELECT status FROM tasks WHERE id=?', (candidate['task_id'],)).fetchone()
        if task and task['status'] in ('待处理', '处理中'):
            raise ValueError('任务正在处理中，请等待完成后修改资料')
        version = int(candidate['parsed'].get('material_version', 0))
        if expected_material_version is not None and expected_material_version != version:
            raise ValueError('资料已被其他操作修改，请刷新后重新编辑')
        parsed, changed = prepare_material_update(candidate['parsed'], fields, full_name=full_name, confirmed=confirmed)
        now = now_iso()
        parsed['material_updated_at'] = now
        parsed['material_updated_by'] = operator
        score = copy.deepcopy(candidate['score'])
        # 姓名在送入模型前已脱敏，不参与评分：只改姓名不需要重新分析，也不撤销已有的人工结论。
        content_changed = [key for key in changed if key != 'full_name']
        if content_changed:
            score.update(requires_reassessment=True, reassessment_reason='人员资料已修改，请重新分析并审核')
        conn.execute('''UPDATE candidates SET full_name=?,masked_name=?,parsed_json=?,parse_status=?,score_json=?,
                     decision=?,updated_at=? WHERE id=?''',
                     (parsed.get('full_name', candidate['full_name']), parsed.get('masked_name', candidate['masked_name']),
                      json.dumps(parsed, ensure_ascii=False), parsed['parse_status'], json.dumps(score, ensure_ascii=False),
                      None if content_changed else candidate['decision'], now, candidate_id))
        if content_changed:
            for match in conn.execute('SELECT id,score_json FROM candidate_job_matches WHERE candidate_id=?', (candidate_id,)).fetchall():
                match_score = json.loads(match['score_json'])
                match_score.update(requires_reassessment=True, reassessment_reason='人员资料已修改，请重新分析并审核')
                conn.execute('UPDATE candidate_job_matches SET score_json=?,decision=NULL,updated_at=? WHERE id=?',
                             (json.dumps(match_score, ensure_ascii=False), now, match['id']))
    snapshot_warning = ''
    try:
        _sync_candidate_snapshot(candidate, parsed=parsed, score=score)
    except (OSError, ValueError):
        snapshot_warning = '资料已保存到数据库，本地资料快照暂未同步；请检查目录权限后重试。'
    record_audit('字段修正' if changed else '资料确认' if confirmed else '资料修改', '候选人', candidate_id,
                 {'姓名': candidate['full_name'], '字段': candidate['parsed'].get('fields', {})},
                 {'姓名': parsed.get('full_name'), '字段': parsed['fields'], '变更字段': changed,
                  '确认状态': parsed['parse_status'], '资料版本': parsed['material_version'],
                  '快照提示': snapshot_warning}, operator, db_path)
    result = get_candidate(candidate_id, db_path)
    if snapshot_warning:
        result['material_snapshot_warning'] = snapshot_warning
    return result


def save_review(candidate_id: str, review_comment: str, decision: str | None, operator: str, db_path: Path | str = DB_PATH) -> None:
    from matching_core.services.auth import can
    if not can(operator, 'review'):
        raise PermissionError('当前账号无权审核人员资料')
    if decision not in (None, "", "进入下一轮", "保留", "淘汰"):
        raise ValueError("人工决策值不合法")
    with connect(db_path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = conn.execute('SELECT * FROM candidates WHERE id=?', (candidate_id,)).fetchone()
        if not record:
            raise KeyError('候选人不存在')
        candidate = decode_candidate(record)
        _assert_material_review_ready(conn, candidate_id, candidate['score'], decision)
        conn.execute("UPDATE candidates SET review_comment=?,decision=?,updated_at=? WHERE id=?", (review_comment, decision or None, now_iso(), candidate_id))
    record_audit("人工决策", "候选人", candidate_id, {"复核意见": candidate["review_comment"], "决策": candidate["decision"]}, {"复核意见": review_comment, "决策": decision or None}, operator, db_path)


def _assert_material_review_ready(conn, candidate_id, score, decision):
    task = conn.execute('SELECT t.status FROM tasks t JOIN candidates c ON c.task_id=t.id WHERE c.id=?',
                        (candidate_id,)).fetchone()
    if task and task['status'] in ('待处理', '处理中'):
        raise ValueError('任务正在处理中，请等待完成后审核')
    if decision and score.get('requires_reassessment'):
        raise ValueError('人员资料已修改，请先重新分析，再提交人工审核结论')


def get_sorted_candidates(task_id: str, db_path: Path | str = DB_PATH) -> list[dict]:
    candidates = get_candidates(task_id, db_path)
    return sorted(candidates, key=lambda item: score_sort_key(item["score"]), reverse=True)


