"""Evidence-grounded model assessment; weights and totals remain deterministic."""
import json
import math
import re
from datetime import datetime

from matching_core.services.model_adapter import ExternalModelAdapter, ModelError, model_settings
from matching_core.services.privacy import redact_sensitive, contains_unmasked_sensitive
from matching_core.services.scoring import validate_weights, summarize_ai_score
from matching_core.services.reasoning import EXCLUDED
from matching_core.services.material_review import effective_material_evidence, material_value


def _has_excluded_personal_content(text):
    # Job experience mentioning telephone work or household products is not a
    # personal contact/family field. Keep the rest of the conservative filter.
    for phrase in ('电话沟通', '电话邀约', '电话销售', '电话回访', '电话面试', '电话客服', '家庭用品', '家庭清洁用品'):
        text = text.replace(phrase, '')
    return any(word in text for word in EXCLUDED)


def _evidence_ids(raw, evidence):
    """Normalize representation only; never shift or substitute a citation."""
    if not isinstance(raw, list):
        raise ModelError('评分证据编号必须为数组', 'SCORING_EVIDENCE', True)
    ids, changes = [], []
    for value in raw:
        if isinstance(value, str) and re.fullmatch(r'[0-9]{1,10}', value.strip()):
            value = int(value.strip())
            changes.append('numeric_string')
        if type(value) is not int or not 0 <= value < len(evidence):
            # Even a valid prefix cannot justify ignoring a fabricated citation.
            raise ModelError('评分证据编号无效', 'SCORING_EVIDENCE', True)
        if value not in ids:
            ids.append(value)
        else:
            changes.append('duplicate_reference')
    if len(ids) > 3:
        changes.append('reference_limit')
    return ids[:3], sorted(set(changes))


def _validate_row(item, key, evidence, secret):
    status, reason = item.get('status'), item.get('reason')
    statuses = ('已评估', '待核实') if key == 'dimensions' else ('满足', '不满足', '无法确认')
    if status not in statuses:
        raise ModelError('评分状态不符合岗位标准', 'SCORING_SCHEMA', True)
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 600:
        raise ModelError('缺少有效评分理由', 'SCORING_REASON', True)
    if contains_unmasked_sensitive(reason) or (secret and secret in reason) or _has_excluded_personal_content(reason):
        raise ModelError('评分理由包含不适当信息，未采用', 'SCORING_PRIVACY', True)
    ids, changes = _evidence_ids(item.get('evidence_ids'), evidence)
    unknown = status in ('待核实', '无法确认')
    if not unknown and not ids:
        raise ModelError('已评估项目缺少原文证据', 'SCORING_EVIDENCE', True)
    value = item.get('score') if key == 'dimensions' else None
    if key == 'dimensions':
        if unknown and value is not None:
            raise ModelError('待核实维度不能提供分数', 'SCORING_SCORE', True)
        if not unknown and (type(value) not in (float, int) or not math.isfinite(value) or not 0 <= value <= 100):
            raise ModelError('维度分数必须在0至100之间', 'SCORING_SCORE', True)
    return dict(status=status, reason=reason.strip(), score=value, evidence=[evidence[i] for i in ids]), changes


def _review_assessment(output, job, evidence, secret=''):
    """Keep independently valid rows; diagnostics contain no generated text."""
    review = {'dimensions': {}, 'hard_checks': {}, 'issues': [], 'normalizations': []}
    def issue(key, name, exc):
        review['issues'].append(dict(section=key, name=name, code=exc.code, reason=str(exc)))
    if not isinstance(output, dict) or set(output) - {'dimensions', 'hard_checks', 'analysis'}:
        issue('assessment', '', ModelError('评分结构不完整', 'SCORING_SCHEMA', True))
        return review
    for key, names in (('dimensions', list(job['weights'])),
                       ('hard_checks', [h['name'] for h in job.get('hard_conditions', [])])):
        rows = output.get(key)
        if not isinstance(rows, list):
            issue(key, '', ModelError('评分项目必须为数组', 'SCORING_SCHEMA', True))
            continue
        if any(not isinstance(row, dict) or row.get('name') not in names for row in rows):
            issue(key, '', ModelError('评分名称不符合岗位标准', 'SCORING_SCHEMA', True))
        for name in names:
            matches = [row for row in rows if isinstance(row, dict) and row.get('name') == name]
            try:
                if len(matches) != 1:
                    raise ModelError('评分项目缺失或名称重复', 'SCORING_SCHEMA', True)
                item, changes = _validate_row(matches[0], key, evidence, secret)
                review[key][name] = item
                if changes:
                    review['normalizations'].append(dict(section=key, name=name, changes=changes))
            except ModelError as exc:
                issue(key, name, exc)
    return review


