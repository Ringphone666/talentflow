"""Confirmed TalentFlow OpenAI-compatible Embedding and Reranker adapters."""
import os
import httpx
from .text_models import BASE_URL, get_key, key_configured

EMBEDDING_MODEL = os.getenv("TALENTFLOW_EMBEDDING_MODEL", "embedding-primary")
RERANK_MODEL = os.getenv("TALENTFLOW_RERANK_MODEL", "rerank-primary")


def status() -> dict:
    enabled = os.getenv("TALENTFLOW_TEXT_MODE", "live").lower() == "live"
    test_mock = os.getenv("TALENTFLOW_RUNTIME_PROFILE", "production").lower() == "test" and not enabled
    # 与文本模型共用同一个密钥；启用了但没有配置密钥时如实报告不可用。
    live = enabled and key_configured()
    return {"mode": "live" if live else ("mock" if test_mock else "unavailable"), "embedding": EMBEDDING_MODEL,
            "embedding_dimensions": 2560, "reranker": RERANK_MODEL,
            "contract": "confirmed", "note": "只做资料/证据检索排序，不覆盖人工评分"}


def _headers():
    return {"Authorization": "Bearer " + get_key()}


def embed(texts: list[str]) -> dict:
    with httpx.Client(timeout=60, follow_redirects=False, trust_env=False) as client:
        response = client.post(BASE_URL + "/embeddings", headers=_headers(),
                               json={"model": EMBEDDING_MODEL, "input": texts, "encoding_format": "float"})
        response.raise_for_status()
        body = response.json()
    rows = body.get("data") or []
    vectors = [row.get("embedding") for row in rows]
    if len(vectors) != len(texts) or any(not isinstance(v, list) for v in vectors):
        raise RuntimeError("Embedding响应格式不正确")
    return {"model": body.get("model", EMBEDDING_MODEL), "data": vectors,
            "dimension": len(vectors[0]) if vectors else 2560}


def rerank(query: str, documents: list[str], top_n: int | None = None) -> dict:
    payload = {"model": RERANK_MODEL, "query": query, "documents": documents}
    if top_n is not None:
        payload["top_n"] = top_n
    with httpx.Client(timeout=60, follow_redirects=False, trust_env=False) as client:
        response = client.post(BASE_URL + "/rerank", headers=_headers(), json=payload)
        response.raise_for_status()
        body = response.json()
    normalized = []
    for row in body.get("results") or body.get("data") or []:
        index = row.get("index")
        if isinstance(index, int) and 0 <= index < len(documents):
            normalized.append({"index": index, "score": row.get("relevance_score", row.get("score")),
                               "document": documents[index]})
    return {"model": body.get("model", RERANK_MODEL), "results": normalized}
