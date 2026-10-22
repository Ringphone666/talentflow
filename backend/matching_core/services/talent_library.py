"""人员库：与岗位无关的人员批次和简历资料，供人岗匹配和AI面试共同使用。

表名沿用 talent_batches / talent_entries；界面与审计一律称“人员库”（公司另有“人才库”概念）。
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from matching_core.config import DATA_DIR, DB_PATH
from matching_core.db import connect, now_iso, relocate_paths, row, rows
from matching_core.services.audit import record_audit
from matching_core.services.auth import can
from matching_core.services.model_adapter import enrich_candidate
from matching_core.services.parser import parse_material
from matching_core.services.privacy import contains_unmasked_sensitive

CATEGORIES = ("校招", "社招", "内聘", "未分类")
# 旧版审计使用“人才库”，读取历史记录时两种名称都要识别。
AUDIT_OBJECT = "人员库"
LEGACY_AUDIT_OBJECT = "人才库"
MAX_FILE_BYTES = 50 * 1024 * 1024


def _require(operator: str, permission: str) -> None:
    if not can(operator, permission):
        action = {"create_task": "导入", "export_report": "导出", "delete_data": "删除", "review": "修改"}.get(permission, "操作")
        raise PermissionError(f"当前角色无权{action}人员资料")


def _root(db_path=DB_PATH) -> Path:
    return (DATA_DIR if Path(db_path).resolve() == Path(DB_PATH).resolve() else Path(db_path).resolve().parent) / "talent"


def _filename(value: str) -> str:
    name = str(value).replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:160] or "未命名文件"


def _decode(record: dict) -> dict:
    data = relocate_paths(dict(record))
    data["parsed"] = json.loads(data.pop("parsed_json") or "{}")
    data["sensitive_types"] = json.loads(data.pop("sensitive_types_json") or "[]")
    data["full_name"] = data.get("full_name") or data["parsed"].get("full_name") or "待人工确认"
    data["material_version"] = int(data["parsed"].get("material_version", 0))
    return data


def list_batches(db_path=DB_PATH) -> list[dict]:
    return rows("""SELECT b.*, COUNT(e.id) AS total_count,
        SUM(CASE WHEN e.status='已解析' THEN 1 ELSE 0 END) AS parsed_count,
        SUM(CASE WHEN e.status='解析失败' THEN 1 ELSE 0 END) AS failed_count
        FROM talent_batches b LEFT JOIN talent_entries e ON e.batch_id=b.id
        GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC""", db_path=db_path)


def get_batch(batch_id: str, db_path=DB_PATH) -> dict:
    batch = next((item for item in list_batches(db_path) if item["id"] == batch_id), None)
    if not batch:
        raise KeyError("人员批次不存在")
    return batch


def list_entries(batch_id: str | None = None, db_path=DB_PATH) -> list[dict]:
    sql = "SELECT * FROM talent_entries"
    params = ()
    if batch_id is not None:
        sql += " WHERE batch_id=?"
        params = (batch_id,)
    return [_decode(item) for item in rows(sql + " ORDER BY created_at,rowid", params, db_path)]


def get_entry(entry_id: str, db_path=DB_PATH) -> dict:
    stored = row("SELECT * FROM talent_entries WHERE id=?", (entry_id,), db_path)
    if not stored:
        raise KeyError("人员资料不存在")
    return _decode(stored)


def update_entry_material(entry_id: str, fields: dict, operator: str, db_path=DB_PATH, *,
                          full_name=None, confirmed=True, expected_material_version=None) -> dict:
    """Save corrected library facts without changing originals or existing task copies."""
    from matching_core.services.audit import _safe as audit_safe
    from matching_core.services.material_review import has_material_content, material_text, prepare_material_update
    from matching_core.services.privacy import redact_sensitive

    _require(operator, "review")
    created_paths = []
    try:
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            stored = conn.execute("SELECT * FROM talent_entries WHERE id=?", (entry_id,)).fetchone()
            if not stored:
                raise KeyError("人员资料不存在，请刷新后重试")
            before = _decode(dict(stored))
            if before["status"] == "待解析":
                raise ValueError("这份简历正在解析，请等待完成后修改")
            if expected_material_version is not None and expected_material_version != before["material_version"]:
                raise ValueError("资料已被其他操作更新，请刷新后重新修改")
            parsed, changed = prepare_material_update(before["parsed"], fields, full_name=full_name, confirmed=confirmed)
            if before["status"] != "已解析" and not has_material_content(parsed):
                raise ValueError("请至少填写一项有效简历资料，再保存或确认")
            redacted = redact_sensitive(material_text(parsed)).text
            if not redacted.strip():
                raise ValueError("请至少填写一项有效简历资料，再保存或确认")
            if not parsed.get("candidate_code") or parsed["candidate_code"] == "待人工确认":
                parsed["candidate_code"] = entry_id
            target = _root(db_path) / before["batch_id"] / entry_id
            target.mkdir(parents=True, exist_ok=True)
            revision = f"review_{parsed['material_version']}_{uuid4().hex[:8]}"
            redacted_path, structured_path = target / (revision + ".txt"), target / (revision + ".json")
            # Unique snapshots keep task references stable and let a failed transaction discard only its own files.
            privacy = {"detected": bool(before["sensitive_detected"]), "types": before["sensitive_types"],
                       "status": before["redaction_status"] or "未检测到敏感信息"}
            created_paths.append(redacted_path)
            redacted_path.write_text(redacted, encoding="utf-8")
            created_paths.append(structured_path)
            structured_path.write_text(json.dumps({"parsed": parsed, "privacy": privacy}, ensure_ascii=False, indent=2), encoding="utf-8")
            conn.execute("""UPDATE talent_entries SET full_name=?,masked_name=?,parse_status=?,status='已解析',
                error_message='',parsed_json=?,redacted_path=?,structured_path=?,redaction_status=?,updated_at=? WHERE id=?""",
                (parsed.get("full_name") or before["full_name"], parsed.get("masked_name") or before["masked_name"],
                 parsed["parse_status"], json.dumps(parsed, ensure_ascii=False), str(redacted_path), str(structured_path),
                 privacy["status"], now_iso(), entry_id))
            conn.execute("UPDATE talent_batches SET updated_at=? WHERE id=?", (now_iso(), before["batch_id"]))
            conn.execute("""INSERT INTO audits(operation_time,operation_type,object_type,object_id,before_json,after_json,operator)
                VALUES(?,?,?,?,?,?,?)""", (now_iso(), "确认人员资料" if confirmed else "修改人员资料", AUDIT_OBJECT, entry_id,
                audit_safe({"资料版本": before["material_version"], "姓名": before["full_name"], "字段": before["parsed"].get("fields", {})}),
                audit_safe({"资料版本": parsed["material_version"], "姓名": parsed.get("full_name"), "字段": parsed.get("fields", {}),
                            "修改项目": changed, "已确认": bool(confirmed)}), operator))
    except Exception:
        for path in created_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return get_entry(entry_id, db_path)


def create_batch(name: str, category: str, operator: str, db_path=DB_PATH) -> str:
    _require(operator, "create_task")
    name = str(name).strip()
    if not name or len(name) > 100:
        raise ValueError("批次名称请填写1至100个字")
    if category not in CATEGORIES:
        raise ValueError("请选择校招、社招、内聘或未分类")
    batch_id = f"TLB-{uuid4().hex[:12].upper()}"
    with connect(db_path) as conn:
        conn.execute("INSERT INTO talent_batches(id,name,category,operator,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                     (batch_id, name, category, operator, now_iso(), now_iso()))
    record_audit("新建人员批次", AUDIT_OBJECT, batch_id, {}, {"批次名称": name, "分类": category}, operator, db_path)
    return batch_id


def update_batch(batch_id: str, name: str, category: str, operator: str, db_path=DB_PATH) -> dict:
    _require(operator, "create_task")
    before = get_batch(batch_id, db_path)
    name = str(name).strip()
    if not name or len(name) > 100:
        raise ValueError("批次名称请填写1至100个字")
    if category not in CATEGORIES:
        raise ValueError("请选择校招、社招、内聘或未分类")
    with connect(db_path) as conn:
        conn.execute("UPDATE talent_batches SET name=?,category=?,updated_at=? WHERE id=?", (name, category, now_iso(), batch_id))
    record_audit("修改人员批次", AUDIT_OBJECT, batch_id, {"批次名称": before["name"], "分类": before["category"]},
                 {"批次名称": name, "分类": category}, operator, db_path)
    return get_batch(batch_id, db_path)


def delete_batches(batch_ids: list[str], operator: str, db_path=DB_PATH) -> dict:
    """Delete selected library records atomically while retaining task-owned materials."""
    from matching_core.services.audit import _safe as audit_safe

    _require(operator, "delete_data")
    if isinstance(batch_ids, (str, bytes)):
        raise ValueError("请选择要删除的人员批次")
    selected = list(dict.fromkeys(batch_ids))
    if not selected or any(not isinstance(value, str) or not value for value in selected):
        raise ValueError("请选择要删除的人员批次")
    placeholders = ",".join("?" for _ in selected)
    fields = ("original_path", "redacted_path", "structured_path")
    files = set()
    retained = set()
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        batches = [dict(item) for item in conn.execute(f"SELECT * FROM talent_batches WHERE id IN ({placeholders})", selected)]
        if len(batches) != len(selected):
            raise ValueError("所选人员批次已不存在，本次未删除，请刷新后重新选择")
        busy_task = conn.execute(f"SELECT id FROM tasks WHERE talent_batch_id IN ({placeholders}) AND status IN ('待处理','处理中') LIMIT 1", selected).fetchone()
        if busy_task:
            raise ValueError("所选批次有关联匹配任务正在处理中，本次未删除，请等待完成后再删除")
        entries = [dict(item) for item in conn.execute(f"SELECT * FROM talent_entries WHERE batch_id IN ({placeholders})", selected)]
        if any(item["status"] == "待解析" for item in entries):
            raise ValueError("所选批次仍有简历正在解析，本次未删除，请等待完成后再删除")
        files = {Path(item[field]).resolve() for item in entries for field in fields if item[field]}
        conn.execute(f"DELETE FROM talent_entries WHERE batch_id IN ({placeholders})", selected)
        conn.execute(f"DELETE FROM talent_batches WHERE id IN ({placeholders})", selected)
        for table in ("candidates", "talent_entries"):
            retained.update(Path(item[field]).resolve() for item in conn.execute(f"SELECT {','.join(fields)} FROM {table}") for field in fields if item[field])
        retained.update(Path(item["path"]).resolve() for item in conn.execute("SELECT path FROM reports") if item["path"])
        for batch in batches:
            before = {"批次名称": batch["name"], "分类": batch["category"], "历史任务编号": batch["legacy_task_id"],
                      "人员数": sum(entry["batch_id"] == batch["id"] for entry in entries)}
            # The audit row is also a migration tombstone; commit it with the physical deletion.
            conn.execute("""INSERT INTO audits(operation_time,operation_type,object_type,object_id,before_json,after_json,operator)
                VALUES(?,?,?,?,?,?,?)""", (now_iso(), "删除人员批次", AUDIT_OBJECT, batch["id"], audit_safe(before),
                audit_safe({"状态": "已删除", "关联匹配任务及报告": "保留"}), operator))
    allowed_root = _root(db_path).resolve()
    for path in files - retained:
        # Never recursively remove directories, follow paths outside the library, or touch shared task files.
        try:
            if path.is_relative_to(allowed_root) and path != allowed_root and path.is_file():
                path.unlink()
        except OSError:
            pass
    return {"deleted_batches": len(batches), "deleted_entries": len(entries)}


def _set_failure(entry_id: str, message: str, db_path) -> dict:
    # Parser errors may contain machine paths or service configuration; retain a safe explanation.
    from matching_core.services.batch_reports import _safe_text
    message = _safe_text(message)[:1000] or "文件解析失败，请检查文件后重试"
    with connect(db_path) as conn:
        conn.execute("UPDATE talent_entries SET status='解析失败',parse_status='无法可靠解析，请人工确认',error_message=?,updated_at=? WHERE id=?",
                     (message, now_iso(), entry_id))
    return get_entry(entry_id, db_path)


def _minutes_file(entry_dir: Path) -> Path | None:
    """随简历一并导入的面试纪要或补充材料（每人至多一份），保存在人员目录的 minutes 子目录。"""
    folder = entry_dir / "minutes"
    files = sorted(item for item in folder.iterdir() if item.is_file()) if folder.is_dir() else []
    return files[0] if files else None


def _parse_entry(entry_id: str, operator: str, db_path, allow_ocr=False) -> dict:
    entry = get_entry(entry_id, db_path)
    original = Path(entry["original_path"])
    if not entry["original_path"] or not original.is_file():
        raise ValueError("原始简历文件缺失，请重新导入该文件")
    if original.suffix.lower() not in {".pdf", ".docx", ".txt"}:
        raise ValueError("仅支持 PDF、DOCX 和 TXT 简历")
    if original.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("单个简历文件不能超过50MB")
    minutes = _minutes_file(original.parent.parent)
    parsed, privacy, redacted = (parse_material(original, minutes, allow_ocr=allow_ocr) if minutes
                                 else parse_material(original, allow_ocr=allow_ocr))
    if not redacted.strip() or not parsed.get("raw_evidence"):
        raise ValueError(parsed.get("warning") or parsed.get("parse_status") or "未读取到有效简历内容")
    parsed = enrich_candidate(parsed)
    if contains_unmasked_sensitive(redacted):
        raise ValueError("脱敏处理未完成，请重试")
    if not parsed.get("candidate_code") or parsed["candidate_code"] == "待人工确认":
        parsed["candidate_code"] = entry_id
    target = _root(db_path) / entry["batch_id"] / entry_id
    target.mkdir(parents=True, exist_ok=True)
    redacted_path, structured_path = target / "redacted.txt", target / "profile.json"
    redacted_path.write_text(redacted, encoding="utf-8")
    structured_path.write_text(json.dumps({"parsed": parsed, "privacy": privacy}, ensure_ascii=False, indent=2), encoding="utf-8")
    with connect(db_path) as conn:
        conn.execute("""UPDATE talent_entries SET full_name=?,masked_name=?,redacted_path=?,structured_path=?,
            sensitive_detected=?,sensitive_types_json=?,redaction_status=?,parse_status=?,status='已解析',
            error_message='',parsed_json=?,updated_at=? WHERE id=?""",
            (parsed.get("full_name", "待人工确认"), parsed.get("masked_name", "待人工确认"), str(redacted_path), str(structured_path),
             int(bool(privacy.get("detected"))), json.dumps(privacy.get("types", []), ensure_ascii=False),
             "已脱敏" if privacy.get("detected") else "未检测到敏感信息", parsed.get("parse_status", "待人工确认"),
             json.dumps(parsed, ensure_ascii=False), now_iso(), entry_id))
    record_audit("解析人员资料", AUDIT_OBJECT, entry_id, {}, {"人员批次": entry["batch_id"], "状态": "已解析", "已确认OCR": allow_ocr}, operator, db_path)
    return get_entry(entry_id, db_path)


def import_files(batch_id: str, paths: list[str | Path], operator: str, db_path=DB_PATH, allow_ocr=False,
                 minutes_map: dict[str, str | Path] | None = None, progress=None) -> dict:
    """导入简历并解析。minutes_map 以简历路径为键，值为该人员的面试纪要或补充材料文件。"""
    _require(operator, "create_task")
    if isinstance(paths, (str, bytes, Path)):
        raise ValueError("请以文件列表导入简历")
    minutes_map = {str(Path(key)): Path(value) for key, value in (minutes_map or {}).items()}
    staged = [(source, f"TLE-{uuid4().hex[:12].upper()}", _filename(str(source))) for source in paths]
    # Reserve every pending entry atomically. Between files, deletion still sees the remaining pending work.
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT id FROM talent_batches WHERE id=?", (batch_id,)).fetchone():
            raise KeyError("人员批次不存在")
        conn.executemany("INSERT INTO talent_entries(id,batch_id,source_filename,created_at,updated_at) VALUES(?,?,?,?,?)",
                         [(entry_id, batch_id, filename, now_iso(), now_iso()) for _, entry_id, filename in staged])
    result = {"imported": [], "failed": []}
    for index, (source, entry_id, filename) in enumerate(staged, start=1):
        if progress:
            progress(f"正在解析第 {index}/{len(staged)} 份：{filename}")
        try:
            source = Path(source)
            if not source.is_file():
                raise ValueError("上传文件不存在，请重新上传")
            target = _root(db_path) / batch_id / entry_id / "original" / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            minutes = minutes_map.get(str(source))
            if minutes and minutes.is_file():
                minutes_target = target.parent.parent / "minutes" / _filename(minutes.name)
                minutes_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(minutes, minutes_target)
            with connect(db_path) as conn:
                conn.execute("UPDATE talent_entries SET original_path=? WHERE id=?", (str(target), entry_id))
            result["imported"].append(_parse_entry(entry_id, operator, db_path, allow_ocr))
        except Exception as exc:
            result["failed"].append(_set_failure(entry_id, str(exc), db_path))
    with connect(db_path) as conn:
        conn.execute("UPDATE talent_batches SET updated_at=? WHERE id=?", (now_iso(), batch_id))
    record_audit("导入人员资料", AUDIT_OBJECT, batch_id, {},
                 {"成功人数": len(result["imported"]), "失败人数": len(result["failed"]), "文件名": [item["source_filename"] for key in result for item in result[key]]}, operator, db_path)
    return result


def retry_entry(entry_id: str, operator: str, db_path=DB_PATH, allow_ocr=False) -> dict:
    _require(operator, "create_task")
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        stored = conn.execute("SELECT * FROM talent_entries WHERE id=?", (entry_id,)).fetchone()
        if not stored:
            raise KeyError("人员资料不存在")
        entry = _decode(dict(stored))
        if entry["status"] == "待解析":
            raise ValueError("这份简历正在解析，请等待完成")
        if entry["material_version"] or entry["parsed"].get("manual_confirmed"):
            raise ValueError("这份简历已有人工修改或确认，请在资料编辑区继续修改，不能用重新解析覆盖")
        conn.execute("UPDATE talent_entries SET status='待解析',updated_at=? WHERE id=?", (now_iso(), entry_id))
    try:
        return _parse_entry(entry_id, operator, db_path, allow_ocr)
    except Exception as exc:
        return _set_failure(entry_id, str(exc), db_path)


def _selection(batch_id: str, ids, operator: str, db_path) -> tuple[dict, list[dict]]:
    _require(operator, "export_report")
    batch = get_batch(batch_id, db_path)
    if isinstance(ids, (str, bytes)):
        raise ValueError("请选择当前人员批次的人员")
    selected = list(dict.fromkeys(ids))
    entries = {item["id"]: item for item in list_entries(batch_id, db_path)}
    if not selected or any(entry_id not in entries for entry_id in selected):
        raise ValueError("请选择当前人员批次的人员，不能混选其他批次")
    return batch, [entries[entry_id] for entry_id in selected]


def _export_path(batch: dict, label: str, extension: str, db_path) -> Path:
    target = _root(db_path) / "exports"
    target.mkdir(parents=True, exist_ok=True)
    return target / f"{_filename(batch['name'])[:70]}_{label}_{uuid4().hex[:10]}.{extension}"


def _entry_file(entry: dict) -> Path:
    source = Path(entry.get("original_path") or "")
    if not entry.get("original_path") or not source.is_file():
        raise ValueError(f"{entry['source_filename']}的原始文件缺失，请重新导入后导出")
    return source


def export_resumes(batch_id: str, ids, operator: str, db_path=DB_PATH) -> Path:
    batch, entries = _selection(batch_id, ids, operator, db_path)
    sources = [_entry_file(entry) for entry in entries]
    if len(entries) == 1:
        path = _export_path(batch, _filename(entries[0]["source_filename"]).rsplit(".", 1)[0], sources[0].suffix.lstrip("."), db_path)
        shutil.copy2(sources[0], path)
    else:
        path = _export_path(batch, "简历原件", "zip", db_path)
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            for entry, source in zip(entries, sources):
                archive.write(source, f"{entry['id']}_{_filename(entry['source_filename'])}")
    record_audit("导出人员简历", AUDIT_OBJECT, batch_id, {}, {"人员编号": [e["id"] for e in entries], "导出文件名": path.name}, operator, db_path)
    return path


def _profile_doc(entry: dict, batch: dict, path: Path) -> None:
    from matching_core.services.batch_reports import _safe_text
    from matching_core.services.report import _add_heading, _new_document, _paragraph, _table
    document = _new_document("人员简历资料报告")
    _table(document, ["资料项", "内容"], [
        ["姓名", _safe_text(entry["full_name"])], ["人员编号", entry["id"]],
        ["人员批次", _safe_text(batch["name"])], ["人员分类", batch["category"]],
        ["原始简历", _safe_text(entry["source_filename"])], ["解析状态", entry["parse_status"]],
    ], [1.25, 5.65])
    _paragraph(document, "本报告汇总简历中已提取的事实资料，缺失信息保留为待确认；岗位匹配和录用结论请查看对应匹配任务报告。", secondary=True)
    if entry["status"] != "已解析":
        _paragraph(document, "解析未完成：" + _safe_text(entry["error_message"] or "请重新解析材料"))
    else:
        labels = {"education": "教育经历", "work_experience": "工作经历", "project_experience": "项目经历", "skills": "技能", "certificates": "证书", "achievements": "成果", "management_experience": "管理经历"}
        fields = entry["parsed"].get("fields", {})
        _add_heading(document, "简历信息")
        records = []
        for name, field in fields.items():
            field = field if isinstance(field, dict) else {"value": field}
            records.append([_safe_text(field.get("label") or labels.get(name, name)), _safe_text(field.get("value") or "待确认"), _safe_text(field.get("status") or "待确认")])
        if records:
            _table(document, ["项目", "提取内容", "状态"], records, [1.15, 4.65, 1.1])
        else:
            _paragraph(document, "暂无已提取字段，请核对原始简历。")
        from matching_core.services.material_review import effective_material_evidence
        evidence = effective_material_evidence(entry["parsed"])
        if evidence:
            _add_heading(document, "简历原文摘要与出处")
            if len(evidence) > 30:
                _paragraph(document, f"共提取{len(evidence)}段原文，以下展示前30段；完整内容请查看随人员资料保存的原始简历。", secondary=True)
            for item in evidence[:30]:
                if isinstance(item, dict) and item.get("text"):
                    _paragraph(document, _safe_text(item["text"]))
                    _paragraph(document, "出处：" + _safe_text(item.get("file", entry["source_filename"])) + " · " + _safe_text(item.get("location", "")), secondary=True)
    document.save(path)


def export_profiles(batch_id: str, ids, operator: str, db_path=DB_PATH) -> Path:
    from tempfile import TemporaryDirectory
    batch, entries = _selection(batch_id, ids, operator, db_path)
    if len(entries) == 1:
        path = _export_path(batch, f"{_filename(entries[0]['full_name'])}_简历资料报告", "docx", db_path)
        _profile_doc(entries[0], batch, path)
    else:
        path = _export_path(batch, "简历资料报告", "zip", db_path)
        with TemporaryDirectory(prefix="talent-profiles-") as temp, ZipFile(path, "w", ZIP_DEFLATED) as archive:
            for entry in entries:
                filename = f"{_filename(entry['full_name'])}_{entry['id']}_简历资料报告.docx"
                generated = Path(temp) / filename
                _profile_doc(entry, batch, generated)
                archive.write(generated, filename)
    record_audit("导出人员资料报告", AUDIT_OBJECT, batch_id, {}, {"人员编号": [e["id"] for e in entries], "导出文件名": path.name}, operator, db_path)
    return path


def ensure_legacy_talent(db_path=DB_PATH) -> dict:
    """Copy only original historical candidates locally, without parsing or model calls."""
    imported = {"batches": 0, "entries": 0}
    legacy = rows("""SELECT c.*,t.batch_name,t.created_at AS task_created_at,j.name AS job_name
        FROM candidates c JOIN tasks t ON t.id=c.task_id JOIN jobs j ON j.id=t.job_id
        WHERE COALESCE(c.source_candidate_id,'')=''
          AND NOT EXISTS(SELECT 1 FROM talent_entries e WHERE e.legacy_candidate_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM audits a WHERE a.operation_type IN ('删除人才批次','删除人员批次')
              AND a.object_type IN ('人才库','人员库')
              AND json_extract(a.before_json,'$.历史任务编号')=c.task_id)
        ORDER BY c.created_at,c.id""", db_path=db_path)
    for item in legacy:
        task_id = item["task_id"]
        existing = row("SELECT id FROM talent_batches WHERE legacy_task_id=?", (task_id,), db_path)
        batch_id = existing["id"] if existing else "TLB-LEG-" + hashlib.sha256(task_id.encode()).hexdigest()[:12].upper()
        if not existing:
            created_label = item["task_created_at"][:16].replace("T", " ")
            name = item["batch_name"] or f"{created_label} · {item['job_name']} · 历史导入"
            with connect(db_path) as conn:
                inserted = conn.execute("""INSERT OR IGNORE INTO talent_batches(id,name,category,operator,legacy_task_id,created_at,updated_at)
                    VALUES(?,?,'未分类','历史资料迁移',?,?,?)""", (batch_id, name[:100], task_id, item["task_created_at"], now_iso())).rowcount
                imported["batches"] += inserted
        entry_id = "TLE-LEG-" + hashlib.sha256(item["id"].encode()).hexdigest()[:16].upper()
        target = _root(db_path) / batch_id / entry_id
        target.mkdir(parents=True, exist_ok=True)
        copied = {}
        copy_errors = []
        for field, child in (("original_path", "original"), ("redacted_path", "redacted"), ("structured_path", "structured")):
            source = Path(item[field]) if item.get(field) else None
            copied[field] = ""
            if source and source.is_file():
                destination = target / child / _filename(source.name)
                try:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
                    copied[field] = str(destination)
                except OSError:
                    copy_errors.append("历史材料暂无法读取，请核对原件后重新导入")
        parsed = json.loads(item.get("parsed_json") or "{}")
        has_redacted_text = False
        if copied["redacted_path"]:
            try:
                has_redacted_text = bool(Path(copied["redacted_path"]).read_text(encoding="utf-8").strip())
            except (OSError, UnicodeError):
                pass
        valid = bool(parsed.get("raw_evidence")) and has_redacted_text
        error = "" if valid else "历史资料缺少有效脱敏正文或解析证据，请重试解析"
        if not copied["original_path"]:
            error = "历史原始简历文件缺失；已保留现有解析资料，请重新导入原件"
        elif copy_errors:
            error = copy_errors[0]
        with connect(db_path) as conn:
            inserted = conn.execute("""INSERT OR IGNORE INTO talent_entries(
                id,batch_id,legacy_candidate_id,full_name,masked_name,source_filename,original_path,redacted_path,structured_path,
                sensitive_detected,sensitive_types_json,redaction_status,parse_status,status,error_message,parsed_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (entry_id, batch_id, item["id"], item.get("full_name", ""), item["masked_name"], item["source_filename"],
                 copied["original_path"], copied["redacted_path"], copied["structured_path"], item["sensitive_detected"],
                 item["sensitive_types_json"], item["redaction_status"], item["parse_status"], "已解析" if valid else "解析失败",
                 error, item["parsed_json"], item["created_at"], now_iso())).rowcount
            conn.execute("UPDATE tasks SET talent_batch_id=? WHERE id=? AND talent_batch_id=''", (batch_id, task_id))
            imported["entries"] += inserted
    return imported
