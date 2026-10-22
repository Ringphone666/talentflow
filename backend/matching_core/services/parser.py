from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import fitz
from docx import Document

from matching_core.services.privacy import mask_name, redact_sensitive
from matching_core.services.ocr import recognize_pdf, ocr_settings, OCRError
from matching_core.services.upload_detection import MAX_PDF_BYTES, inspect_pdf_pages


FIELD_MAP = {
    "教育经历": "education",
    "工作经历": "work_experience",
    "项目经历": "projects",
    "专业技能": "skills",
    "任职时间": "tenure",
    "面试评价": "interview_evaluation",
}


def _clean_list_item(value: str) -> str:
    """Normalize a JD bullet without changing the actual requirement text."""
    value = re.sub(r"^\s*(?:[-*•·▪◦]|\d+[.、)]|[一二三四五六七八九十]+[、.)])\s*", "", value)
    return re.sub(r"\s+", " ", value).strip(" ;；")


def parse_job_description(path: str | Path, existing_job: dict | None = None, allow_ocr: bool = False) -> dict:
    """Parse a lightweight, reviewable job description configuration.

    The parser intentionally keeps the source text and only maps explicit section
    headings. It does not invent a competency model; dimensions fall back to the
    selected job's existing model when the JD does not define them.
    """
    path = Path(path)
    document = extract_minutes(path, allow_ocr=allow_ocr)
    text = document.text.strip()
    if not text:
        raise ValueError(document.warning or "岗位说明书没有可提取文字")

    sections: dict[str, list[str]] = {}
    current = "正文"
    sections[current] = []
    heading_map = {
        "岗位职责": "responsibilities", "工作职责": "responsibilities", "主要职责": "responsibilities",
        "任职要求": "requirements", "岗位要求": "requirements", "任职资格": "requirements",
        "硬性条件": "hard_conditions", "硬性要求": "hard_conditions",
        "能力维度": "dimensions", "胜任力维度": "dimensions",
    }
    metadata: dict[str, str] = {}
    metadata_map = {"岗位名称": "name", "岗位类别": "sequence", "岗位序列": "sequence", "职能序列": "sequence", "职级": "level", "JD版本": "jd_version", "版本": "jd_version"}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        meta = re.match(r"^(岗位名称|岗位类别|岗位序列|职能序列|职级|JD版本|版本)\s*[:：]\s*(.+)$", line, re.I)
        if meta:
            metadata[metadata_map[meta.group(1)]] = meta.group(2).strip()
            continue
        heading = re.sub(r"[：:]\s*$", "", line)
        if heading in heading_map:
            current = heading_map[heading]
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(_clean_list_item(line))

    def items(key: str) -> list[str]:
        return [item for item in sections.get(key, []) if item and item not in {"正文", "岗位职责", "任职要求"}]

    responsibilities = items("responsibilities")
    requirements = items("requirements")
    hard_conditions = items("hard_conditions")
    if not requirements:
        # A short JD often has no explicit heading. Keep the text reviewable and
        # use non-responsibility lines as requirements rather than dropping them.
        requirements = [item for item in sections.get("正文", []) if item]
    if not responsibilities:
        responsibilities = [item for item in sections.get("正文", []) if item and any(token in item for token in ("负责", "参与", "协同", "推进", "维护"))]
    if not hard_conditions:
        hard_conditions = [item for item in requirements if re.search(r"(必须|至少|年以上|本科|硕士|博士|证书|资格|持有)", item)]
    explicit_dimensions = items("dimensions")
    dimensions = []
    if existing_job:
        dimensions = [dict(item) for item in existing_job.get("dimensions", [])]
    if explicit_dimensions:
        dimensions = [{"name": item, "keywords": [item]} for item in explicit_dimensions]

    return {
        "source_file": path.name,
        "status": document.status,
        "warning": document.warning,
        "metadata": metadata,
        "responsibilities": responsibilities,
        "requirements": requirements,
        "hard_conditions": hard_conditions,
        "dimensions": dimensions,
        "source_text": text,
    }


@dataclass
class ExtractedDocument:
    text: str
    evidence: list[dict]
    status: str
    warning: str = ""
    ocr: dict = field(default_factory=dict)