def validate_assessment(output, job, evidence, secret=''):
    review = _review_assessment(output, job, evidence, secret)
    if review['issues']:
        issue = review['issues'][0]
        raise ModelError(issue['reason'], issue['code'], True)
    return review['dimensions'], review['hard_checks']


def _correction_feedback(review, job, evidence):
    return json.dumps({
        'instruction': '上一回复未通过本地校验。按下列反馈重新输出完整JSON；只引用已有证据，不补造经历或分数。'
                       '逐字使用evidence.id，不改用页码或原文行号，不将编号加1或减1。无法支持的维度返回score:null、status:待核实；'
                       '无法支持的硬性条件返回status:无法确认。不要回显任何敏感个人信息。',
        'valid_evidence_ids': list(range(len(evidence))),
        'dimension_names': list(job['weights']),
        'hard_condition_names': [h['name'] for h in job.get('hard_conditions', [])],
        'errors': review['issues'],
        'schema': {'dimensions': [{'name': '维度原名', 'score': '0至100数字或null', 'status': '已评估或待核实',
                                    'reason': '依据说明', 'evidence_ids': '0至3个合法整数；已评估至少1个'}],
                   'hard_checks': [{'name': '硬性条件原名', 'status': '满足、不满足或无法确认',
                                    'reason': '依据说明', 'evidence_ids': '0至3个合法整数；满足或不满足至少1个'}]},
    }, ensure_ascii=False)


def validate_analysis(output, evidence, secret=''):
    """Optional richer commentary shares the scoring call and local citations."""
    if not isinstance(output, dict):
        raise ModelError('综合分析格式错误')
    analysis = output.get('analysis')
    if analysis is None:
        return {}
    allowed = {'strengths', 'gaps', 'risks', 'verification', 'questions'}
    if not isinstance(analysis, dict) or set(analysis) - allowed:
        raise ModelError('综合分析格式错误')
    sections = {}
    for key, items in analysis.items():
        if not isinstance(items, list) or len(items) > 3:
            raise ModelError('综合分析条目格式错误')
        sections[key] = []
        for item in items:
            if not isinstance(item, dict):
                raise ModelError('综合分析条目格式错误')
            content, ids = item.get('text'), item.get('evidence_ids')
            if not isinstance(content, str) or not content.strip() or len(content) > 400:
                raise ModelError('综合分析正文格式错误')
            if contains_unmasked_sensitive(content) or (secret and secret in content) or _has_excluded_personal_content(content):
                raise ModelError('综合分析含不适当信息，未采用')
            ids, _ = _evidence_ids(ids, evidence)
            if not ids:
                raise ModelError('综合分析缺少有效原文依据')
            sections[key].append({'text': content.strip(), 'evidence': [evidence[i] for i in dict.fromkeys(ids)]})
    return sections


