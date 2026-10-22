import copy
import pytest
from matching_core.services import retrieval as r

def inputs():
    return {"total":71.8,"decision":None}, {"raw_evidence":[{"text":"招聘渠道运营","file":"sample.pdf","location":"第1行"},{"text":"性别：测试","file":"sample.pdf"},{"text":"招聘周期分析 13812345678","file":"sample.pdf","location":"第3行"}]}, {"name":"招聘专员","requirements":["招聘渠道运营"]}

def enable(monkeypatch):
    monkeypatch.setattr(r, "model_settings", lambda:{"provider":"external","retrieval_enabled":True})

def test_local_no_network(monkeypatch):
    monkeypatch.setattr(r, "request_json", lambda *a:pytest.fail("network"))
    score, parsed, job=inputs()
    assert r.add_retrieval(score,parsed,job)["status"] == "未启用"

def test_success_safe_and_preserves_score(monkeypatch):
    enable(monkeypatch)
    def request(cfg, route, payload):
        assert "性别" not in str(payload) and "13812345678" not in str(payload) and "sample.pdf" not in str(payload)
        if route == "/embeddings":
            return {"data":[{"index":i,"embedding":[1,i+1]} for i in reversed(range(len(payload["input"])))]}
        return {"results":[{"index":i,"relevance_score":i+.1} for i in range(len(payload["documents"]))]}
    monkeypatch.setattr(r,"request_json",request)
    score, parsed, job=inputs()
    before=copy.deepcopy(parsed)
    result=r.add_retrieval(score,parsed,job)
    assert result["status"] == "调用成功"
    assert score["total"]==71.8 and score["decision"] is None and before==parsed
    assert all(e["file"]=="sample.pdf" for e in result["evidence"])

@pytest.mark.parametrize("data", [[], [{"index":0,"embedding":[0,0]}], [{"index":0,"embedding":[float('nan')]}], [{"index":2,"embedding":[1]}]])
def test_bad_vectors(monkeypatch,data):
    monkeypatch.setattr(r,"request_json",lambda *a:{"data":data})
    with pytest.raises(r.ModelError): r.embeddings({},["test"])

def test_bad_rerank(monkeypatch):
    monkeypatch.setattr(r,"request_json",lambda *a:{"results":[{"index":9,"relevance_score":.5}]})
    with pytest.raises(r.ModelError): r.rerank({},"q",["doc"])

def test_partial_fallback(monkeypatch):
    enable(monkeypatch)
    monkeypatch.setattr(r,"embeddings",lambda cfg,texts:[[1,0] for _ in texts])
    def fail(*args): raise r.ModelError("连接失败")
    monkeypatch.setattr(r,"rerank",fail)
    score,parsed,job=inputs()
    result=r.add_retrieval(score,parsed,job)
    assert result["status"]=="部分成功" and result["evidence"] and score["total"]==71.8

