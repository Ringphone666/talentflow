from pathlib import Path

import pytest

from backend.app.interview import speaker_services as speaker


def test_speaker_status_is_explicit_when_services_are_not_running(monkeypatch):
    monkeypatch.setattr(speaker, "MODE", "auto")
    monkeypatch.setattr(speaker, "_health", lambda url: {"status": "unavailable", "url": url, "detail": {}})
    result = speaker.status()
    assert result["mode"] == "configured_not_running"
    assert result["speaker_service"]["status"] == "unavailable"
    assert not speaker.enabled()


def test_disabled_mode_reports_disabled_without_probing_local_services(monkeypatch, tmp_path):
    monkeypatch.setattr(speaker, "MODE", "disabled")
    monkeypatch.setattr(speaker, "_health", lambda url: pytest.fail("停用时不得探测本机服务"))
    result = speaker.status()
    assert result["mode"] == "disabled"
    assert result["speaker_service"]["status"] == result["diarization_service"]["status"] == "disabled"
    assert not speaker.enabled()
    source = tmp_path / "capture.wav"
    source.write_bytes(b"wav")
    with pytest.raises(RuntimeError):
        speaker.diarize(source, object_key="listening/1/capture.wav", meeting_id="meeting-1")


def test_diarize_uses_local_contract(monkeypatch, tmp_path):
    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"turns": [{"cluster_id": "spk-0", "label": "说话人1", "start_ms": 0, "end_ms": 1200}], "warnings": []}

    class Client:
        def __init__(self, **kwargs):
            self.payload = None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json):
            self.payload = json
            assert url.endswith("/v1/speakers/diarize")
            assert json["meeting_id"] == "meeting-1"
            assert json["audio_object_key"] == "listening/1/capture.wav"
            return Response()

    source = tmp_path / "capture.wav"
    source.write_bytes(b"wav")
    object_root = tmp_path / "objects"
    monkeypatch.setattr(speaker, "MODE", "live")
    monkeypatch.setattr(speaker, "OBJECT_ROOT", object_root)
    monkeypatch.setattr(speaker, "_health", lambda url: {"status": "ready", "url": url, "detail": {}})
    monkeypatch.setattr(speaker.httpx, "Client", Client)
    result = speaker.diarize(source, object_key="listening/1/capture.wav", meeting_id="meeting-1")
    assert result["provider"] == "local-3d-speaker"
    assert result["turns"][0]["cluster_id"] == "spk-0"
    assert (object_root / "listening/1/capture.wav").is_file()


def test_object_key_cannot_escape_shared_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(speaker, "OBJECT_ROOT", tmp_path)
    with pytest.raises(ValueError):
        speaker._safe_object_path("../../outside.wav")
