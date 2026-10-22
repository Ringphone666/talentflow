import json
from io import BytesIO
from uuid import uuid4
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.core.database import SessionLocal
from backend.app.interview import report_builder
from backend.app.interview.models import Answer, Candidate, Interview, Question, Report, ReportVersion


@pytest.fixture
def saved_report(client):
    with SessionLocal() as db:
        first = db.scalars(select(Question).where(Question.sequence == 1)).first()
        candidate = Candidate(code='rescore-' + uuid4().hex, name='评分回归',
                              batch_id=first.batch_id, job_id=first.job_id)
        db.add(candidate)
        db.flush()
        interview = Interview(candidate_id=candidate.id, batch_id=first.batch_id, job_id=first.job_id,
                              question_version=first.version, status='completed', current_question=7)
        db.add(interview)
        db.flush()
        questions = db.scalars(select(Question).where(Question.batch_id == first.batch_id,
            Question.job_id == first.job_id, Question.version == first.version).order_by(Question.sequence)).all()
        for question in questions:
            db.add(Answer(interview_id=interview.id, question_id=question.id,
                          answer_code=f'A{question.sequence}', transcript='我不会处理', followup_answer='目前没有计划'))
        report = Report(candidate_id=candidate.id, interview_id=interview.id, status='confirmed')
        db.add(report)
        db.flush()
        db.add(ReportVersion(report_id=report.id, version=1, version_type='ai_original',
                            content='{"summary":"原始未评分报告"}', editor='AI'))
        db.commit()
        ids = report.id, interview.id, candidate.id
    yield ids[:2]
    with SessionLocal() as db:
        db.query(ReportVersion).filter_by(report_id=ids[0]).delete()
        db.query(Report).filter_by(id=ids[0]).delete()
        db.query(Answer).filter_by(interview_id=ids[1]).delete()
        db.query(Interview).filter_by(id=ids[1]).delete()
        db.query(Candidate).filter_by(id=ids[2]).delete()
        db.commit()


def result_with_scores(name, answers, job=None, resume=None):
    assert len(answers) == 6 and all(a['dimension'] and a['question'] for a in answers)
    assert all(a['transcript'] == '我不会处理' and a['followup_answer'] == '目前没有计划' for a in answers)
    return {'summary': '本次回答未展示基本方法', 'qa_records': answers,
            'evaluations': [{'dimension': a['dimension'], 'weight': 15, 'score': 1, 'level': '1级',
                'reason': '本次未说明方法，不据此断定实际能力', 'answer_ids': [a['answer_code']],
                'evidence_excerpt': a['transcript'], 'evidence_sufficiency': '部分', 'insufficient': False} for a in answers],
            'match_analysis': {'score': 20, 'matched': [], 'to_verify': []}, 'decision': None}


@pytest.mark.parametrize('score', [0, 1])
def test_regeneration_preserves_original_answers_and_requires_new_review(client, headers, saved_report, monkeypatch, score):
    rid, iid = saved_report
    def scored_result(*args, **kwargs):
        result = result_with_scores(*args, **kwargs)
        for evaluation in result['evaluations']:
            evaluation.update(score=score, level=f'{score}级')
        result['match_analysis']['score'] = score * 20
        return result
    monkeypatch.setattr(report_builder, 'build_report', scored_result)
    h = headers('report_reviewer', 'report_reviewer')
    response = client.post(f'/api/reports/{rid}/regenerate', headers=h, json={'expected_version': 1})
    assert response.status_code == 200, response.text
    report = response.json()
    assert report['current_version'] == 2 and report['status'] == 'pending_review'
    # 硬指标来自人员库档案，与六维评分分开保存；未关联人员库时如实标注。
    indicators = report['current_content']['hard_indicators']
    assert indicators['available'] is False and indicators['counted_in_score'] is False
    compared = client.get('/api/comparison', headers=h).json()['items']
    item = next(item for item in compared if item['report_id'] == rid)
    assert item['match_score'] == score * 20 and set(item['scores'].values()) == {score}
    old = next(v for v in report['versions'] if v['version'] == 1)
    assert old['content']['summary'] == '原始未评分报告'
    assert next(v for v in report['versions'] if v['version'] == 2)['version_type'] == 'ai_regenerated'
    with SessionLocal() as db:
        assert db.get(Interview, iid).status == 'completed'
        assert db.query(Answer).filter_by(interview_id=iid).count() == 6
    assert client.get(f'/api/reports/{rid}/export', headers=h).status_code == 409
    confirmed = client.post(f'/api/reports/{rid}/confirm', headers=h, json={'reason': '核对测试原文'})
    assert confirmed.status_code == 200 and confirmed.json()['status'] == 'confirmed'
    # 该候选人没有关联人员库，确认后只给出说明，不写入人员库。
    assert confirmed.json()['library_sync'] and '已同步' not in confirmed.json()['library_sync']
    exported = client.get(f'/api/reports/{rid}/export', headers=h)
    assert exported.status_code == 200
    with ZipFile(BytesIO(exported.content)) as archive:
        xml = archive.read('word/document.xml').decode()
        assert f'{score}级' in xml and '我不会处理' in xml and '本次未说明方法' in xml
        assert '证据不足' not in xml


