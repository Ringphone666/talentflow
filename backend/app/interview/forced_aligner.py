"""Optional speech alignment adapter.

Configure the endpoint, route and model alias with environment variables.
Credentials are resolved only when a request is made.
"""
import base64
import mimetypes
import os
from pathlib import Path

import httpx

from .text_models import get_key
from ..core.settings import SECRETS_DIR

ROOT = SECRETS_DIR.parent
KEY_FILE = SECRETS_DIR / 'forced-aligner-key.dpapi'
BASE_URL = os.getenv('TALENTFLOW_ALIGNER_BASE_URL', 'https://aligner.example.invalid').rstrip('/')
ROUTE_ID = os.getenv('TALENTFLOW_ALIGNER_ROUTE_ID', 'configure-route')
MODEL = os.getenv('TALENTFLOW_ALIGNER_MODEL', 'qwen3-forcedaligner-small')
TOKENIZER = os.getenv('TALENTFLOW_ALIGNER_TOKENIZER', 'Qwen/Qwen3-ForcedAligner-0.6B')
TIMESTAMP_TOKEN_ID = int(os.getenv('TALENTFLOW_ALIGNER_TIMESTAMP_TOKEN_ID', '151705'))
TIMESTAMP_SEGMENT_MS = float(os.getenv('TALENTFLOW_ALIGNER_TIMESTAMP_SEGMENT_MS', '80'))
RAW_CONTENT_CHAT_TEMPLATE = "{{ messages[0]['content'] }}"


def enabled() -> bool:
    # 只有显式配置为 live 时才启用可选的强制对齐服务。
    return os.getenv('TALENTFLOW_ALIGNER_MODE', 'disabled') == 'live'


def status() -> dict:
    return {
        'mode': 'live' if enabled() else 'configured_not_enabled',
        'model': MODEL,
        'canonical_model': 'Qwen/Qwen3-ForcedAligner-0.6B',
        'route_id': ROUTE_ID,
        'base_url': BASE_URL,
    }


def choose_units(text: str) -> list[str]:
    compact = ''.join(text.split())
    return list(compact) if any('\u3400' <= char <= '\u9fff' for char in compact) else text.split()


def build_payload(audio: bytes, transcript: str, mime_type: str = 'audio/wav') -> dict:
    units = choose_units(transcript)
    prompt = '<|audio_start|><|audio_pad|><|audio_end|>' + '<timestamp><timestamp>'.join(units) + '<timestamp><timestamp>'
    audio_uri = f'data:{mime_type};base64,' + base64.b64encode(audio).decode('ascii')
    return {'model': MODEL, 'messages': [{'role': 'user', 'content': [
        {'type': 'text', 'text': prompt}, {'type': 'audio_url', 'audio_url': {'url': audio_uri}}
    ]}], 'task': 'token_classify', 'chat_template': RAW_CONTENT_CHAT_TEMPLATE}


def _argmax(values: list[float]) -> int:
    return max(range(len(values)), key=values.__getitem__)


def decode(result: dict, prompt: str, units: list[str]) -> list[dict]:
    try:
        from transformers import AutoTokenizer
    except ImportError as exc:
        raise RuntimeError('ForcedAligner requires the locked transformers dependency') from exc
    logits = result.get('data', [{}])[0].get('data')
    if not isinstance(logits, list) or not logits or not isinstance(logits[0], list):
        raise ValueError('ForcedAligner response has no data[0].data logits')
    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER)
    token_ids = tokenizer(prompt, add_special_tokens=False)['input_ids']
    audio_pad_id = tokenizer.convert_tokens_to_ids('<|audio_pad|>')
    try:
        audio_pad_index = token_ids.index(audio_pad_id)
    except ValueError as exc:
        raise ValueError('ForcedAligner tokenizer does not contain the audio pad token') from exc
    predictions = [_argmax(row) for row in logits]
    shift = len(predictions) - len(token_ids)
    if shift < 0:
        raise ValueError('ForcedAligner result is shorter than local tokenization')
    times = []
    for index, token_id in enumerate(token_ids):
        if token_id == TIMESTAMP_TOKEN_ID:
            prediction_index = index + shift if index > audio_pad_index else index
            if prediction_index >= len(predictions):
                raise ValueError('ForcedAligner timestamp index is outside response')
            times.append(predictions[prediction_index] * TIMESTAMP_SEGMENT_MS)
    if len(times) < len(units) * 2:
        raise ValueError('ForcedAligner returned too few timestamp predictions')
    return [{'text': unit, 'start_time_ms': round(times[i * 2], 2),
             'end_time_ms': round(times[i * 2 + 1], 2)} for i, unit in enumerate(units)]


def request_alignment(audio_path: Path, transcript: str, timeout: float = 180.0) -> dict:
    """Call the confirmed pooling endpoint and return decoded character/word timestamps."""
    if not enabled():
        raise RuntimeError('ForcedAligner is configured but not enabled')
    mime = mimetypes.guess_type(audio_path.name)[0] or 'audio/wav'
    payload = build_payload(audio_path.read_bytes(), transcript, mime)
    response = httpx.post(
        f'{BASE_URL}/model/proxy/{ROUTE_ID}/pooling',
        headers={'Authorization': f'Bearer {get_key("aligner")}'},
        json=payload, timeout=timeout,
    )
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict) or not isinstance(result.get('data'), list):
        raise ValueError('ForcedAligner returned an unexpected pooling response')
    units = choose_units(transcript)
    prompt = payload['messages'][0]['content'][0]['text']
    return {'model': MODEL, 'canonical_model': 'Qwen/Qwen3-ForcedAligner-0.6B',
            'units': decode(result, prompt, units)}