def add_ai_score(score, parsed, job):
    config = model_settings()
    model = config['reasoning_model']
    recovery = dict(status='not_needed', attempted=False, corrected=False, pending_dimensions=[],
                    pending_hard_conditions=[], analysis_discarded=False, normalizations=[])
    state = dict(model=model, status='未成功', reason='AI评分尚未完成', sections={}, recovery=recovery, retryable=True)
    # Never silently fall back to keyword scores when the model is unavailable.
    score.update(scoring_method='ai_semantic_v1', total=None, assessment_status='待评估',
                 score_source='AI按岗位标准逐项评估，系统按岗位权重汇总',
                 formula='综合匹配度 = Σ（已评估维度得分 × 岗位权重）÷ 100；待核实维度暂未形成得分贡献',
                 dimensions=[dict(dimension=n, weight=float(w), score=None, weighted=None,
                                  evidence_available=False, reason='等待AI评估', evidence=[]) for n,w in job['weights'].items()],
                 hard_checks=[dict(condition=h['name'], status='无法确认', evidence='等待AI核验') for h in job.get('hard_conditions', [])],
                 strengths=[], gaps=['评分尚未完成'], mismatch_reasons=[], pending_count=len(job['weights']),
                 risks=['待人工核验'], ai_suggestion='AI评分未完成，请重试；不使用关键词分数代替。',
                 unassessed_dimensions=list(job['weights']), reasoning_analysis=state,
                 job_weight_version=job.get('weight_version'), assessed_at=datetime.now().astimezone().isoformat())
    try:
        if config['provider'] != 'external' or not config['confirmed']:
            raise ModelError('AI评分服务未配置或未确认')
        validate_weights(job['weights'])
        if not job['weights']:
            raise ModelError('岗位尚未配置评分标准')
        evidence = [{**{k: redact_sensitive(str(e.get(k, ''))).text for k in ('text', 'file', 'location')},
                     **({'origin': 'human_review', 'field_key': str(e.get('field_key', ''))} if e.get('origin') == 'human_review' else {})}
                    for e in effective_material_evidence(parsed) if e.get('text') and not _has_excluded_personal_content(e['text'])]
        if not evidence:
            raise ModelError('没有可用于评分的脱敏证据')
        payload = {'job': {k: job[k] for k in ('name', 'responsibilities', 'requirements', 'dimensions', 'weights', 'hard_conditions') if k in job},
                   'evidence': [{'id': i, 'text': e['text'], 'origin': e.get('origin', 'document')} for i,e in enumerate(evidence)]}
        corrections = [{'field': key, 'label': field.get('label', key), 'cleared': not bool(material_value(field.get('value')))}
                       for key, field in parsed.get('fields', {}).items() if field.get('manual_modified')]
        if corrections:
            payload['manual_corrections'] = corrections
        text = redact_sensitive(json.dumps(payload, ensure_ascii=False)).text
        if len(text) > 24000:
            raise ModelError('评分材料超过24000字符，请精简后重试')
        adapter = ExternalModelAdapter(config['key'], config['url'], model, config['http_allowed'],
                                       max_tokens=config['reasoning_max_tokens'], task='candidate_scoring')
        reviews, outputs = [], []
        def review_output(output):
            review = _review_assessment(output, job, evidence, config['key'])
            reviews.append(review)
            outputs.append(output)
            if review['issues']:
                adapter.correction_feedback = _correction_feedback(review, job, evidence)
                issue = review['issues'][0]
                raise ModelError(issue['reason'], issue['code'], True)
        adapter.response_validator = review_output
        last_error = None
        try:
            output = adapter.analyze(text, {})
            # Keep the validation boundary when an alternate adapter implements
            # analyze without the transport's response hook (including tests).
            if not reviews:
                review_output(output)
        except ModelError as exc:
            last_error = exc
            if not reviews:
                raise
        dims, hard = {}, {}
        for review in reviews:
            # A correction only fills rejected rows; it cannot silently replace
            # a dimension which already passed local validation.
            for name, item in review['dimensions'].items():
                dims.setdefault(name, item)
            for name, item in review['hard_checks'].items():
                hard.setdefault(name, item)
            recovery['normalizations'].extend(review['normalizations'])
        recovery['attempted'] = bool(adapter.diagnostics.get('correction_attempted'))
        recovery['pending_dimensions'] = [name for name in job['weights'] if name not in dims]
        recovery['pending_hard_conditions'] = [h['name'] for h in job.get('hard_conditions', []) if h['name'] not in hard]
        initial_missing = len(job['weights']) - len(reviews[0]['dimensions']) + len(job.get('hard_conditions', [])) - len(reviews[0]['hard_checks'])
        remaining = len(recovery['pending_dimensions']) + len(recovery['pending_hard_conditions'])
        recovery['corrected'] = remaining < initial_missing
        adapter.diagnostics['validation_codes'] = sorted({issue['code'] for review in reviews for issue in review['issues']})
        accepted_rows = {'dimensions': dims, 'hard_checks': hard}
        unresolved = [issue for issue in reviews[-1]['issues'] if issue['name'] not in accepted_rows.get(issue['section'], {})]
        if len(reviews) > 1 and reviews[0]['issues'] and not unresolved:
            recovery['corrected'] = True
        incomplete_response = bool(last_error and (unresolved or not last_error.code.startswith('SCORING_')))
        adapter.diagnostics['error_code'] = last_error.code if last_error and (remaining or incomplete_response) else ''
        if not dims:
            raise last_error or ModelError('全部评分维度未通过校验，请重试', 'SCORING_SCHEMA', True)
        for name in recovery['pending_dimensions']:
            dims[name] = dict(status='待核实', score=None, evidence=[],
                              reason='本项AI结果未通过证据或格式校验，已暂缓评分；请重试或人工核验。')
        for name in recovery['pending_hard_conditions']:
            hard[name] = dict(status='无法确认', score=None, evidence=[],
                              reason='本项AI核验结果未通过证据或格式校验；请重试或人工核验。')
        # Rich commentary is optional: a rejected paragraph must not erase the
        # independently validated scoring rows.
        rich_sections = {}
        try:
            rich_sections = validate_analysis(outputs[-1], evidence, config['key'])
        except ModelError:
            recovery['analysis_discarded'] = True
            adapter.diagnostics['analysis_error_code'] = 'SCORING_ANALYSIS'
        recovery['status'] = ('partial' if remaining or incomplete_response else 'corrected' if recovery['corrected'] else
                              'normalized' if recovery['normalizations'] else 'analysis_omitted' if recovery['analysis_discarded'] else 'not_needed')
        sections = {'strengths': [], 'gaps': [], 'risks': [], 'questions': []}
        for d in score['dimensions']:
            item = dims[d['dimension']]
            d.update(score=item['score'], reason=item['reason'], evidence=item['evidence'],
                     evidence_available=item['status'] == '已评估', status=item['status'],
                     weighted=round(item['score']*d['weight']/100, 2) if item['score'] is not None else None)
            category = 'questions' if item['score'] is None else 'strengths' if item['score'] >= 75 else 'gaps'
            sections[category].append({'text': d['dimension'] + '：' + item['reason'], 'evidence': item['evidence']})
        missing = [d['dimension'] for d in score['dimensions'] if d['weight'] > 0 and d['score'] is None]
        score['hard_checks'] = [dict(condition=h['name'], status=hard[h['name']]['status'], evidence=hard[h['name']]['reason'],
                                    sources=hard[h['name']]['evidence']) for h in job.get('hard_conditions', [])]
        score.update(assessment_status='待补充材料' if missing else 'AI已评分', unassessed_dimensions=missing,
                     pending_count=len(missing)+sum(h['status']=='无法确认' for h in hard.values()),
                     strengths=[i['text'] for i in sections['strengths']], gaps=[i['text'] for i in sections['gaps']],
                     mismatch_reasons=[i['text'] for i in sections['gaps']],
                     risks=[name+'：'+h['reason'] for name,h in hard.items() if h['status']!='满足'] or ['评分待人工复核'],
                     ai_suggestion='部分维度待补充材料；综合分仅体现已确认的岗位权重贡献。' if missing else '总分来自下列AI维度评分和岗位权重；请核验原文及硬性条件后决定下一步。')
        reason = ('部分项目未通过校验，已保留有效评分，其余项目待核实；可重新分析。' if remaining else
                  '已保留有效评分；纠正请求未完整通过校验，可重新分析。' if incomplete_response else
                  '已自动纠正评分格式或证据引用，总分由系统按岗位权重计算。' if recovery['corrected'] or recovery['normalizations'] else
                  '评分与证据已通过本地校验，总分由系统按岗位权重计算。')
        if recovery['analysis_discarded']:
            reason += '附加综合分析未通过校验，已使用有效评分生成核验建议。'
        state.update(status='调用成功', reason=reason, sections=sections,
                     comprehensive_sections=rich_sections,
                     diagnostics=adapter.diagnostics)
        score.pop('requires_reassessment', None)
    except (ModelError, ValueError) as exc:
        state['reason'] = str(exc)
        state['diagnostics'] = {**(adapter.diagnostics if 'adapter' in locals() else {}), 'error_code': getattr(exc, 'code', 'VALIDATION')}
        recovery['status'] = 'failed'
        recovery['attempted'] = bool(state['diagnostics'].get('correction_attempted'))
    return summarize_ai_score(score)
