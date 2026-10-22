from __future__ import annotations

import math
from typing import Any


def _number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def _summarize_dimensions(score: dict, *, ai: bool) -> dict:
    """Use the whole scorecard as denominator; unknown ability stays unknown."""
    dimensions = score.get('dimensions', [])
    weighted = [d for d in dimensions if (_number(d.get('weight')) or 0) > 0]
    failed = ai and score.get('reasoning_analysis', {}).get('status') not in (None, '', '调用成功')
    assessed = [d for d in dimensions if _number(d.get('score')) is not None and
                0 <= d['score'] <= 100 and d.get('evidence_available', True)] if not failed else []
    known = [d for d in weighted if d in assessed]
    coverage = round(sum(d['weight'] for d in known), 1)
    contribution = sum(d['score'] * d['weight'] / 100 for d in known)
    for d in dimensions:
        available = d in assessed
        d['evidence_available'] = available
        d['weighted'] = round(d['score'] * (_number(d.get('weight')) or 0) / 100, 2) if available else None
    score.update(
        total=round(contribution, 1) if known else None,
        assessed_score=round(contribution * 100 / coverage, 1) if coverage else None,
        coverage_percent=coverage,
        unassessed_dimensions=[d['dimension'] for d in weighted if d not in known],
        assessment_status=('AI已评分' if ai else '规则参考分') if coverage >= 99.99 else
                          ('待补充材料' if known else '待评估'),
        score_basis='whole_job_weighted_v2',
        formula='综合匹配度 = Σ（已评估维度得分 × 该维度岗位权重）÷ 100；未评估部分暂未形成得分贡献，不等于能力为零',
    )
    if not known:
        score['ai_suggestion'] = '评分尚未完成，请重试评估。' if failed else '当前没有可评估的相关证据，请补充岗位相关材料。'
    elif coverage < 99.99:
        score['ai_suggestion'] = f'当前材料支持的综合匹配度为{score["total"]:g}分；仍有{100-coverage:g}%岗位权重待补充证据，不能据此认定能力不足。'
    else:
        score['ai_suggestion'] = '综合匹配度按完整岗位权重计算；结合维度依据、硬性条件和人工复核决定下一步。'
    return score


def summarize_ai_score(score):
    if score.get('scoring_method') != 'ai_semantic_v1':
        return score
    return _summarize_dimensions(score, ai=True)


def annotate_score_evidence(score: dict, tags: list[dict]) -> dict:
    """Separate missing rule evidence from a measured zero, including old records."""
    if score.get("scoring_method") == "ai_semantic_v1":
        return summarize_ai_score(score)
    covered = {t.get('dimension') for t in tags
               if str(t.get('evidence') or '').strip() not in ('', '无充分证据')}
    dimensions = score.get('dimensions', [])
    for item in dimensions:
        item['evidence_available'] = item['dimension'] in covered
        if not item['evidence_available']:
            item['score'] = None
    weighted = [d for d in dimensions if float(d.get('weight', 0)) > 0]
    available = any(d['evidence_available'] for d in weighted)
    score['score_source'] = '岗位关键词命中与岗位权重；不是AI语义评分或录用概率'
    _summarize_dimensions(score, ai=False)
    if available and score['unassessed_dimensions']:
        missing = set(score['unassessed_dimensions'])
        score['gaps'] = [d for d in score.get('gaps', []) if d not in missing] or ['部分维度缺少证据，需补充核验']
        score['mismatch_reasons'] = [reason for reason in score.get('mismatch_reasons', [])
                                     if not any(reason.startswith(d) for d in missing)]
        score['ai_suggestion'] = '当前为部分证据下的规则参考分；未命中维度不能直接判定为能力不足，请结合AI分析和原文补充核验。'
    if not available:
        score['strengths'] = ['规则未识别到可计分证据，请结合AI分析核验']
        score['gaps'] = ['评分依据不足，暂不能判断能力差距']
        score['mismatch_reasons'] = ['岗位关键词未命中，不代表候选人完全不匹配']
        score['ai_suggestion'] = '当前缺少可计分证据，暂不提供匹配分数。请核对岗位评分关键词及简历原文，并结合下方AI分析人工复核。'
    return score


