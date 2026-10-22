"""chat-primary extraction with source-bound values and no silent rule fallback."""
import re
import json
import unicodedata

from matching_core.services.model_adapter import ExternalModelAdapter, ModelError, model_settings
from matching_core.services.parser import extract_minutes
from matching_core.services.privacy import redact_sensitive


def extract_job_with_ai(path, *, source_document=None):
    settings = model_settings()
    if settings['provider'] != 'external' or not settings['confirmed']:
        raise ValueError('chat-primary 尚未启用或配置未确认，请检查模型配置后重试。')
    document = source_document or extract_minutes(path, allow_ocr=True)
    text = redact_sensitive(document.text).text.strip()
    if not text:
        raise ValueError('文件没有可读取文字，请检查文件或 OCR 服务。')
    if len(text) > 24000:
        raise ValueError('岗位说明书超过24000字符，请按岗位拆分文件后重试。')
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    adapter = ExternalModelAdapter(settings['key'], settings['url'], 'chat-primary', settings['http_allowed'],
                                   max_tokens=4096, task='job_evidence')
    try:
        payload = json.dumps([{'id': i, 'text': line} for i, line in enumerate(lines)], ensure_ascii=False)
        output = adapter.analyze(payload, {})
        keys = {'metadata', 'responsibilities', 'requirements', 'hard_conditions', 'dimensions'}
        if set(output) != keys or not isinstance(output['metadata'], dict):
            raise ModelError('岗位提取结果格式不完整，请重试。')
        metadata_keys = {'name', 'sequence', 'level', 'jd_version'}
        if set(output['metadata']) != metadata_keys:
            raise ModelError('岗位基本信息格式不正确，请重试。')
        warnings = [document.warning] if document.warning else []
        # Classifying a long JD in one response can omit entry requirements.
        # Review the complete source independently, including when some were found.
        reviewer = ExternalModelAdapter(settings['key'], settings['url'], 'chat-primary', settings['http_allowed'],
                                        max_tokens=2048, task='job_hard_conditions')
        try:
            review = reviewer.analyze(payload, {})
            conditions = review.get('hard_conditions')
            if set(review) != {'hard_conditions'} or not isinstance(conditions, list) or len(conditions) > 80:
                raise ModelError('硬性条件复核结果格式无效。')
            output['hard_conditions'] = conditions
        except ModelError:
            warnings.append('硬性条件专项核对未完成，已保留初次提取结果，请对照原文检查或重新提取。')
        labels = {'name': '岗位名称', 'sequence': '岗位类别', 'level': '职级', 'jd_version': '版本',
                  'responsibilities': '岗位职责', 'requirements': '任职要求', 'hard_conditions': '硬性条件', 'dimensions': '评分维度'}

        def normalized(value):
            return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))

        def original_value(value):
            if not isinstance(value, str) or len(value) > 4000:
                return None
            value = value.strip()
            if not value:
                return ''
            if settings['key'] and settings['key'] in value:
                return None
            # Return original text even if the model normalized spaces/full-width punctuation.
            needle = normalized(value)
            for line in lines:
                chars, offsets = [], []
                for index, char in enumerate(line):
                    for normalized_char in unicodedata.normalize('NFKC', char):
                        if not normalized_char.isspace():
                            chars.append(normalized_char)
                            offsets.append(index)
                start = ''.join(chars).find(needle)
                if start >= 0 and needle:
                    return line[offsets[start]:offsets[start + len(needle) - 1] + 1]
            return None

        metadata = {}
        for key, value in output['metadata'].items():
            verified = original_value(value)
            metadata[key] = verified or ''
            if verified is None:
                warnings.append(f'{labels[key]}未能与原文对应，已留空，请核对补充。')
        parsed = {}
        explicit_weights = {}
        for key in keys - {'metadata'}:
            values = output[key]
            if not isinstance(values, list) or len(values) > 80:
                raise ModelError('岗位提取条目格式不正确，请重试。')
            accepted, rejected = [], 0
            for value in values:
                if key == 'hard_conditions' and isinstance(value, dict):
                    # A table row may mix a mandatory degree with a preferred
                    # specialty. Accept the cited clause, not the entire row.
                    ids = value.get('evidence_ids')
                    verified = original_value(value.get('text'))
                    if (not verified or not isinstance(ids, list) or not ids
                            or any(type(i) is not int or not 0 <= i < len(lines) for i in ids)
                            or not any(normalized(verified) in normalized(lines[i]) for i in ids)):
                        rejected += 1
                    else:
                        accepted.append(verified)
                    continue
                if key == 'dimensions' and isinstance(value, dict):
                    name, ids = value.get('name'), value.get('evidence_ids')
                    if not isinstance(ids, list) or not ids or any(type(i) is not int or not 0 <= i < len(lines) for i in ids):
                        rejected += 1
                        continue
                    cited = '\n'.join(lines[i] for i in ids)
                    verified = original_value(name)
                    if not verified or normalized(verified) not in normalized(cited):
                        rejected += 1
                        continue
                    keywords = value.get('keywords', [])
                    if not isinstance(keywords, list):
                        keywords = []
                    keywords = [v for k in keywords if (v := original_value(k)) and normalized(v) in normalized(cited)]
                    accepted.append({'name': verified, 'keywords': keywords or [verified]})
                    weight = value.get('weight')
                    if type(weight) in (int, float) and 0 <= weight <= 100:
                        numbers = re.findall(r'(?<![\d.])\d+(?:\.\d+)?(?![\d.])', unicodedata.normalize('NFKC', cited))
                        if any(float(number) == weight for number in numbers):
                            explicit_weights[verified] = float(weight)
                    continue
                if type(value) is int and 0 <= value < len(lines):
                    verified = lines[value]
                else:
                    # Accept exact original strings from aliases that ignore the ID schema.
                    verified = original_value(value) if isinstance(value, str) else None
                if verified:
                    accepted.append(verified)
                elif verified is None:
                    rejected += 1
            parsed[key] = accepted if key == 'dimensions' else list(dict.fromkeys(accepted))
            if rejected:
                warnings.append(f'{labels[key]}有{rejected}项无法对应原文，已排除；其余内容保留，请对照原文补齐。')
        if not any(metadata.values()) and not any(parsed.values()):
            raise ModelError('未识别到可核对的岗位信息，请重试。')
        parsed['dimensions'] = [name if isinstance(name, dict) else {'name': name, 'keywords': [name]} for name in parsed['dimensions']]
        parsed['weights'] = explicit_weights
        return dict(parsed, metadata=metadata, warning='；'.join(warnings), status='chat-primary 提取完成，待人工确认',
                    extraction_model='chat-primary', source_text=text)
    except ModelError as exc:
        raise ValueError('chat-primary 提取未完成：' + str(exc)) from None


