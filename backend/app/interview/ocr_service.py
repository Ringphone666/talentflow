"""PaddleOCR layout-parsing adapter for PDF/image business materials."""
import base64
import os
from pathlib import Path

import httpx

BASE_URL = os.getenv("TALENTFLOW_OCR_BASE_URL", "https://ocr.example.invalid").rstrip("/")
MODE = os.getenv("TALENTFLOW_OCR_MODE", "live").lower()
TIMEOUT = float(os.getenv("TALENTFLOW_OCR_TIMEOUT", "300"))
if os.getenv("TALENTFLOW_TEXT_MODE", "").lower() == "mock":
    MODE = "disabled"


def status() -> dict:
    return {
        "mode": "live" if MODE in {"live", "auto"} else "disabled",
        "provider": "paddleocr",
        "base_url": BASE_URL,
        "endpoint": "/layout-parsing",
        "contract": "confirmed",
        "note": "处理PDF简历和岗位资料；失败时保留原始文件，不生成替代文本",
    }


def parse_document(path: str | Path, file_type: int = 0) -> dict:
    if MODE not in {"live", "auto"}:
        raise RuntimeError("OCR未启用")
    payload = {"file": base64.b64encode(Path(path).read_bytes()).decode("ascii"),
               "fileType": file_type, "logId": Path(path).stem}
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, trust_env=False) as client:
        response = client.post(BASE_URL + "/layout-parsing", json=payload)
        response.raise_for_status()
        body = response.json()
    if body.get("errorCode") not in (None, 0, "0", ""):
        raise RuntimeError(str(body.get("errorMessage") or body.get("message") or body["errorCode"]))
    texts = []
    for item in body.get("result", {}).get("layoutParsingResults", []):
        markdown = item.get("markdown") or {}
        value = markdown.get("text") if isinstance(markdown, dict) else markdown
        if value:
            texts.append(str(value).strip())
    if not texts:
        raise RuntimeError("OCR响应中没有可保存的文本")
    return {"text": "\n\n".join(texts), "provider": "paddleocr", "raw": body}


def health() -> dict:
    if MODE not in {"live", "auto"}:
        return {**status(), "status": "disabled"}
    try:
        with httpx.Client(timeout=8, follow_redirects=False, trust_env=False) as client:
            response = client.get(BASE_URL + "/health")
            response.raise_for_status()
            detail = response.json()
        return {**status(), "status": "ready", "detail": detail}
    except (httpx.HTTPError, ValueError) as exc:
        return {**status(), "status": "unavailable", "detail": type(exc).__name__}
