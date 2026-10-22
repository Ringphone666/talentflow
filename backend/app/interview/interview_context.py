"""Traceable resume context and timestamped speaker evidence, without identity inference."""
import hashlib
import json
import re
from pathlib import Path


def library_resume(person_id):
    """候选人在人员库中的简历文本（已脱敏，含人工核实后的内容）。未关联或未解析时返回 None。"""
    if not person_id:
        return None
    from matching_core.services import talent_library
    from matching_core.services.material_review import material_text
    try:
        entry = talent_library.get_entry(person_id)
    except KeyError:
        return None
    original = Path(entry.get('original_path') or '')
    size = original.stat().st_size if entry.get('original_path') and original.is_file() else 0
    if entry['status'] != '已解析':
        return {'status': 'processing' if entry['status'] == '待解析' else 'failed', 'text': '',
                'uploaded_at': entry['created_at'], 'source': entry['source_filename'], 'size': size}
    text = material_text(entry['parsed']) if entry['material_version'] else ''
    redacted = Path(entry.get('redacted_path') or '')
    if not text and redacted.is_file():
        text = redacted.read_text(encoding='utf-8', errors='ignore')
    return {'status': 'completed', 'text': text, 'uploaded_at': entry['created_at'], 'source': entry['source_filename'],
            'size': size}


def resume_context(candidate):
    linked = library_resume(getattr(candidate, 'library_person_id', None))
    status = linked['status'] if linked else getattr(candidate, 'resume_ocr_status', 'not_requested') or 'not_requested'
    raw = linked['text'] if linked else getattr(candidate, 'resume_ocr_text', '') or ''
    text = raw if status == 'completed' else ''
    # Keep experience evidence, exclude direct identifiers and unrelated personal attributes.
    name = getattr(candidate, 'name', '') or ''
    if name:
        text = text.replace(name, '[姓名已隐藏]')
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[邮箱已隐藏]', text)
    text = re.sub(r'(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)', '[电话已隐藏]', text)
    text = re.sub(r'(?<!\d)\d{17}[\dXx](?!\d)', '[证件号已隐藏]', text)
    text = '\n'.join(line for line in text.splitlines() if not re.search(r'(?:性别|民族|婚育|婚姻|宗教|身份证|家庭住址|出生日期)\s*[:：]', line))
    # Never silently claim a truncated resume was completely checked.
    limited = len(text) > 24000
    text = text[:24000]
    return {'status': 'ready' if text.strip() else status if status != 'completed' else 'empty',
            'text': text, 'truncated': limited, 'version': hashlib.sha256(raw.encode()).hexdigest() if raw else '',
            'uploaded_at': str((linked or {}).get('uploaded_at') or getattr(candidate, 'resume_uploaded_at', '') or ''),
            'source': '人员库' if linked else '面试候选人简历',
            'note': '仅核实与岗位有关的经历，不将简历自述直接作为得分证据。' + ('篇幅较长，仅分析前24000字，请人工核对全文。' if limited else '')}


def speaker_context(capture):
    """Join ASR timestamps to acoustic clusters; cluster IDs are not verified roles."""
    def parse(value):
        try:
            result = json.loads(value or '{}')
            return result if isinstance(result, dict) else {}
        except (ValueError, TypeError):
            return {}
    analysis = parse(capture.speaker_result)
    turns = analysis.get('turns', []) if capture.speaker_status == 'completed' else []
    safe_turns = []
    for turn in turns:
        try:
            start, end = float(turn['start_ms']), float(turn['end_ms'])
            if not (0 <= start < end):
                continue
            safe_turns.append({'cluster_id': str(turn.get('cluster_id', 'unknown')), 'start_ms': start, 'end_ms': end})
        except (KeyError, TypeError, ValueError):
            continue
    utterances = parse(capture.provider_result).get('result', {}).get('utterances', [])
    segments = []
    for item in utterances:
        try:
            start, end = float(item['start_time']), float(item['end_time'])
            text = str(item.get('text', '')).strip()
            if not text or text not in capture.transcript or not (0 <= start < end):
                continue
            overlaps = [(turn, max(0, min(end, turn['end_ms']) - max(start, turn['start_ms']))) for turn in safe_turns]
            clusters = sorted({turn['cluster_id'] for turn, duration in overlaps if duration > 0})
            segments.append({'text': text, 'start_ms': start, 'end_ms': end, 'clusters': clusters,
                             'role': '待人工核对', 'ambiguous': len(clusters) != 1})
        except (KeyError, TypeError, ValueError):
            continue
    return {'status': capture.speaker_status or 'not_requested', 'turns': safe_turns, 'segments': segments,
            'note': '声音分组不代表考官或候选人身份；结合上下文并人工核对。无对应时间戳时不得把某段文字强行归属某声音。'}
