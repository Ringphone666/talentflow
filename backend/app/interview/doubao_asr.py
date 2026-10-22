"""Doubao streaming ASR binary protocol; credentials stay in the backend."""
import asyncio
import gzip
import json
import os
import struct
import uuid
from websockets.asyncio.client import connect
from .text_models import get_key

ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
# 整段录音补转写用“流式输入”接口：音频可以一次发完，结果在收完音频后返回。
# 实时接口按音频到达的时间断句，快速补发会把一句话切成很多段（2026-09-29 实测）。
SAVED_AUDIO_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
RESOURCE = 'volc.bigasr.sauc.duration'
BYTES_PER_SECOND = 16000 * 2

def enabled():
    return os.getenv('TALENTFLOW_ASR_MODE', 'doubao').strip().lower() in {'doubao', 'live'}

def packet(payload: bytes, audio=False, final=False):
    content = gzip.compress(payload)
    return bytes([0x11, 0x22 if final else (0x20 if audio else 0x10), 0x01 if audio else 0x11, 0]) + struct.pack('>I', len(content)) + content

def initial_packet():
    return packet(json.dumps({'user': {'uid': 'talentflow-interview'},
        'audio': {'format': 'pcm', 'codec': 'raw', 'rate': 16000, 'bits': 16, 'channel': 1},
        'request': {'model_name': 'bigmodel', 'enable_itn': True, 'enable_punc': True,
                    'show_utterances': True}}).encode())

def parse_packet(data):
    if not isinstance(data, bytes) or len(data) < 8:
        raise ValueError('Invalid ASR frame')
    offset = (data[0] & 15)*4
    kind, flags = data[1] >> 4, data[1] & 15
    if flags & 1:
        offset += 4
    if kind == 15:
        code = struct.unpack('>I', data[offset:offset+4])[0]
        raise ValueError(f'ASR provider code {code}')
    if kind != 9 or len(data) < offset + 4:
        raise ValueError('Unsupported ASR frame')
    size = struct.unpack('>I', data[offset:offset+4])[0]
    content = data[offset+4:]
    if size != len(content):
        raise ValueError('Truncated ASR frame')
    if data[2] & 15 == 1:
        content = gzip.decompress(content)
    result = json.loads(content)
    if result.get('code', 0) not in (0, 1000, 20000000):
        raise ValueError('ASR provider rejected request')
    return result, bool(flags & 2)

def connection(endpoint=None):
    return connect(endpoint or ENDPOINT, additional_headers={'X-Api-Key': get_key('doubao'),
        'X-Api-Resource-Id': RESOURCE, 'X-Api-Connect-Id': str(uuid.uuid4())},
        proxy=None, open_timeout=15, close_timeout=3, max_size=4*1024*1024)


def saved_audio_wait(size: int) -> float:
    """整段录音补转写最多等多久（秒）。实测耗时约为录音时长的四分之一，这里留出余量。"""
    return max(30.0, size / BYTES_PER_SECOND * 0.6 + 20)


async def transcribe_saved(pcm: bytes):
    """把已保存的整段录音交给语音服务转写，返回（文本，语音服务的原始结果）。"""
    if not pcm:
        raise ValueError('No audio to transcribe')
    link = await asyncio.to_thread(connection, SAVED_AUDIO_ENDPOINT)
    async with asyncio.timeout(saved_audio_wait(len(pcm))):
        async with link as remote:
            await remote.send(initial_packet())
            parse_packet(await remote.recv())
            step = BYTES_PER_SECOND // 5
            for offset in range(0, len(pcm), step):
                await remote.send(packet(pcm[offset:offset + step], audio=True))
            await remote.send(packet(b'', audio=True, final=True))
            async for frame in remote:
                data, final = parse_packet(frame)
                if final:
                    return (data.get('result') or {}).get('text', ''), data
    raise ValueError('No final ASR response')
