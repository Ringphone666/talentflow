"""上传文件的校验与暂存，人员库导入和匹配任务共用。"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from matching_core.config import DATA_DIR as MATCHING_DATA_DIR
from matching_core.services import upload_detection

STAGING_DIR = MATCHING_DATA_DIR / "uploads" / "staging"
RESUME_TYPES = {".pdf", ".docx", ".txt"}
MAX_FILE_BYTES = 50 * 1024 * 1024


class MemoryFile:
    """upload_detection 只需要文件名和内容。"""

    def __init__(self, name: str, data: bytes):
        self.name = name
        self._data = data

    def getvalue(self) -> bytes:
        return self._data


def safe_name(name: str, fallback: str = "未命名文件") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(str(name or "").replace("\\", "/")).name).strip(" .")
    return cleaned[-160:] or fallback


def unique_names(names: list[str]) -> list[str]:
    """同一批内文件名和主文件名都不能重复：同名文件依次追加 _2、_3。"""
    used_names: set[str] = set()
    used_stems: set[str] = set()
    result = []
    for name in names:
        path = Path(safe_name(name))
        stem, suffix, index = path.stem, path.suffix, 1
        candidate = path.name
        while candidate.lower() in used_names or Path(candidate).stem.lower() in used_stems:
            index += 1
            candidate = f"{stem}_{index}{suffix}"
        used_names.add(candidate.lower())
        used_stems.add(Path(candidate).stem.lower())
        result.append(candidate)
    return result


async def read_uploads(files: list[UploadFile], *, label: str = "简历") -> list[MemoryFile]:
    loaded = []
    for upload in files:
        name = safe_name(upload.filename or "")
        if Path(name).suffix.lower() not in RESUME_TYPES:
            raise HTTPException(422, f"{name}：{label}仅支持 PDF、Word（.docx）和 TXT 文件")
        data = await upload.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, f"{name}：超过单文件 50MB 上限，请压缩后重新上传")
        if not data:
            raise HTTPException(422, f"{name}：文件内容为空")
        loaded.append(MemoryFile(name, data))
    return loaded


def scan_report(files: list[MemoryFile]) -> dict:
    """识别需要文字识别的扫描页。扫描页图片会发送到外部识别服务，必须先取得授权。"""
    _, scans, errors = upload_detection.preflight_uploaded_pdfs(files)
    return {
        "scans": [{"file": item["文件"], "pages": item["需识别的页码"], "page_count": item["总页数"],
                   "text_pages": item["本地文字页数"], "blank_pages": item["跳过空白页数"]} for item in scans],
        "errors": errors,
    }


def parse_assignments(raw: str) -> dict[str, str]:
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(422, "纪要对应关系格式不正确") from None
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        raise HTTPException(422, "纪要对应关系格式不正确")
    return value


def pair_minutes(resumes: list[str], minutes: list[str], assignments: dict[str, str]) -> dict[str, str]:
    """返回 {简历文件名: 纪要文件名}。未指定时按“简历文件名_面试纪要”自动对应。"""
    available = set(minutes)
    result: dict[str, str] = {}
    for resume, minute in assignments.items():
        if resume in resumes and minute in available:
            result[resume] = minute
    used = set(result.values())
    for resume in resumes:
        if resume in result:
            continue
        stem = Path(resume).stem
        matches = [name for name in minutes if name not in used and Path(name).stem.startswith(stem + "_")]
        if len(matches) == 1:
            result[resume] = matches[0]
            used.add(matches[0])
    return result


def stage(resumes: list[MemoryFile], minutes: list[MemoryFile], assignments: dict[str, str]) -> tuple[Path, list[Path], dict[str, Path]]:
    """把上传内容写入暂存目录，返回（暂存目录、简历路径、{简历路径: 纪要路径}）。"""
    folder = STAGING_DIR / uuid.uuid4().hex
    (folder / "resumes").mkdir(parents=True, exist_ok=True)
    resume_names = unique_names([item.name for item in resumes])
    minute_names = unique_names([item.name for item in minutes])
    original_to_stored = {item.name: stored for item, stored in zip(resumes, resume_names)}
    minutes_original = {item.name: stored for item, stored in zip(minutes, minute_names)}
    stored_assignments = {original_to_stored[resume]: minutes_original[minute]
                          for resume, minute in assignments.items()
                          if resume in original_to_stored and minute in minutes_original}
    pairs = pair_minutes(resume_names, minute_names, stored_assignments)
    resume_paths = []
    for item, name in zip(resumes, resume_names):
        path = folder / "resumes" / name
        path.write_bytes(item.getvalue())
        resume_paths.append(path)
    minute_paths = {}
    if minutes:
        (folder / "minutes").mkdir(parents=True, exist_ok=True)
        for item, name in zip(minutes, minute_names):
            path = folder / "minutes" / name
            path.write_bytes(item.getvalue())
            minute_paths[name] = path
    minutes_map = {str(folder / "resumes" / resume): minute_paths[minute] for resume, minute in pairs.items()}
    return folder, resume_paths, minutes_map


def discard(folder: Path) -> None:
    """导入完成后原件已复制进人员库，暂存内容不再保留。"""
    try:
        if folder.resolve().is_relative_to(STAGING_DIR.resolve()):
            shutil.rmtree(folder, ignore_errors=True)
    except OSError:
        pass
