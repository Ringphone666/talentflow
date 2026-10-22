import copy
import json
from urllib.error import HTTPError

import pytest

from matching_core.services import model_adapter as module
from matching_core.services.parser import parse_candidate


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setattr(module, "model_settings", lambda: {
        "provider": "external", "key": "fake-test-key", "url": "https://example.invalid/v1",
        "model": "chat-primary", "confirmed": True, "http_allowed": False})


def candidate():
    return parse_candidate("候选人编号：TEST-01\n姓名：测试\n教育经历：虚构大学本科\n专业技能：Python开发", "虚构.pdf")


def output():
    return {"fields": {key: ([1] if key == "education" else []) for key in candidate()["fields"]}}


def fake_http(monkeypatch, content=None, finish="stop", error=None):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size):
            return json.dumps({"choices": [{"finish_reason": finish, "message": {"content": content}}]}).encode()

    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "https://example.invalid/v1/chat/completions"
            assert timeout == 180
            body = json.loads(request.data)
            assert body["model"] == "chat-primary"
            assert "姓名" not in body["messages"][1]["content"]
            assert not module.contains_unmasked_sensitive(body["messages"][1]["content"])
            if error: raise error
            return Response()
    monkeypatch.setattr(module, "build_opener", lambda *args: Opener())


def test_success_and_local_evidence(monkeypatch):
    fake_http(monkeypatch, json.dumps(output()))
    result = module.enrich_candidate(candidate())
    assert result["model_analysis"]["status"] == "调用成功"
    field = result["fields"]["education"]
    assert field["value"] == "教育经历：虚构大学本科"
    assert field["location"] == "虚构.pdf：第3行"
    assert field["status"] == "模型提取，待人工确认"


@pytest.mark.parametrize("content,finish", [("not json", "stop"), ("", "stop"), ("{}", "stop"), (json.dumps(output()), "length")])
def test_invalid_response_falls_back(monkeypatch, content, finish):
    fake_http(monkeypatch, content, finish)
    parsed = candidate()
    before = copy.deepcopy(parsed["fields"])
    result = module.enrich_candidate(parsed)
    assert result["model_analysis"]["status"] == "已回退本地规则"
    assert result["fields"] == before


@pytest.mark.parametrize("ids", [[999], [True], ["1"], [-1]])
def test_invalid_evidence_rejected(monkeypatch, ids):
    data = output()
    data["fields"]["education"] = ids
    fake_http(monkeypatch, json.dumps(data))
    assert module.enrich_candidate(candidate())["model_analysis"]["status"] == "已回退本地规则"


@pytest.mark.parametrize("error", [TimeoutError("secret"), HTTPError("url", 401, "secret", {}, None)])
def test_errors_do_not_leak(monkeypatch, error):
    fake_http(monkeypatch, error=error)
    result = module.enrich_candidate(candidate())
    assert "secret" not in json.dumps(result)
    assert result["model_analysis"]["status"] == "已回退本地规则"


def test_missing_key_and_privacy():
    with pytest.raises(module.ModelError):
        module.ExternalModelAdapter("", "https://example.invalid").analyze("test", {})
    with pytest.raises(module.ModelError):
        module.ExternalModelAdapter("fake", "https://example.invalid").analyze("13812345678", {})


def test_local_mode_never_calls(monkeypatch):
    monkeypatch.setattr(module, "model_settings", lambda: {"provider": "local_rules"})
    monkeypatch.setattr(module, "build_opener", lambda *args: pytest.fail("Unexpected network"))
    assert module.enrich_candidate(candidate())["model_analysis"]["status"] == "本地规则"


def test_preserve_manual_and_conflict(monkeypatch):
    fake_http(monkeypatch, json.dumps(output()))
    parsed = candidate()
    parsed["fields"]["education"]["status"] = "人工已确认"
    before = copy.deepcopy(parsed["fields"])
    assert module.enrich_candidate(parsed)["fields"] == before


def test_full_pdf_workflow(monkeypatch, tmp_path):
    from .fixture_data import DEMO_DIR
    from matching_core.db import rows
    from .fixture_data import init_db
    from matching_core.services import workflow
    db = tmp_path / "test.db"
    init_db(db)
    for name in ("ORIGINAL_DIR", "REDACTED_DIR", "STRUCTURED_DIR"):
        monkeypatch.setattr(workflow, name, tmp_path / name)
    fake_http(monkeypatch, json.dumps(output()))
    path = next((DEMO_DIR / "resumes" / "JOB-TECH-001").glob("*.pdf"))
    task = workflow.create_task("JOB-TECH-001", [path.name], "招聘人员", db)
    ids = workflow.process_task(task, "JOB-TECH-001", [path], "招聘人员", db_path=db)
    assert len(ids) == 1
    stored = workflow.get_candidate(ids[0], db)
    assert stored["parsed"]["model_analysis"]["status"] == "调用成功"
    assert stored["decision"] is None
    # Field extraction succeeds; offline scoring must not fabricate a zero.
    assert stored["score"]["total"] is None
    assert stored["score"]["assessment_status"] == "待评估"


def test_confirm_key_rotation(monkeypatch):
    config = module.model_settings()
    config["confirmed"] = False
    monkeypatch.setattr(module, "model_settings", lambda: config)
    monkeypatch.setattr(module, "build_opener", lambda *args: pytest.fail("Unexpected network"))
    assert module.enrich_candidate(candidate())["model_analysis"]["status"] == "已回退本地规则"


def test_empty_and_oversized_material(monkeypatch):
    monkeypatch.setattr(module, "build_opener", lambda *args: pytest.fail("Unexpected network"))
    for text in ("", "技能：" + "开发" * 15000):
        parsed = parse_candidate(text, "fictional.pdf")
        assert module.enrich_candidate(parsed)["model_analysis"]["status"] == "已回退本地规则"


def test_http_requires_opt_in():
    with pytest.raises(module.ModelError, match="HTTP"):
        module.ExternalModelAdapter("fake", "http://example.invalid").analyze("test", {})
