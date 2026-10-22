"""Read-only local PDF preflight, shared by upload validation and parsing."""
from __future__ import annotations

import fitz


# Bound local resource use separately from the size of an individual OCR request.
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_OCR_REQUEST_BYTES = 10 * 1024 * 1024


def page_has_visible_content(page) -> bool:
    """Distinguish empty/white pages from images and outlined text locally."""
    scale = min(1.0, 1000 / max(page.rect.width, page.rect.height))
    pixels = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False,
    ).samples
    # Rendering handles blank full-page images and white background drawings.
    # Keep small/sparse marks; only near-white pixels are ignored.
    return bool(pixels) and min(pixels) < 245


def inspect_pdf_pages(doc) -> dict:
    """Return local text and 1-based page classifications without external IO."""
    if doc.needs_pass:
        raise ValueError("PDF已加密，请解密后重新上传。")
    if not len(doc):
        raise ValueError("PDF没有页面。")
    texts, scan_pages, blank_pages = {}, [], []
    for page_no, page in enumerate(doc, 1):
        text = page.get_text("text").strip()
        if text:
            texts[page_no] = text
        elif page_has_visible_content(page):
            scan_pages.append(page_no)
        else:
            blank_pages.append(page_no)
    return {"texts": texts, "scan_pages": scan_pages, "blank_pages": blank_pages, "page_count": len(doc)}


def preflight_uploaded_pdfs(files):
    """Return (ready uploads, consent rows, errors), excluding only invalid files.

    Non-PDF companion materials pass through unchanged. Ready uploads are the
    original objects, so callers do not have to match potentially duplicate names.
    """
    ready, scans, errors = [], [], []
    for upload in files:
        if not upload.name.lower().endswith(".pdf"):
            ready.append(upload)
            continue
        try:
            data = upload.getvalue()
            if len(data) > MAX_PDF_BYTES:
                raise ValueError("PDF超过单文件50MB容量上限，请压缩后重新上传。")
            with fitz.open(stream=data, filetype="pdf") as doc:
                result = inspect_pdf_pages(doc)
            if not result["texts"] and not result["scan_pages"]:
                raise ValueError("PDF仅有空白页，没有可用于分析的内容。")
            ready.append(upload)
            if result["scan_pages"]:
                scans.append({
                    "文件": upload.name,
                    "需识别的页码": "、".join(map(str, result["scan_pages"])),
                    "总页数": result["page_count"],
                    "本地文字页数": len(result["texts"]),
                    "跳过空白页数": len(result["blank_pages"]),
                })
        except ValueError as exc:
            errors.append(f"{upload.name}：{exc}")
        except Exception:
            errors.append(f"{upload.name}：无法可靠解析，请检查文件或人工确认。")
    return ready, scans, errors


def detect_uploaded_pdfs(files):
    """Compatibility wrapper for callers needing only consent rows and errors."""
    _, scans, errors = preflight_uploaded_pdfs(files)
    return scans, errors
