"""Adapter for the customer-supplied local 3D-Speaker CPU services.

The delivery package exposes two HTTP services:

* 容器内 9100、宿主机默认 9200：speaker-service enrollment/voiceprint identification;
* 容器内 9101、宿主机默认 9201：diarization-service segmentation and ERes2NetV2 speaker clustering.

This module deliberately fails closed.  If the local containers are not
running, the interview flow keeps the original audio/transcript and records
``unavailable`` instead of inventing a speaker label.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import Any

import httpx

from ..core.database import DATA_DIR


SPEAKER_BASE_URL = os.getenv("TALENTFLOW_SPEAKER_BASE_URL", "http://127.0.0.1:9200").rstrip("/")
DIARIZATION_BASE_URL = os.getenv("TALENTFLOW_DIARIZATION_BASE_URL", "http://127.0.0.1:9201").rstrip("/")
MODE = os.getenv("TALENTFLOW_SPEAKER_MODE", "auto").strip().lower()
MODEL_ID = os.getenv("TALENTFLOW_SPEAKER_MODEL", "iic/speech_eres2netv2_sv_zh-cn_16k-common")
OBJECT_ROOT = Path(os.getenv("TALENTFLOW_SPEAKER_OBJECT_ROOT", str(DATA_DIR / "objects"))).resolve()


def _health(url: str) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=1.2, follow_redirects=False, trust_env=False) as client:
            response = client.get(f"{url}/healthz")
            body = response.json()
            return {"status": "ready" if response.is_success and body.get("status") == "ready" else "unavailable", "url": url, "detail": body}
    except (httpx.HTTPError, ValueError, TypeError):
        return {"status": "unavailable", "url": url, "detail": {}}


def status() -> dict[str, Any]:
    if MODE in {"mock", "disabled"}:
        return {"mode": "disabled", "model": MODEL_ID, "speaker_service": {"status": "disabled", "url": SPEAKER_BASE_URL}, "diarization_service": {"status": "disabled", "url": DIARIZATION_BASE_URL}}
    speaker = _health(SPEAKER_BASE_URL)
    diarization = _health(DIARIZATION_BASE_URL)
    return {"mode": "live" if speaker["status"] == "ready" and diarization["status"] == "ready" else "configured_not_running", "model": MODEL_ID, "speaker_service": speaker, "diarization_service": diarization}


def enabled() -> bool:
    if MODE in {"mock", "disabled"}:
        return False
    return status()["mode"] == "live"


def _safe_object_path(object_key: str) -> Path:
    key = object_key.replace("\\", "/").lstrip("/")
    path = (OBJECT_ROOT / key).resolve()
    if not path.is_relative_to(OBJECT_ROOT):
        raise ValueError("audio_object_key 超出本地音频对象目录")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_audio(audio_path: Path, object_key: str) -> str:
    """Copy a persisted interview WAV into the shared model object directory."""
    source = audio_path.resolve()
    if not source.is_file():
        raise FileNotFoundError(str(source))
    target = _safe_object_path(object_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    if source != target:
        shutil.copy2(source, target)
    return object_key.replace("\\", "/").lstrip("/")


def diarize(audio_path: Path, *, object_key: str, meeting_id: str, expected_speaker_count: int = 2) -> dict[str, Any]:
    """Run local 9201-host diarization and return turns plus provider audit metadata."""
    if not enabled():
        raise RuntimeError("3D-Speaker 本地服务未运行（请先启动 9200/9201）")
    key = prepare_audio(audio_path, object_key)
    payload = {
        "meeting_id": meeting_id,
        "audio_object_key": key,
        "audio_sha256": _sha256(_safe_object_path(key)),
        "classification": "confidential",
        "expected_speaker_count": expected_speaker_count,
        "detect_overlap": True,
    }
    with httpx.Client(timeout=180, follow_redirects=False, trust_env=False) as client:
        response = client.post(f"{DIARIZATION_BASE_URL}/v1/speakers/diarize", json=payload)
        response.raise_for_status()
        result = response.json()
    if not isinstance(result, dict) or not isinstance(result.get("turns"), list):
        raise ValueError("9201 返回缺少 turns")
    return {"provider": "local-3d-speaker", "model": MODEL_ID, "service": DIARIZATION_BASE_URL, "object_key": key, "turns": result["turns"], "cluster_diagnostics": result.get("cluster_diagnostics", []), "audit": result.get("audit", {}), "models": result.get("models", {}), "warnings": result.get("warnings", []), "performance": result.get("performance", {})}

