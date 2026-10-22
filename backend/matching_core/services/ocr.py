"""Consent-gated OCR routing: explicit chat-ocr or manually selected layout service."""
import base64
import json
import os
import time
import uuid
from pathlib import Path
from urllib.request import Request, build_opener
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
import fitz
from dotenv import dotenv_values
from matching_core.config import BASE_DIR
from matching_core.services.model_adapter import NoRedirect, model_settings
from matching_core.services.upload_detection import MAX_PDF_BYTES, MAX_OCR_REQUEST_BYTES


class OCRError(Exception):
    pass


def ocr_settings():
    env = {**dotenv_values(BASE_DIR / ".env"), **os.environ}
    return {
        "enabled": env.get("TALENTFLOW_MATCH_OCR_ENABLED", "true").lower() == "true",
        "url": env.get("TALENTFLOW_MATCH_OCR_BASE_URL", ""),
        "allow_http": env.get("TALENTFLOW_MATCH_ALLOW_HTTP", "false").lower() == "true",
        "provider": env.get("TALENTFLOW_MATCH_OCR_PROVIDER", "paddle_chat"),
    }


def selected_page_numbers(doc, page_numbers=None):
    """Validate a 1-based page selection before opening any network connection."""
    if doc.needs_pass or not len(doc):
        raise OCRError("OCR仅支持未加密且有页面的PDF")
    selected = list(range(1, len(doc) + 1)) if page_numbers is None else list(page_numbers)
    if not selected or any(type(n) is not int or not 1 <= n <= len(doc) for n in selected):
        raise OCRError("OCR待识别页码无效")
    if selected != sorted(set(selected)):
        raise OCRError("OCR待识别页码必须按原页顺序且不能重复")
    return selected


def recognize_pdf(path, consent=False, page_numbers=None):
    if not consent:
        raise OCRError("未授权发送扫描材料，无法可靠解析，请人工确认")
    cfg = ocr_settings()
    if not cfg["enabled"]:
        raise OCRError("OCR已关闭，无法可靠解析，请人工确认")
    if cfg.get("provider", "layout") == "paddle_chat":
        from matching_core.services.paddle_ocr import recognize_paddle_pdf
        return recognize_paddle_pdf(path, model_settings(), page_numbers=page_numbers)
    if cfg.get("provider", "layout") != "layout":
        raise OCRError("不支持的OCR服务配置")
    url = urlsplit(cfg["url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.query or url.fragment:
        raise OCRError("OCR地址格式错误")
    if url.scheme == "http" and not cfg["allow_http"]:
        raise OCRError("未确认HTTP测试传输风险")
    path = Path(path)
    if path.stat().st_size > MAX_PDF_BYTES:
        raise OCRError("PDF超过单文件50MB容量上限，请压缩后处理")
    request_id = "ocr-" + uuid.uuid4().hex
    started = time.monotonic()
    try:
        texts = []
        with fitz.open(path) as doc:
            selected = selected_page_numbers(doc, page_numbers)
            for page_no in selected:
                # Send only the explicitly selected page. Copying the whole file
                # would disclose text/blank pages that preflight did not request.
                with fitz.open() as chunk:
                    chunk.insert_pdf(doc, from_page=page_no - 1, to_page=page_no - 1, links=False)
                    pdf_bytes = chunk.tobytes(garbage=4, deflate=True)
                if len(pdf_bytes) > MAX_OCR_REQUEST_BYTES:
                    raise OCRError(f"第{page_no}页超过单次OCR请求10MB上限，请压缩该页后处理")
                data = json.dumps({"file": base64.b64encode(pdf_bytes).decode("ascii"), "fileType": 0,
                                   "logId": f"{request_id}-p{page_no}"}).encode("utf-8")
                req = Request(cfg["url"].rstrip("/") + "/layout-parsing", data=data,
                              headers={"Content-Type": "application/json"})
                with build_opener(NoRedirect()).open(req, timeout=300) as response:
                    raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise OCRError(f"第{page_no}页OCR响应超过8MB限制")
                payload = json.loads(raw)
                if payload.get("errorCode") != 0:
                    raise OCRError(f"第{page_no}页OCR服务返回业务错误，请联系服务管理员")
                pages = payload["result"]["layoutParsingResults"]
                if not isinstance(pages, list) or len(pages) != 1:
                    raise OCRError(f"第{page_no}页OCR返回页数与请求不一致")
                text = pages[0]["markdown"]["text"]
                if not isinstance(text, str) or not text.strip():
                    raise OCRError(f"第{page_no}页OCR没有识别到可用文字")
                if len(text) > 100000:
                    raise OCRError(f"第{page_no}页OCR文本过长，请人工确认")
                texts.append(text.strip())
        return texts, {"service": "document-ocr", "status": "调用成功", "pages": len(texts),
                       "page_numbers": selected, "request_count": len(selected),
                       "request_id": request_id, "elapsed_seconds": round(time.monotonic() - started, 1),
                       "reason": "OCR文字可能有误，需人工核对；位置按OCR输出行计数"}
    except HTTPError as exc:
        raise OCRError(f"OCR HTTP状态码：{exc.code}") from None
    except TimeoutError:
        raise OCRError("OCR单页响应超时（300秒），请重试或人工确认") from None
    except URLError:
        raise OCRError("OCR网络连接失败") from None
    except OCRError:
        raise
    except Exception:
        raise OCRError("OCR响应格式错误或客户端异常") from None
