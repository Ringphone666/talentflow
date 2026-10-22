from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from matching_core.config import CONFIG_DIR, DB_PATH, ensure_directories, portable_path
from matching_core.services.scoring import annotate_score_evidence, evaluate_fit_metadata


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sequence TEXT NOT NULL,
    level TEXT NOT NULL,
    jd_version TEXT NOT NULL,
    responsibilities TEXT NOT NULL,
    requirements TEXT NOT NULL,
    hard_conditions_json TEXT NOT NULL,
    dimensions_json TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    weight_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    extra_sections_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    batch_name TEXT NOT NULL DEFAULT '',
    talent_batch_id TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL REFERENCES jobs(id),
    task_mode TEXT NOT NULL DEFAULT '岗位找人',
    job_ids_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    total_files INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    failure_reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    source_candidate_id TEXT,
    full_name TEXT NOT NULL DEFAULT '',
    masked_name TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    original_path TEXT NOT NULL,
    redacted_path TEXT NOT NULL,
    structured_path TEXT NOT NULL,
    sensitive_detected INTEGER NOT NULL DEFAULT 0,
    sensitive_types_json TEXT NOT NULL DEFAULT '[]',
    redaction_status TEXT NOT NULL,
    parse_status TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    score_json TEXT NOT NULL DEFAULT '{}',
    review_comment TEXT NOT NULL DEFAULT '',
    decision TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_time TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    operator TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    path TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    operator TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_job_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    tags_json TEXT NOT NULL DEFAULT '[]',
    score_json TEXT NOT NULL DEFAULT '{}',
    evidence_completeness REAL NOT NULL DEFAULT 0,
    confidence TEXT NOT NULL DEFAULT '低',
    recommendation_level TEXT NOT NULL DEFAULT '当前证据下适配度较低',
    review_comment TEXT NOT NULL DEFAULT '',
    decision TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(candidate_id, job_id)
);
CREATE TABLE IF NOT EXISTS talent_batches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '未分类',
    operator TEXT NOT NULL DEFAULT '',
    legacy_task_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS talent_batches_legacy_task
    ON talent_batches(legacy_task_id) WHERE legacy_task_id <> '';