def extract_pdf(path: str | Path, allow_ocr: bool = False) -> ExtractedDocument:
    path = Path(path)
    try:
        if path.stat().st_size > MAX_PDF_BYTES:
            return ExtractedDocument("", [], "无法可靠解析，请人工确认", "PDF超过单文件50MB容量上限，请压缩后处理")
        with fitz.open(path) as doc:
            inspection = inspect_pdf_pages(doc)
    except ValueError as exc:
        return ExtractedDocument("", [], "无法可靠解析，请人工确认", str(exc))
    except Exception as exc:
        return ExtractedDocument("", [], "无法可靠解析，请人工确认", f"PDF无法打开：{type(exc).__name__}")
    page_texts = dict(inspection["texts"])
    scan_pages = inspection["scan_pages"]
    info = {}
    warning = ""
    ocr_pages = set()
    if scan_pages and allow_ocr:
        try:
            texts, info = recognize_pdf(path, consent=True, page_numbers=scan_pages)
            if len(texts) != len(scan_pages) or info.get("page_numbers", scan_pages) != scan_pages:
                raise OCRError("OCR返回页数或页码与待识别页面不一致，请人工确认")
            if any(not isinstance(text, str) or not text.strip() for text in texts):
                raise OCRError("OCR未返回完整有效文字，请人工确认")
            for page_no, text in zip(scan_pages, texts):
                page_texts[page_no] = re.sub(r"(?m)^\s*#{1,6}\s*", "", text)
            ocr_pages = set(scan_pages)
            info = {**info, "page_numbers": scan_pages, "local_text_pages": sorted(inspection["texts"]),
                    "blank_pages": inspection["blank_pages"], "source_pages": inspection["page_count"]}
        except OCRError as exc:
            warning = str(exc)
            info = {"service": "paddle-chat-ocr" if ocr_settings().get("provider") == "paddle_chat" else "document-ocr",
                    "status": "未成功", "reason": warning, "page_numbers": scan_pages}
    elif scan_pages:
        warning = "第" + "、".join(map(str, scan_pages)) + "页为扫描版或图片版页面；未授权OCR外发"

    evidence = []
    for page_no in sorted(page_texts):
        text = page_texts[page_no]
        if page_no in ocr_pages:
            for line_no, line in enumerate(text.splitlines(), 1):
                if line.strip():
                    evidence.append({"file": path.name, "location": f"第{page_no}页·OCR第{line_no}行", "text": line.strip()})
        else:
            for line_no, line in enumerate(text.splitlines(), 1):
                if line.strip():
                    evidence.append({"file": path.name, "location": f"第{page_no}页·第{line_no}行", "text": line.strip()})
    text = "\n".join(page_texts[n] for n in sorted(page_texts))
    if not text:
        return ExtractedDocument("", [], "无法可靠解析，请人工确认", warning or "PDF仅有空白页，没有可提取内容", ocr=info)
    status = "部分页面无法可靠解析，请人工确认" if warning else "OCR辅助解析，待人工确认" if ocr_pages else "解析成功"
    return ExtractedDocument(text, evidence, status, warning, info)


def extract_minutes(path: str | Path, allow_ocr: bool = False) -> ExtractedDocument:
    path = Path(path)
    try:
        if path.suffix.lower() == ".pdf":
            return extract_pdf(path, allow_ocr=allow_ocr)
        if path.suffix.lower() == ".docx":
            doc = Document(path)
            from docx.text.paragraph import Paragraph
            from docx.table import Table

            def blocks(parent):
                for block in parent.iter_inner_content():
                    if isinstance(block, Paragraph) and block.text.strip():
                        yield block.text.strip()
                    elif isinstance(block, Table):
                        for row in block.rows:
                            seen = set()
                            cells = []
                            for cell in row.cells:
                                if cell._tc in seen:
                                    continue
                                seen.add(cell._tc)
                                cells.append("\n".join(blocks(cell)))
                            yield " | ".join(cells)

            parts = list(blocks(doc))
            text = "\n".join(parts)
            return ExtractedDocument(text, [{"file": path.name, "location": "段落1起", "text": text}], "解析成功" if text else "无法可靠解析，请人工确认")
        text = path.read_text(encoding="utf-8")
        return ExtractedDocument(text, [{"file": path.name, "location": "文本第1行起", "text": text}], "解析成功" if text.strip() else "无法可靠解析，请人工确认")
    except Exception as exc:
        return ExtractedDocument("", [], "无法可靠解析，请人工确认", f"材料无法读取：{type(exc).__name__}")


def _field_value(text: str, label: str) -> tuple[str, str]:
    pattern = re.compile(rf"^{re.escape(label)}\s*[:：]\s*(.*)$", re.MULTILINE)
    match = pattern.search(text)
    if not match or not match.group(1).strip():
        return "待人工确认", "待人工确认"
    return match.group(1).strip(), "已识别"


def _field_location(text: str, label: str) -> str:
    pattern = re.compile(rf"^{re.escape(label)}\s*[:：]")
    for line_number, line in enumerate(text.splitlines(), 1):
        if pattern.match(line.strip()):
            return f"第{line_number}行"
    return "未定位到相关证据"