def test_generation_failure_does_not_modify_confirmed_report(client, headers, saved_report, monkeypatch):
    rid, _ = saved_report
    def fail(*args, **kwargs):
        raise HTTPException(504, '评分服务超时')
    monkeypatch.setattr(report_builder, 'build_report', fail)
    assert client.post(f'/api/reports/{rid}/regenerate', headers=headers(), json={'expected_version': 1}).status_code == 504
    report = client.get(f'/api/reports/{rid}', headers=headers()).json()
    assert report['current_version'] == 1 and report['status'] == 'confirmed' and len(report['versions']) == 1


def test_legacy_reset_uses_original_report_snapshot_and_locks_completed_state(client, headers, saved_report, monkeypatch):
    rid, iid = saved_report
    with SessionLocal() as db:
        answers = db.query(Answer).filter_by(interview_id=iid).all()
        snapshot = []
        for answer in answers:
            q = db.get(Question, answer.question_id)
            snapshot.append({'sequence': q.sequence, 'answer_code': answer.answer_code, 'question': q.content,
                             'transcript': answer.transcript, 'followup_answer': answer.followup_answer})
        db.query(ReportVersion).filter_by(report_id=rid, version=1).one().content = json.dumps({'qa_records': snapshot})
        db.query(Answer).filter_by(interview_id=iid).delete()
        db.get(Interview, iid).status = 'consent_pending'
        db.commit()
    monkeypatch.setattr(report_builder, 'build_report', result_with_scores)
    response = client.post(f'/api/reports/{rid}/regenerate', headers=headers(), json={'expected_version': 1})
    assert response.status_code == 200, response.text
    assert response.json()['current_content']['answer_source']['version'] == 1
    with SessionLocal() as db:
        interview = db.get(Interview, iid)
        assert interview.status == 'completed' and interview.completed_at is not None
        assert interview.current_question == 7
    compared = client.get('/api/comparison', headers=headers()).json()['items']
    item = next(item for item in compared if item['report_id'] == rid)
    assert item['match_score'] == 20 and set(item['scores'].values()) == {1}


def test_regeneration_enforces_permission_and_version(client, headers, saved_report, monkeypatch):
    rid, _ = saved_report
    def unexpected(*args, **kwargs):
        raise AssertionError('must not call model')
    monkeypatch.setattr(report_builder, 'build_report', unexpected)
    for role in ['candidate', 'hr_admin', 'interviewer', 'business_user', 'question_reviewer']:
        assert client.post(f'/api/reports/{rid}/regenerate', headers=headers(role, role), json={'expected_version': 1}).status_code == 403
    assert client.post(f'/api/reports/{rid}/regenerate', headers=headers(), json={'expected_version': 2}).status_code == 409


def test_concurrent_edit_during_scoring_is_not_overwritten(client, headers, saved_report, monkeypatch):
    rid, _ = saved_report
    def edit_during_generation(*args, **kwargs):
        with SessionLocal() as db:
            report = db.get(Report, rid)
            report.current_version = 2
            report.status = 'pending_review'
            db.add(ReportVersion(report_id=rid, version=2, version_type='human_modified',
                                content='{"summary":"另一位复核人的修改"}', editor='reviewer'))
            db.commit()
        return result_with_scores(*args, **kwargs)
    monkeypatch.setattr(report_builder, 'build_report', edit_during_generation)
    assert client.post(f'/api/reports/{rid}/regenerate', headers=headers(), json={'expected_version': 1}).status_code == 409
    report = client.get(f'/api/reports/{rid}', headers=headers()).json()
    assert report['current_content']['summary'] == '另一位复核人的修改'
    assert len(report['versions']) == 2