def extract_jobs_with_ai(path):
    """Detect non-overlapping role sections, then extract each in isolation."""
    import json
    from matching_core.services.parser import ExtractedDocument
    settings = model_settings()
    if settings['provider'] != 'external' or not settings['confirmed']:
        raise ValueError('chat-primary 尚未启用或配置未确认，请检查模型配置后重试。')
    document = extract_minutes(path, allow_ocr=True)
    lines = [line.strip() for line in redact_sensitive(document.text).text.splitlines() if line.strip()]
    if not lines:
        raise ValueError('文件没有可读取文字，请检查文件或 OCR 服务。')
    text = json.dumps([{'id': i, 'text': line} for i, line in enumerate(lines)], ensure_ascii=False)
    if len(text) > 100000:
        raise ValueError('此文档超过本次提取长度限制，请拆成多个文件同时上传。')
    adapter = ExternalModelAdapter(settings['key'], settings['url'], 'chat-primary', settings['http_allowed'], max_tokens=4096, task='job_detection')
    try:
        anchors = [i for i, line in enumerate(lines) if re.match(r'^岗位名称\s*(?:[|｜:：])', line)]
        if len(anchors) > 1:
            # Explicit title rows give reliable, complete boundaries for repeated JD tables.
            sections = [{'start': start, 'end': anchors[i + 1] - 1 if i + 1 < len(anchors) else len(lines) - 1}
                        for i, start in enumerate(anchors)]
        else:
            output = adapter.analyze(text, {})
            sections = output.get('jobs')
        if not isinstance(sections, list) or not 1 <= len(sections) <= 50:
            raise ModelError('未识别到有效岗位，或文档岗位数超过50个，请核对文件。')
        previous_end = -1
        for section in sections:
            if not isinstance(section, dict):
                raise ModelError('岗位分段格式无效，请重试。')
            start, end = section.get('start'), section.get('end')
            if type(start) is not int or type(end) is not int or not previous_end < start <= end < len(lines):
                raise ModelError('岗位分段范围无效或重叠，请重试。')
            previous_end = end
        results = []
        for index, section in enumerate(sections, 1):
            part = '\n'.join(lines[section['start']:section['end'] + 1])
            try:
                parsed = extract_job_with_ai(path, source_document=ExtractedDocument(part, [], document.status, document.warning))
                results.append({'index': index, 'parsed': parsed, 'error': ''})
            except ValueError as exc:
                results.append({'index': index, 'parsed': None, 'error': str(exc)})
        return results
    except ModelError as exc:
        raise ValueError('chat-primary 岗位识别未完成：' + str(exc)) from None
