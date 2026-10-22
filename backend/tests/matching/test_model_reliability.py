import json
import pytest
from matching_core.services.model_adapter import decode_model_json, ModelError, ExternalModelAdapter


def test_fence_json():
    assert decode_model_json('```\n{"fields":{}}\n```') == {"fields": {}}
    assert decode_model_json('```JSON\n{"fields":{}}\n```') == {"fields": {}}


def test_invalid_json_has_precise_code():
    with pytest.raises(ModelError) as e:
        decode_model_json("not json")
    assert e.value.code == "CONTENT_JSON"


def test_only_missing_object_closers_repaired():
    assert decode_model_json('{"fields":{"skills":[1]}') == {"fields":{"skills":[1]}}
    for value in ('{"skills":[1', '{"text":"unfinished', '{"fields":{"skills":[1,]}}', '{"fields":]'):
        with pytest.raises(ModelError): decode_model_json(value)


def test_bounded_retry(monkeypatch):
    a = ExternalModelAdapter("fake", "https://example.invalid")
    calls = []
    def once(*args):
        calls.append(1)
        if len(calls) == 1: raise ModelError("timeout", "TIMEOUT", True)
        return {"fields": {}}
    monkeypatch.setattr(a, "_analyze_once", once)
    assert a.analyze("test", {}) == {"fields": {}}
    assert a.diagnostics["attempts"] == 2


def test_no_retry_on_auth(monkeypatch):
    a = ExternalModelAdapter("fake", "https://example.invalid")
    def once(*args): raise ModelError("unauthorized", "HTTP_401")
    monkeypatch.setattr(a, "_analyze_once", once)
    with pytest.raises(ModelError): a.analyze("test", {})
    assert a.diagnostics["attempts"] == 1


