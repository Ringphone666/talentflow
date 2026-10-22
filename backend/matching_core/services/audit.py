from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from matching_core.config import DB_PATH
from matching_core.db import connect, now_iso
from matching_core.services.privacy import redact_sensitive


def _safe(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, default=str)
    return redact_sensitive(raw).text


def record_audit(
    operation_type: str,
    object_type: str,
    object_id: str,
    before: Any,
    after: Any,
    operator: str,
    db_path: Path | str = DB_PATH,
) -> None:
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO audits(operation_time,operation_type,object_type,object_id,before_json,after_json,operator) VALUES(?,?,?,?,?,?,?)",
            (now_iso(), operation_type, object_type, object_id, _safe(before), _safe(after), operator),
        )

