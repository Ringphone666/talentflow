import ast
from pathlib import Path


from matching_core.services.scoring import annotate_score_evidence, calculate_score, score_label, score_value
from matching_core.services.tagger import build_tags


def test_no_keyword_hit_is_unassessed_not_zero():
    job = {'dimensions': [{'name': '协作', 'keywords': ['团队协作']}],
           'weights': {'协作': 100}, 'hard_conditions': []}
    text = '跨部门沟通并协调项目交付'
    tags = build_tags(text, job)
    score = calculate_score(tags, job, text)
    assert score_label(score) == '待评估'
    assert score_value(score) is None
    assert '差距较多' not in score['ai_suggestion']
    # Old stored zero results receive the same interpretation without rewriting DB.
    old = {'total': 0, 'dimensions': [{'dimension': '协作', 'score': 0, 'weight': 100, 'weighted': 0}]}
    annotate_score_evidence(old, tags)
    assert score_label(old) == '待评估'


def test_actual_evidence_zero_and_partial_coverage_remain_distinct():
    score = {'total': 0, 'dimensions': [{'dimension': '协作', 'score': 0, 'weight': 100, 'weighted': 0}]}
    annotate_score_evidence(score, [{'dimension': '协作', 'score': 0, 'evidence': '人工核验的实际证据'}])
    assert score_label(score) == '0.0'
    job = {'weights': {'协作': 50, '技术': 50}, 'hard_conditions': []}
    result = calculate_score([{'dimension': '协作', 'score': 80, 'evidence': '项目协作', 'needs_confirmation': False}], job, '')
    assert score_value(result) == 40
    assert result['unassessed_dimensions'] == ['技术']


