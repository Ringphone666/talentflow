"""Generate editable, evidence-linked scorecard suggestions for a single job."""
import json
import math

from matching_core.services.model_adapter import ExternalModelAdapter, ModelError, model_settings
from matching_core.services.privacy import redact_sensitive
from matching_core.services.scoring import validate_weights


def generate_job_scorecard(job):
    settings = model_settings()
    if settings['provider'] != 'external' or not settings['confirmed']:
        raise ValueError('评分建议生成服务尚未启用，请检查模型配置。')
    evidence = [str(value).strip() for key in ('responsibilities', 'requirements') for value in job.get(key, []) if str(value).strip()]
    if not evidence:
        raise ValueError('缺少岗位职责和任职要求，无法生成有依据的评分建议。')
    existing = job.get('dimensions', [])
    existing_weights = job.get('weights', {})
    payload = redact_sensitive(json.dumps({'name': job.get('name', ''), 'existing_dimensions': existing, 'existing_weights': existing_weights, 'evidence': [{'id': i, 'text': value} for i, value in enumerate(evidence)]}, ensure_ascii=False)).text
    if len(payload) > 30000:
        raise ValueError('岗位要求过长，请精简后重试评分建议。')
    adapter = ExternalModelAdapter(settings['key'], settings['url'], 'chat-primary', settings['http_allowed'], max_tokens=4096, task='job_scorecard')
    try:
        output = adapter.analyze(payload, {})
        rows = output.get('dimensions')
        if not isinstance(rows, list) or (len(rows) != len(existing) if existing else not 3 <= len(rows) <= 6):
            raise ModelError('评分建议格式不正确，请重试。')
        dimensions, weights, basis = [], {}, []
        for row in rows:
            if not isinstance(row, dict):
                raise ModelError('评分建议条目格式不正确。')
            name, weight, keywords = row.get('name'), row.get('weight'), row.get('keywords')
            reason, ids = row.get('reason'), row.get('evidence_ids')
            if not isinstance(name, str) or not name.strip() or len(name) > 60 or name.strip() in weights:
                raise ModelError('评分维度名称无效或重复，请重试。')
            if type(weight) not in (int, float) or not math.isfinite(weight) or not 0 < weight <= 100:
                raise ModelError('评分权重无效，请重试。')
            # Counts in the prompt are presentation guidance. Additional valid
            # keywords or citations must not discard the entire job's draft.
            if not isinstance(keywords, list) or not 1 <= len(keywords) <= 32 or any(not isinstance(k, str) or not k.strip() or len(k) > 80 for k in keywords):
                raise ModelError('评分证据关键词无效，请重试。')
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 400:
                raise ModelError('评分建议缺少依据，请重试。')
            if not isinstance(ids, list) or not 1 <= len(ids) <= 80 or any(type(i) is not int or not 0 <= i < len(evidence) for i in ids):
                raise ModelError('评分建议引用的岗位依据无效，请重试。')
            if settings['key'] and settings['key'] in json.dumps(row, ensure_ascii=False):
                raise ModelError('评分建议包含无效内容，未采用。')
            name = name.strip()
            dimensions.append({'name': name, 'keywords': list(dict.fromkeys(k.strip() for k in keywords)), 'negative_keywords': []})
            weights[name] = float(weight)
            basis.append({'dimension': name, 'reason': reason.strip(), 'evidence': [evidence[i] for i in dict.fromkeys(ids)]})
        validate_weights(weights)
        if existing:
            if set(weights) != {d['name'] for d in existing} or any(weights.get(name) != value for name, value in existing_weights.items()):
                raise ModelError('生成结果改动了原文评分标准，请重试。')
            # Keep source keywords and the original dimension order.
            generated = {d['name']: d for d in dimensions}
            dimensions = [dict(generated[d['name']], **d) for d in existing]
        return {'dimensions': dimensions, 'weights': weights, 'basis': basis}
    except ModelError as exc:
        raise ValueError('评分建议生成未完成：' + str(exc)) from None
