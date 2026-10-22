"""Evidence retrieval only: external scores never replace weighted matching scores."""
import json
import math
import time
from urllib.request import Request, build_opener
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from matching_core.services.model_adapter import model_settings, ModelError, NoRedirect
from matching_core.services.privacy import redact_sensitive
from matching_core.services.reasoning import EXCLUDED


def request_json(config, route, payload):
    url = urlsplit(config["url"])
    if not config["confirmed"] or not config["key"] or "replace_" in config["key"]:
        raise ModelError("密钥未配置或未确认")
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.query or url.fragment:
        raise ModelError("服务地址无效")
    if url.scheme == "http" and not config["http_allowed"]:
        raise ModelError("未确认HTTP测试风险")
    endpoint = config["url"].rstrip("/")
    if not endpoint.endswith("/v1"):
        endpoint += "/v1"
    body = redact_sensitive(json.dumps(payload, ensure_ascii=False)).text
    req = Request(endpoint + route, data=body.encode("utf-8"), headers={"Authorization": "Bearer " + config["key"], "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect()).open(req, timeout=60) as response:
            data = response.read(4_000_001)
        if len(data) > 4_000_000:
            raise ModelError("模型响应过大")
        return json.loads(data)
    except HTTPError as exc:
        raise ModelError(f"HTTP状态码：{exc.code}") from None
    except (TimeoutError, URLError):
        raise ModelError("连接失败或响应超时（60秒）") from None
    except (ValueError, UnicodeError):
        raise ModelError("响应不是有效JSON") from None


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def embeddings(config, texts):
    payload = request_json(config, "/embeddings", {"model": "embedding-primary", "input": texts})
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or len(data) != len(texts):
        raise ModelError("向量数量不符合请求")
    vectors = [None] * len(texts)
    for item in data:
        if not isinstance(item, dict):
            raise ModelError("向量响应格式错误")
        i, v = item.get("index"), item.get("embedding")
        if type(i) is not int or not 0 <= i < len(texts) or vectors[i] is not None:
            raise ModelError("向量编号错误")
        if not isinstance(v, list) or not 1 <= len(v) <= 8192 or not all(finite_number(x) for x in v):
            raise ModelError("向量数值错误")
        norm = math.hypot(*v)
        if not math.isfinite(norm) or norm == 0:
            raise ModelError("向量长度无效")
        vectors[i] = [x / norm for x in v]
    if len({len(v) for v in vectors}) != 1:
        raise ModelError("向量维度不一致")
    return vectors


def rerank(config, query, docs):
    payload = request_json(config, "/rerank", {"model": "rerank-primary", "query": query, "documents": docs, "top_n": len(docs), "return_documents": False})
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list) or len(results) != len(docs):
        raise ModelError("重排结果数量错误")
    seen, ordered = set(), []
    for item in results:
        if not isinstance(item, dict):
            raise ModelError("重排响应格式错误")
        i, value = item.get("index"), item.get("relevance_score")
        if type(i) is not int or not 0 <= i < len(docs) or i in seen or not finite_number(value):
            raise ModelError("重排编号或分数错误")
        seen.add(i)
        ordered.append((i, value))
    return sorted(ordered, key=lambda x: (-x[1], x[0]))


def add_retrieval(score, parsed, job):
    cfg = model_settings()
    result = {"status": "未启用", "reason": "不影响本地评分", "embedding": {"model":"embedding-primary", "status":"未调用"}, "rerank": {"model":"rerank-primary", "status":"未调用"}, "evidence": []}
    score["retrieval_analysis"] = result
    if cfg["provider"] != "external" or not cfg["retrieval_enabled"]:
        return result
    # Drop protected/contact lines altogether; never send filenames or identity fields.
    evidence = []
    for e in parsed.get("raw_evidence", []):
        for line in e.get("text", "").splitlines():
            if line.strip() and not any(x in line for x in EXCLUDED):
                evidence.append({"text": redact_sensitive(line[:1000]).text, "file": redact_sensitive(e.get("file", "")).text, "location": e.get("location", "")})
    safe_job = json.dumps({k: job[k] for k in ("name", "responsibilities", "requirements", "hard_conditions", "extra_sections") if k in job}, ensure_ascii=False)
    if any(x in safe_job for x in EXCLUDED):
        result.update(status="未采用", reason="岗位配置含敏感或非岗位属性，请人工检查")
        return result
    query = redact_sensitive(safe_job).text[:4000]
    result["available_evidence_count"] = len(evidence)
    evidence = evidence[:24]
    result["processed_evidence_count"] = len(evidence)
    if not evidence:
        result.update(status="未采用", reason="无可用岗位相关证据")
        return result
    started = time.monotonic()
    try:
        vectors = embeddings(cfg, [query] + [e["text"] for e in evidence])
        similarities = [max(-1., min(1., sum(a*b for a,b in zip(vectors[0], v)))) for v in vectors[1:]]
        selected = sorted(range(len(evidence)), key=lambda i: (-similarities[i], i))[:8]
        candidates = [{**evidence[i], "similarity": round(similarities[i], 4)} for i in selected]
        result["embedding"].update(status="调用成功", dimensions=len(vectors[0]))
        result["evidence"] = candidates
    except ModelError as exc:
        result["embedding"].update(status="未采用", reason=str(exc))
        result.update(status="未采用", reason="向量检索失败，本地评分不变")
        return result
    try:
        order = rerank(cfg, query, [e["text"] for e in candidates])
        result["evidence"] = [{**candidates[i], "relevance": round(value, 4)} for i,value in order]
        result["rerank"].update(status="调用成功")
        result.update(status="调用成功", reason="仅为证据相关性排序，不是候选人匹配分或录用概率")
    except ModelError as exc:
        result["rerank"].update(status="未采用", reason=str(exc))
        result.update(status="部分成功", reason="重排失败，保留向量检索顺序；本地评分不变")
    result["elapsed_seconds"] = round(time.monotonic()-started, 1)
    return result
