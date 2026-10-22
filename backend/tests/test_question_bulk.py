from backend.app.core.database import SessionLocal
from backend.app.interview.models import Question, Interview

from . import support


def new_version(client, headers, created, code):
    batch = support.create_batch(client, created, code, '批量题目测试', headers=headers())['id']
    result = client.post(f'/api/batches/{batch}/questions/generate', headers=headers(), json={'count': 3})
    assert result.status_code == 200
    version = result.json()['version']
    path = f'/api/batches/{batch}/questions/{version}'
    return batch, version, path


def test_bulk_review_permissions_atomicity_and_publish(client, headers, created):
    batch, version, path = new_version(client, headers, created, 'BULK-REVIEW')
    body = {'approved': True, 'comment': '整套题目已核对'}
    reviewer = headers('question_reviewer', 'question_reviewer')
    assert client.post(path + '/review-all', headers=reviewer, json=body).status_code == 409
    assert client.post(path + '/submit-review', headers=headers()).status_code == 200
    assert client.post(path + '/review-all', headers=headers('hr_admin', 'hr'), json=body).status_code == 403
    assert client.post(path + '/review-all', headers=headers('business_user', 'business'), json=body).status_code == 403
    with SessionLocal() as db:
        rows = db.query(Question).filter_by(batch_id=batch, version=version).order_by(Question.sequence).all()
        original = rows[-1].content
        rows[-1].content = '请说明你的宗教信仰'
        db.commit()
    assert client.post(path + '/review-all', headers=reviewer, json=body).status_code == 422
    rows = client.get(f'/api/questions?batch_id={batch}', headers=headers()).json()
    assert {q['status'] for q in rows} == {'pending_review'}
    with SessionLocal() as db:
        db.query(Question).filter_by(id=rows[-1]['id']).one().content = original
        db.commit()
    assert client.post(f"/api/questions/{rows[0]['id']}/review", headers=reviewer, json=body).status_code == 200
    approved = client.post(path + '/review-all', headers=reviewer, json=body)
    assert approved.status_code == 200
    assert approved.json()['count'] == 2
    rows = client.get(f'/api/questions?batch_id={batch}', headers=headers()).json()
    assert {q['status'] for q in rows} == {'approved'}
    listed = next(b for b in client.get('/api/batches', headers=headers()).json() if b['id'] == batch)
    assert listed['question_version'] == 0 and listed['accepts_candidates'] is False
    assert client.post(path + '/review-all', headers=reviewer, json=body).status_code == 409
    assert client.post(path + '/publish', headers=reviewer).status_code == 200
    listed = next(b for b in client.get('/api/batches', headers=headers()).json() if b['id'] == batch)
    assert listed['question_version'] == version and listed['status'] == 'active' and listed['accepts_candidates'] is True
    assert client.delete(path, headers=headers()).status_code == 409


def test_bulk_delete_pending_version_and_protect_assigned_interview(client, headers, created):
    mark = support.audit_mark(client)
    batch, version, path = new_version(client, headers, created, 'BULK-DELETE')
    assert client.post(path + '/submit-review', headers=headers()).status_code == 200
    assert client.delete(path, headers=headers('question_reviewer', 'question_reviewer')).status_code == 403
    with SessionLocal() as db:
        interview = db.query(Interview).order_by(Interview.id).first()
        interview_id = interview.id
        original_batch, original_version = interview.batch_id, interview.question_version
        interview.batch_id, interview.question_version = batch, version
        db.commit()
    try:
        assert client.delete(path, headers=headers()).status_code == 409
        assert len(client.get(f'/api/questions?batch_id={batch}', headers=headers()).json()) == 3
    finally:
        with SessionLocal() as db:
            interview = db.get(Interview, interview_id)
            interview.batch_id, interview.question_version = original_batch, original_version
            db.commit()
    result = client.delete(path, headers=headers('hr_admin', 'hr'))
    assert result.status_code == 200
    assert result.json()['count'] == 3
    assert client.get(f'/api/questions?batch_id={batch}', headers=headers()).json() == []
    assert next(b for b in client.get('/api/batches', headers=headers()).json() if b['id'] == batch)['status'] == 'draft'
    assert client.delete(path, headers=headers()).status_code == 404
    audits = support.audits_since(client, mark, action='question_version_deleted')
    assert [(a['action'], a['target_id'], a['actor'], a['source']) for a in audits] == [
        ('question_version_deleted', str(batch), 'hr', 'platform')]


def test_listening_only_batch_needs_no_questions(client, headers, created):
    # 仅人工面试旁听的批次建好即可使用，不生成AI面试题目。
    batch = support.create_batch(client, created, 'BULK-LISTEN', '仅旁听批次', mode='listening_only', headers=headers())
    assert batch['status'] == 'active' and batch['question_version'] == 0 and batch['accepts_candidates'] is True
    generated = client.post(f"/api/batches/{batch['id']}/questions/generate", headers=headers(), json={'count': 3})
    assert generated.status_code == 409
    assert client.get(f"/api/questions?batch_id={batch['id']}", headers=headers()).json() == []
