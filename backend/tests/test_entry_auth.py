from fastapi.testclient import TestClient
from backend.app.main import app


def test_candidate_only_password_and_local_admin_entry(client, monkeypatch):
    monkeypatch.setenv('TALENTFLOW_ADMIN_ENTRY_MODE', 'local')
    # 工作人员不能从应聘者登录入口进入，密码是否正确都一样。
    assert client.post('/api/auth/login', json={'username': 'admin', 'password': 'ChangeMe123!'}).status_code == 403
    candidate = client.post('/api/auth/login', json={'username': 'candidate', 'password': 'ChangeMe123!'} )
    assert candidate.status_code == 200
    assert candidate.json()['role'] == 'candidate' and candidate.json()['permissions'] == ['interview:use']
    candidate_auth = {'Authorization': 'Bearer ' + candidate.json()['access_token']}
    assert client.get('/api/audits', headers=candidate_auth).status_code == 403
    assert client.get('/api/interviews/me', headers=candidate_auth).status_code == 200
    entry = client.post('/api/auth/admin-entry')
    assert entry.status_code == 200
    auth = {'Authorization': 'Bearer ' + entry.json()['access_token']}
    assert client.get('/api/auth/session', headers=auth).json()['role'] == 'system_admin'
    assert client.get('/api/audits', headers=auth).status_code == 200
    assert client.post('/api/auth/admin-entry', headers={'Origin': 'https://untrusted.example'}).status_code == 403
    with TestClient(app, client=('192.0.2.15', 12345)) as remote:
        assert remote.post('/api/auth/admin-entry').status_code == 403
    monkeypatch.setenv('TALENTFLOW_ADMIN_ENTRY_MODE', 'host')
    assert client.post('/api/auth/admin-entry').status_code == 403
    assert client.get('/api/audits', headers=auth).status_code == 401
    # 候选人的登录会话不受管理入口方式影响。
    assert client.get('/api/interviews/me', headers=candidate_auth).status_code == 200


def test_host_entry_assigns_signed_roles_only_with_backend_secret(client, monkeypatch):
    monkeypatch.setenv('TALENTFLOW_ADMIN_ENTRY_MODE', 'host')
    monkeypatch.setenv('TALENTFLOW_HOST_ENTRY_SECRET', 'host-integration-test-secret-32-characters')
    body = {'username': 'staff-123', 'role': 'hr_admin'}
    assert client.post('/api/auth/host-session', json=body).status_code == 403
    assert client.post('/api/auth/host-session', headers={'X-Host-Entry-Key': 'wrong-key'}, json=body).status_code == 403
    assert client.get('/api/jobs', headers={'X-User-Role': 'system_admin'}).status_code == 401
    headers = {'X-Host-Entry-Key': 'host-integration-test-secret-32-characters'}
    entry = client.post('/api/auth/host-session', headers=headers, json=body)
    assert entry.status_code == 200
    auth = {'Authorization': 'Bearer ' + entry.json()['access_token']}
    session = client.get('/api/auth/session', headers=auth).json()
    assert session['username'] == 'host:staff-123' and session['role'] == 'hr_admin'
    assert 'audit:read' in session['permissions'] and 'report:confirm' not in session['permissions']
    assert client.get('/api/jobs', headers=auth).status_code == 200
    # HR管理员可以查看审计日志，但不能复核报告；权限跟随主系统授权的角色。
    assert client.get('/api/audits', headers=auth).status_code == 200
    assert client.post('/api/reports/1/confirm', headers=auth, json={'reason': '越权确认'}).status_code == 403
    interviewer = client.post('/api/auth/host-session', headers=headers, json={'username': 'staff-456', 'role': 'interviewer'})
    assert interviewer.status_code == 200
    interviewer_auth = {'Authorization': 'Bearer ' + interviewer.json()['access_token']}
    assert client.get('/api/jobs', headers=interviewer_auth).status_code == 200
    assert client.get('/api/audits', headers=interviewer_auth).status_code == 403
    business = client.post('/api/auth/host-session', headers=headers, json={'username': 'staff-789', 'role': 'business_user'})
    assert business.status_code == 200 and business.json()['role_label'] == '用人部门'
    assert client.post('/api/auth/host-session', headers=headers, json={**body, 'role': 'candidate'}).status_code == 422
    assert client.post('/api/auth/host-session', headers=headers, json={**body, 'role': 'unknown_role'}).status_code == 422
    monkeypatch.setenv('TALENTFLOW_HOST_ENTRY_SECRET', 'too-short')
    assert client.post('/api/auth/host-session', headers={'X-Host-Entry-Key': 'too-short'}, json=body).status_code == 403
    monkeypatch.setenv('TALENTFLOW_HOST_ENTRY_SECRET', 'host-integration-test-secret-32-characters')
    monkeypatch.setenv('TALENTFLOW_ADMIN_ENTRY_MODE', 'local')
    assert client.post('/api/auth/host-session', headers=headers, json=body).status_code == 403
