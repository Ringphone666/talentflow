"""Explicit chat-ocr alias; version attribution is from supplier documentation."""
import base64
import json
import time
import uuid
from pathlib import Path
from urllib.request import Request, build_opener
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
import fitz
from matching_core.services.model_adapter import NoRedirect
from matching_core.services.ocr import OCRError, selected_page_numbers
from matching_core.services.upload_detection import MAX_PDF_BYTES, MAX_OCR_REQUEST_BYTES


def recognize_paddle_pdf(path, cfg, page_numbers=None):
    if cfg["provider"] != "external" or not cfg["key"] or "replace_" in cfg["key"] or not cfg["confirmed"]:
        raise OCRError("PaddleOCR需要启用外部服务并配置已确认的密钥")
    url=urlsplit(cfg["url"])
    if url.scheme not in ("http","https") or not url.hostname or url.username or url.query or url.fragment:
        raise OCRError("PaddleOCR服务地址无效")
    if url.scheme=="http" and not cfg["http_allowed"]:
        raise OCRError("未确认HTTP测试传输风险")
    path=Path(path)
    if path.stat().st_size > MAX_PDF_BYTES:
        raise OCRError("PDF超过单文件50MB容量上限，请压缩后处理")
    endpoint=cfg["url"].rstrip("/")
    if not endpoint.endswith("/v1"): endpoint+="/v1"
    started=time.monotonic()
    texts=[]
    try:
        with fitz.open(path) as doc:
            selected=selected_page_numbers(doc,page_numbers)
            for page_no in selected:
                page=doc[page_no-1]
                # Bounded rendering, no temporary image files or remote image URLs.
                scale=min(2.,2000/max(page.rect.width,page.rect.height))
                png=page.get_pixmap(matrix=fitz.Matrix(scale,scale),colorspace=fitz.csRGB,alpha=False).tobytes("png")
                if len(png)>MAX_OCR_REQUEST_BYTES:
                    raise OCRError(f"第{page_no}页渲染图像超过单次OCR请求10MB上限，请压缩该页后处理")
                payload={"model":"chat-ocr","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,"+base64.b64encode(png).decode("ascii")}},{"type":"text","text":"OCR:"}]}],"temperature":0,"max_tokens":4096,"stream":False}
                req=Request(endpoint+"/chat/completions",data=json.dumps(payload).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer "+cfg["key"]})
                # Each page has its own timeout; long PDFs are not cut off by a
                # single five-minute budget for the entire document.
                with build_opener(NoRedirect()).open(req,timeout=300) as response:
                    raw=response.read(2_000_001)
                if len(raw)>2_000_000: raise OCRError("OCR响应过大")
                result=json.loads(raw)
                if result.get("model") != "chat-ocr":
                    raise OCRError("OCR响应模型名称与chat-ocr不一致，未采用")
                choice=result["choices"][0]
                if choice.get("finish_reason") != "stop":
                    raise OCRError("OCR输出被截断或未正常结束，未采用")
                text=choice["message"].get("content")
                if not isinstance(text,str) or not text.strip() or len(text)>100000 or cfg["key"] in text:
                    raise OCRError("OCR未返回有效识别文字")
                texts.append(text.strip())
        return texts,{"service":"paddle-chat-ocr","model":"chat-ocr","expected_model":"PaddleOCR-VL-1.6（业务接口文档映射）","status":"调用成功","pages":len(texts),"page_numbers":selected,"request_count":len(selected),"request_id":"ocr-"+uuid.uuid4().hex,"elapsed_seconds":round(time.monotonic()-started,1),"reason":"已显式调用chat-ocr；按页识字，非完整版面解析流水线。文字及OCR行位置需人工核对。"}
    except OCRError: raise
    except HTTPError as exc: raise OCRError(f"PaddleOCR HTTP状态码：{exc.code}") from None
    except (TimeoutError,URLError): raise OCRError("PaddleOCR连接失败或响应超时") from None
    except Exception: raise OCRError("PaddleOCR响应或PDF格式无效") from None