def score_value(score: dict):
    summarize_ai_score(score)
    return None if score.get('assessment_status') in ('待评估', '待核实') else _number(score.get('total'))


def score_sort_key(score):
    value = score_value(score)
    coverage = score.get('coverage_percent', 100 if value is not None else 0)
    return (value is not None, value if value is not None else -1, coverage)


def score_label(score: dict) -> str:
    value = score_value(score)
    return score.get('assessment_status', '待评估') if value is None else f'{value:.1f}'


def assessment_summary_data(score: dict, job: dict | None = None) -> dict:
    """Shared evidence-grounded assessment for both workflows and their reports.

    No model call or saved data mutation is needed: historical scores receive
    the same whole-job calculation when decoded. Analysis uses only the stored
    assessed dimensions and hard-condition findings, never demo scenarios.
    """
    value = score_value(score)
    dimensions = [d for d in score.get('dimensions', []) if (_number(d.get('weight')) or 0) > 0]
    known = [d for d in dimensions if d.get('evidence_available', _number(d.get('score')) is not None)
             and _number(d.get('score')) is not None]
    missing = [d for d in dimensions if d not in known]
    coverage = score.get('coverage_percent', sum(d['weight'] for d in known))
    stale = bool(score.get('requires_reassessment'))
    failed = score.get('scoring_method') == 'ai_semantic_v1' and score.get('reasoning_analysis', {}).get('status') not in (None, '', '调用成功')
    hard_failed = [h for h in score.get('hard_checks', []) if h.get('status') == '不满足']
    hard_unknown = [h for h in score.get('hard_checks', []) if h.get('status') not in ('满足', '不满足')]
    strengths, gaps, risks, verification, questions = [], [], [], [], []

    for d in sorted(known, key=lambda item: (item['score'], item['weight']), reverse=True):
        name = d['dimension']
        reason = str(d.get('reason') or '').strip()
        detail = f'{name}：{reason}' if reason else f'{name}：已评估{d["score"]:g}分，占岗位权重{d["weight"]:g}%'
        (strengths if d['score'] >= 75 else gaps).append(detail)
        if d['score'] < 75:
            verification.append(f'{name}：核对相关项目职责、本人贡献及可验证结果。')
            questions.append(f'请结合真实经历说明你在“{name}”方面做过什么、承担哪些职责，以及如何验证结果？')
    for d in sorted(missing, key=lambda item: item['weight'], reverse=True):
        name = d['dimension']
        gaps.append(f'待核实 · {name}：{d.get("reason") or "现有材料尚不足以评估"}；补充依据前不判断能力差距。')
        verification.append(f'{name}（岗位权重{d["weight"]:g}%）：补充相关经历或工作样例后评估。')
        questions.append(f'关于“{name}”，请提供最相关的工作实例、你的具体行动及结果；若暂无直接经历，请说明可迁移的经验。')
    for h in hard_failed:
        detail = f'{h["condition"]}：{h.get("evidence") or "现有材料显示不满足，需人工核对"}'
        risks.append('硬性条件差距 · ' + detail)
        verification.append('核验硬性条件 · ' + detail)
        questions.append(f'岗位要求“{h["condition"]}”，现有材料显示差距；是否有补充证明或需更正的信息？')
    for h in hard_unknown:
        detail = f'{h["condition"]}：{h.get("evidence") or "现有材料无法确认"}'
        risks.append('硬性条件待核实 · ' + detail)
        verification.append('补充任职资格证明 · ' + detail)
        questions.append(f'请提供可以核实“{h["condition"]}”的材料或说明。')
    if missing and not failed:
        risks.append(f'{len(missing)}项维度、合计{max(0, 100-coverage):g}%岗位权重尚未形成评估依据；当前综合分仍可能随补充材料变化。')
    if failed:
        risks.append('AI评分未完成：' + str(score.get('reasoning_analysis', {}).get('reason') or '请检查服务后重试'))
    last_attempt = score.get('reasoning_analysis', {}).get('last_attempt') or score.get('last_attempt')
    if isinstance(last_attempt, dict) and last_attempt.get('status') not in (None, '', '调用成功'):
        risks.append('最近一次重新分析未成功，当前展示上次成功结果：' + str(last_attempt.get('reason') or '请重试'))
    if stale:
        risks.append(str(score.get('reassessment_reason') or '候选人资料已变更') + '，当前分数与分析对应上次评估，请重新分析后再复核。')
    for risk in score.get('risks', []):
        text = str(risk).strip()
        if text and ('冲突' in text or '需人工确认' in text) and text not in risks:
            risks.append(text)
    rich = score.get('reasoning_analysis', {}).get('comprehensive_sections', {}) if not failed else {}
    for key, target in (('strengths', strengths), ('gaps', gaps), ('risks', risks),
                        ('verification', verification), ('questions', questions)):
        validated = [item['text'] for item in rich.get(key, []) if isinstance(item, dict)
                     and isinstance(item.get('text'), str) and item.get('evidence')]
        if validated:
            target[:0] = validated
    if not verification and known:
        for d in sorted(known, key=lambda item: item['weight'], reverse=True)[:2]:
            verification.append(f'{d["dimension"]}：核验已引用经历中的本人职责、工作样例及实际结果。')
    if not questions and known:
        for d in sorted(known, key=lambda item: item['weight'], reverse=True)[:2]:
            questions.append(f'请用一个与“{d["dimension"]}”相关的真实项目，说明你的任务、具体行动、个人贡献和可核实的结果。')

    if stale:
        conclusion = '资料已变更，待重新分析'
        next_step = '按最新资料重新分析，确认评分依据后再进行人工复核和报告导出。'
    elif value is None:
        conclusion = '评分未完成' if failed else '待补充材料'
        next_step = '检查评分服务并重试，再核对维度依据。' if failed else '补充与岗位职责相关的材料后重新评估。'
    elif hard_failed:
        conclusion = '硬性条件存在差距'
        next_step = '优先人工核验硬性条件差距，再决定是否继续评估；综合分不覆盖必备条件。'
    elif missing:
        conclusion = '待补充材料'
        next_step = '优先补充高权重的待评估项目，结合建议问题核验后重新计算综合匹配度。'
    elif hard_unknown:
        conclusion = '硬性条件待核实'
        next_step = '能力评分已完成，先补充任职资格证明，再由工作人员决定下一步。'
    elif value >= 80:
        conclusion, next_step = '高度匹配', '建议进入针对性面试，核实关键成果、本人贡献及证据真实性后人工决策。'
    elif value >= 65:
        conclusion, next_step = '较为匹配', '建议进一步评估，重点核验主要差距和岗位关键工作场景。'
    elif value >= 50:
        conclusion, next_step = '部分匹配', '围绕已识别的能力差距开展结构化面试，判断是否具备胜任或培养基础。'
    else:
        conclusion, next_step = '匹配差距较大', '核对评分依据与岗位标准，并结合人工访谈评估差距及可能的其他岗位。'
    source = 'AI逐项分析' if score.get('scoring_method') == 'ai_semantic_v1' else '本地规则参考，尚需AI或人工核验'
    evidence_summary = f'已评估 {len(known)}/{len(dimensions)} 项 · 覆盖岗位权重 {coverage:g}%'
    title = str((job or {}).get('name') or '该岗位')
    summary = (f'对照“{title}”，当前材料支持的综合匹配度为{value:.1f}/100；{evidence_summary}。'
               if value is not None else f'对照“{title}”，暂未形成可用的综合匹配度；{evidence_summary}。')
    summary += f'综合结论：{conclusion}。'
    score_note = '综合匹配度按完整岗位的100%权重加权计算，表示当前材料已支持的匹配程度，不是录用概率。'
    if stale:
        score_note = '当前展示上次评估的评分，尚未反映最新资料或岗位标准修改。' + score_note
    if missing:
        score_note += '缺少证据的维度保留“待评估”，暂未形成分数贡献，不表示该项能力为零。'
    if not score.get('scoring_method') == 'ai_semantic_v1':
        score_note += '当前为本地规则参考，须结合原文及人工判断。'
    unique = lambda items: list(dict.fromkeys(items))
    return dict(conclusion=conclusion, summary=summary, strengths=unique(strengths), gaps=unique(gaps),
                risks=unique(risks), verification=unique(verification), questions=unique(questions),
                next_step=next_step, score_note=score_note, evidence_summary=evidence_summary,
                recommended=value is not None and value >= 65 and not missing and not hard_failed and not hard_unknown and not stale,
                total=value, assessed_score=score.get('assessed_score'), coverage_percent=coverage,
                missing_dimensions=[d['dimension'] for d in missing], hard_failed=hard_failed, hard_unknown=hard_unknown,
                assessment_status=score.get('assessment_status', '待评估'), score_source=source)