CREATE TABLE IF NOT EXISTS talent_entries (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES talent_batches(id),
    legacy_candidate_id TEXT NOT NULL DEFAULT '',
    full_name TEXT NOT NULL DEFAULT '',
    masked_name TEXT NOT NULL DEFAULT '',
    source_filename TEXT NOT NULL,
    original_path TEXT NOT NULL DEFAULT '',
    redacted_path TEXT NOT NULL DEFAULT '',
    structured_path TEXT NOT NULL DEFAULT '',
    sensitive_detected INTEGER NOT NULL DEFAULT 0,
    sensitive_types_json TEXT NOT NULL DEFAULT '[]',
    redaction_status TEXT NOT NULL DEFAULT '',
    parse_status TEXT NOT NULL DEFAULT '待解析',
    status TEXT NOT NULL DEFAULT '待解析',
    error_message TEXT NOT NULL DEFAULT '',
    parsed_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS talent_entries_batch ON talent_entries(batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS talent_entries_legacy_candidate
    ON talent_entries(legacy_candidate_id) WHERE legacy_candidate_id <> '';
"""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


@contextmanager
def connect(db_path: Path | str = DB_PATH) -> Iterator[sqlite3.Connection]:
    ensure_directories()
    # 后台任务与页面请求会同时写库，等待时间放宽到 30 秒，避免偶发的“database is locked”。
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def data_dir_of(db_path: Path | str) -> Path:
    """数据库所在目录即该库附件的数据目录（测试使用临时库时同样成立）。"""
    return Path(db_path).resolve().parent


def init_db(db_path: Path | str = DB_PATH, seed: bool = False) -> None:
    with connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        job_columns = {item["name"] for item in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "is_active" not in job_columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
        if "extra_sections_json" not in job_columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN extra_sections_json TEXT NOT NULL DEFAULT '{}'")
        columns = {item["name"] for item in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        if "batch_name" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN batch_name TEXT NOT NULL DEFAULT ''")
        if "talent_batch_id" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN talent_batch_id TEXT NOT NULL DEFAULT ''")
        if "task_mode" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN task_mode TEXT NOT NULL DEFAULT '岗位找人'")
        if "job_ids_json" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN job_ids_json TEXT NOT NULL DEFAULT '[]'")
        candidate_columns = {item["name"] for item in conn.execute("PRAGMA table_info(candidates)").fetchall()}
        if "source_candidate_id" not in candidate_columns:
            conn.execute("ALTER TABLE candidates ADD COLUMN source_candidate_id TEXT")
        if "full_name" not in candidate_columns:
            conn.execute("ALTER TABLE candidates ADD COLUMN full_name TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """UPDATE candidates
            SET full_name=COALESCE(NULLIF(json_extract(parsed_json, '$.full_name'), ''), masked_name)
            WHERE full_name=''"""
        )
        conn.execute(
            "UPDATE tasks SET job_ids_json=json_array(job_id) WHERE job_ids_json='[]' OR job_ids_json=''"
        )
    if seed:
        seed_jobs(db_path)


def seed_jobs(db_path: Path | str = DB_PATH, job_files=None) -> None:
    # Explicit import only. Normal startup creates an empty schema, not jobs.
    job_files = job_files if job_files is not None else [CONFIG_DIR / "demo_jobs.json"]
    if not any(path.exists() for path in job_files):
        return
    jobs = []
    for job_file in job_files:
        if job_file.exists():
            payload = json.loads(job_file.read_text(encoding="utf-8"))
            # Import files can be arrays; a structured import can be a
            # knowledge-base object whose roles live under ``roles``.
            jobs.extend(payload if isinstance(payload, list) else payload.get("roles", []))
    with connect(db_path) as conn:
        for job in jobs:
            # Import files provide initial jobs only. Once a job exists,
            # its editable name, requirements and weights are owned by the
            # database and must survive every Streamlit rerun or restart.
            conn.execute(
                """INSERT INTO jobs(
                id,name,sequence,level,jd_version,responsibilities,requirements,
                hard_conditions_json,dimensions_json,weights_json,weight_version,scope,extra_sections_json,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO NOTHING""",
                (
                    job["id"], job["name"], job["sequence"], job["level"], job.get("jd_version", "JD-DEMO-HR-2026.1"),
                    "\n".join(job["responsibilities"]), "\n".join(job["requirements"]),
                    json.dumps(job["hard_conditions"], ensure_ascii=False),
                    json.dumps(job["dimensions"], ensure_ascii=False),
                    json.dumps(job["weights"], ensure_ascii=False), job.get("weight_version", "W-DEMO-HR-1.0"),
                    job.get("scope", "虚构演示岗位；不代表任何组织"),
                    json.dumps(job.get("extra_sections", {}), ensure_ascii=False), now_iso(),
                ),
            )


def rows(sql: str, params: tuple[Any, ...] = (), db_path: Path | str = DB_PATH) -> list[dict]:
    with connect(db_path) as conn:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def row(sql: str, params: tuple[Any, ...] = (), db_path: Path | str = DB_PATH) -> dict | None:
    result = rows(sql, params, db_path)
    return result[0] if result else None


def decode_job(record: dict) -> dict:
    data = dict(record)
    for key in ("hard_conditions_json", "dimensions_json", "weights_json", "extra_sections_json"):
        data[key.removesuffix("_json")] = json.loads(data.pop(key))
    data["responsibilities"] = data["responsibilities"].splitlines()
    data["requirements"] = data["requirements"].splitlines()
    return data


PATH_COLUMNS = ("original_path", "redacted_path", "structured_path")


def relocate_paths(data: dict, columns=PATH_COLUMNS) -> dict:
    for column in columns:
        if data.get(column):
            data[column] = portable_path(data[column])
    return data


def decode_candidate(record: dict) -> dict:
    data = relocate_paths(dict(record))
    for key in ("sensitive_types_json", "parsed_json", "tags_json", "score_json"):
        data[key.removesuffix("_json")] = json.loads(data.pop(key))
    annotate_score_evidence(data["score"], data["tags"])
    data["full_name"] = data.get("full_name") or data["parsed"].get("full_name") or data["masked_name"]
    return data


def decode_candidate_job_match(record: dict) -> dict:
    data = dict(record)
    data["tags"] = json.loads(data.pop("tags_json"))
    data["score"] = json.loads(data.pop("score_json"))
    annotate_score_evidence(data["score"], data["tags"])
    if data['score'].get('scoring_method') == 'ai_semantic_v1':
        data.update(evaluate_fit_metadata(data['tags'], {'weights': {d['dimension']: d['weight'] for d in data['score']['dimensions']}}, data['score']))
    if data["score"]["assessment_status"] == "待评估":
        data["recommendation_level"] = "待评估：缺少可计分证据"
    return data