def build_line_evidence(
    resume_text: str,
    resume_file: str,
    minutes_text: str = "",
    minutes_file: str = "",
) -> list[dict]:
    evidence: list[dict] = []
    sources = [(resume_text, resume_file)]
    if minutes_text and minutes_file:
        sources.append((minutes_text, minutes_file))
    for source_text, source_file in sources:
        for line_number, line in enumerate(source_text.splitlines(), 1):
            if line.strip():
                evidence.append({
                    "text": line.strip(),
                    "file": source_file,
                    "location": f"第{line_number}行",
                })
    return evidence


def parse_candidate(redacted_text: str, filename: str, minutes_text: str = "", minutes_file: str = "") -> dict:
    code, code_status = _field_value(redacted_text, "候选人编号")
    raw_name, name_status = _field_value(redacted_text, "姓名")
    result = {
        "candidate_code": code,
        "full_name": raw_name,
        "masked_name": mask_name(raw_name),
        "fields": {},
        "source_file": filename,
        "raw_evidence": [],
        "parse_status": "解析成功",
    }
    for label, key in FIELD_MAP.items():
        source_text = minutes_text if label == "面试评价" and minutes_text else redacted_text
        value, status = _field_value(source_text, label)
        source_file = minutes_file if label == "面试评价" and minutes_text else filename
        location = _field_location(source_text, label) if status == "已识别" else "未定位到相关证据"
        result["fields"][key] = {
            "label": label,
            "value": value,
            "status": status,
            "evidence": value if status == "已识别" else "无充分证据",
            "source_file": source_file,
            "location": location,
        }
    if code_status != "已识别" or name_status != "已识别" or any(v["status"] != "已识别" for v in result["fields"].values()):
        result["parse_status"] = "部分字段待人工确认"
    conflict = "证据冲突" in redacted_text or "冲突" in minutes_text
    if conflict:
        result["parse_status"] = "存在证据冲突，待人工确认"
        result["conflict"] = True
    else:
        result["conflict"] = False
    result["raw_evidence"] = build_line_evidence(redacted_text, filename, minutes_text, minutes_file)
    return result


def parse_material(resume_path: str | Path, minutes_path: str | Path | None = None, allow_ocr: bool = False) -> tuple[dict, dict, str]:
    resume = extract_minutes(resume_path, allow_ocr=allow_ocr)
    if not resume.text:
        parsed = parse_candidate("", Path(resume_path).name)
        parsed["parse_status"] = resume.status
        parsed["warning"] = resume.warning
        parsed["ocr_analysis"] = resume.ocr or {"status": "未调用", "reason": "未授权OCR或PDF不可读取"}
        return parsed, {"detected": False, "types": [], "counts": {}}, ""
    resume_redaction = redact_sensitive(resume.text)
    minutes_text = ""
    minutes_name = ""
    minutes_types: list[str] = []
    minute_counts = {"手机号": 0, "身份证号": 0}
    minutes = None
    if minutes_path:
        minutes = extract_minutes(minutes_path, allow_ocr=allow_ocr)
        minutes_name = Path(minutes_path).name
        minutes_redaction = redact_sensitive(minutes.text)
        minutes_text = minutes_redaction.text
        minutes_types = minutes_redaction.types
        minute_counts = minutes_redaction.counts
    parsed = parse_candidate(resume_redaction.text, Path(resume_path).name, minutes_text, minutes_name)
    parsed["ocr_analysis"] = resume.ocr or {"status": "本地文本解析", "reason": "文字材料无需OCR"}
    if minutes:
        parsed["minutes_ocr_analysis"] = minutes.ocr
    for document, filename in ((resume, Path(resume_path).name), (minutes, minutes_name)):
        if not document:
            continue
        if document.warning:
            parsed["warning"] = document.warning
            parsed["parse_status"] = "材料部分无法可靠解析，请人工确认"
        if document.evidence and Path(filename).suffix.lower() == ".pdf":
            safe_evidence = [{**e, "text": redact_sensitive(e["text"]).text} for e in document.evidence]
            parsed["raw_evidence"] = [e for e in parsed["raw_evidence"] if e["file"] != filename] + safe_evidence
            for item in parsed["fields"].values():
                if item["source_file"] == filename:
                    hit = next((e for e in safe_evidence if item["value"] in e["text"]), None)
                    item["location"] = hit["location"] if hit else "未定位，待人工确认"
                    if hit and "·OCR第" in hit["location"]:
                        item["status"] = "OCR提取，待人工确认"
        if document.ocr.get("status") == "调用成功" and not parsed.get("warning"):
            parsed["parse_status"] = "OCR辅助解析，待人工确认"
    types = list(dict.fromkeys(resume_redaction.types + minutes_types))
    info = {
        "detected": bool(types),
        "types": types,
        "counts": {k: resume_redaction.counts.get(k, 0) + minute_counts.get(k, 0) for k in ("手机号", "身份证号")},
    }
    combined_redacted = resume_redaction.text + ("\n\n【面试会议纪要】\n" + minutes_text if minutes_text else "")
    return parsed, info, combined_redacted