def _hard_condition(condition: dict, text: str) -> dict:
    keywords = condition.get("keywords", [])
    negative = condition.get("negative_keywords", [])
    if any(k.lower() in text.lower() for k in negative):
        status = "不满足"
    elif keywords and any(k.lower() in text.lower() for k in keywords):
        status = "满足"
    else:
        status = "无法确认"
    return {"condition": condition["name"], "status": status, "evidence": "；".join([k for k in keywords if k.lower() in text.lower()]) or "无充分证据"}


def calculate_score(tags: list[dict[str, Any]], job: dict[str, Any], redacted_text: str) -> dict[str, Any]:
    weights = job["weights"]
    dimension_scores = []
    for dimension, weight in weights.items():
        relevant = [t for t in tags if t["dimension"] == dimension]
        score = round(sum(t["score"] for t in relevant) / max(1, len(relevant)), 1)
        weighted = round(score * float(weight) / 100, 1)
        dimension_scores.append({"dimension": dimension, "score": score, "weight": float(weight), "weighted": weighted})
    total = round(sum(item["weighted"] for item in dimension_scores), 1)
    hard_checks = [_hard_condition(c, redacted_text) for c in job["hard_conditions"]]
    strengths = [x["dimension"] for x in sorted(dimension_scores, key=lambda v: v["score"], reverse=True) if x["score"] >= 65][:3]
    gaps = [x["dimension"] for x in sorted(dimension_scores, key=lambda v: v["score"]) if x["score"] < 60][:3]
    pending = sum(1 for t in tags if t["needs_confirmation"])
    hard_gap = any(c["status"] == "不满足" for c in hard_checks)
    risk = []
    if hard_gap:
        risk.append("存在关键差距")
    if pending:
        risk.append(f"{pending}项证据需人工确认")
    if "证据冲突" in redacted_text:
        risk.append("材料证据存在冲突")
    suggestion = "建议招聘人员复核关键证据后决定下一步。"
    if total >= 75:
        suggestion = "AI辅助建议：匹配度较高，建议重点核验硬性条件及冲突证据后考虑进入下一轮。"
    elif total >= 55:
        suggestion = "AI辅助建议：存在一定匹配基础，建议针对主要差距补充结构化面试。"
    else:
        suggestion = "AI辅助建议：当前证据显示差距较多，建议人工复核材料完整性与岗位关键要求。"
    return annotate_score_evidence({
        "total": total, "dimensions": dimension_scores, "hard_checks": hard_checks,
        "strengths": strengths or ["无充分证据"], "gaps": gaps or ["暂未识别明显差距"],
        "risks": risk or ["未发现显著风险，但仍需人工判断"],
        "mismatch_reasons": [f"{x['dimension']}证据/得分不足" for x in dimension_scores if x["score"] < 60],
        "pending_count": pending, "ai_suggestion": suggestion,
        "formula": "规则参考分 = Σ（关键词证据得分 × 岗位维度权重）；未识别到证据不代表能力为零",
    }, tags)


def validate_weights(weights: dict[str, float]) -> None:
    if any(float(v) < 0 or float(v) > 100 for v in weights.values()):
        raise ValueError("单项权重必须在0至100之间")
    if abs(sum(float(v) for v in weights.values()) - 100.0) > 0.01:
        raise ValueError("全部维度权重之和必须等于100%")


def evaluate_fit_metadata(tags: list[dict[str, Any]], job: dict[str, Any], score: dict[str, Any]) -> dict[str, Any]:
    """Both directions share the whole-job score and evidence-aware conclusion."""
    annotate_score_evidence(score, tags)
    summary = assessment_summary_data(score, job)
    completeness = summary['coverage_percent']
    if completeness >= 80:
        confidence = "高"
    elif completeness >= 50:
        confidence = "中"
    else:
        confidence = "低"

    level = summary['conclusion']
    return {
        "evidence_completeness": completeness,
        "confidence": confidence,
        "recommendation_level": level,
    }
