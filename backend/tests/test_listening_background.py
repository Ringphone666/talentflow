"""AI旁听里耗时的处理在后台进行：准备提问建议、生成综合报告；没有生成好的综合报告可以重新生成。"""
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.core.database import SessionLocal
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview import listening_tasks as tasks
from backend.app.interview.models import ListeningSession

from . import support

HR = support.staff("hr_admin", "hr")
INTERVIEWER = support.staff("interviewer", "interviewer")
REVIEWER = support.staff("report_reviewer", "report_reviewer")
ANSWER = "我负责过三年的招聘工作，曾独立完成校园招聘计划的编制和执行。"
BACKGROUND = {"background": True}


@pytest.fixture
def target(client, created):
    batch = support.create_batch(client, created, "LISTEN-BG-1", "后台生成测试批次", mode="listening_only",
                                 recruitment_type="内部竞聘")
    person = support.create_candidate(client, created, batch["id"], "后台生成候选人")
    return SimpleNamespace(batch=batch, id=person["id"], url=f"/api/listening/{person['id']}")


@pytest.fixture
def answered(client, target):
    """已开始旁听并保存了一段候选人的回答。"""
    assert client.post(target.url + "/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    support.add_capture("background-answer", target.id, ANSWER)
    assert client.post(target.url + "/speaker", headers=INTERVIEWER,
                       json={"capture_id": "background-answer", "speaker": "candidate"}).status_code == 200
    return target


def state_of(client, target, headers=INTERVIEWER):
    return client.get(target.url, headers=headers).json()


def finished(client, response, headers=INTERVIEWER):
    assert response.status_code == 200, response.text
    return support.wait_operation(client, response.json()["operation"], headers)


def model(monkeypatch, reply):
    calls = []

    def request(name, task, data, schema, **options):
        calls.append(SimpleNamespace(schema=schema, options=options, data=data))
        return reply(schema)

    monkeypatch.setattr(intelligence.text_models, "enabled", lambda: True)
    monkeypatch.setattr(intelligence.text_models, "request_json", request)
    return calls


def analysis(schema):
    return schema(findings=[{"dimension": "岗位专业能力", "capture_id": "background-answer",
                             "answer_excerpt": "我负责过三年的招聘工作", "analysis": "回答说明了招聘工作年限。",
                             "status": "新增证据待复核"}])


def unavailable(schema):
    raise HTTPException(504, "AI服务响应超时，请稍后重试")


def test_questions_are_prepared_in_the_background(client, target):
    assert state_of(client, target)["tasks"] == {"prepare": None, "report": None}
    assert client.post(target.url + "/prepare", headers=HR, json=BACKGROUND).status_code == 403
    mark = support.audit_mark(client)
    started = client.post(target.url + "/prepare", headers=INTERVIEWER, json=BACKGROUND)
    assert started.status_code == 200, started.text
    operation = started.json()["operation"]
    assert operation["kind"] == "listening_prepare" and operation["label"] == "生成提问建议"
    assert operation["status"] in ("running", "completed") and started.json()["prepared_questions"] == []
    done = support.wait_operation(client, operation, INTERVIEWER)
    assert done["status"] == "completed" and len(done["result"]["prepared_questions"]) == 4
    # 处理记录只有发起人能查询。
    assert client.get(f"/api/library/operations/{operation['id']}", headers=support.staff("interviewer", "another")).status_code == 404

    state = state_of(client, target)
    assert state["prepared_questions"] == done["result"]["prepared_questions"] and state["status"] == "ready"
    task = state["tasks"]["prepare"]
    assert task["status"] == "completed" and task["error"] == "" and task["started_by"] == "interviewer"
    assert task["operation_id"] == operation["id"] and task["elapsed_seconds"] >= 0 and task["started_at"]
    assert [item["action"] for item in support.audits_since(client, mark)] == ["listening_questions_prepared"]


def test_only_one_preparation_runs_at_a_time_and_listening_can_start_meanwhile(client, target, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = intelligence.prepare_questions
    first = []

    def slow(db, session, ctx, **options):
        first.append(tasks.view("prepare", session.id)["progress"])
        options["progress"]("正在等待模型返回")
        entered.set()
        assert release.wait(20)
        return original(db, session, ctx, **options)

    monkeypatch.setattr(intelligence, "prepare_questions", slow)
    started = client.post(target.url + "/prepare", headers=INTERVIEWER, json=BACKGROUND)
    assert started.status_code == 200 and entered.wait(20)
    try:
        # 这名候选人没有简历，进度里如实写明只依据岗位要求。
        assert first == ["正在依据岗位要求向模型请求提问建议"]
        task = state_of(client, target)["tasks"]["prepare"]
        assert task["status"] == "running" and task["progress"] == "正在等待模型返回"
        assert client.post(target.url + "/prepare", headers=INTERVIEWER, json=BACKGROUND).status_code == 409
        assert client.post(target.url + "/prepare", headers=INTERVIEWER).status_code == 409
        # 生成期间可以先开始旁听。
        assert client.post(target.url + "/start", headers=INTERVIEWER,
                           json={"consented": True, "candidate_confirmed": True}).status_code == 200
        assert state_of(client, target)["status"] == "running"
    finally:
        release.set()
    assert support.wait_operation(client, started.json()["operation"], INTERVIEWER)["status"] == "completed"
    state = state_of(client, target)
    assert len(state["prepared_questions"]) == 4 and state["tasks"]["prepare"]["status"] == "completed"
    assert state["status"] == "running"


def test_failed_preparation_is_retried_then_reported(client, target, monkeypatch):
    calls = model(monkeypatch, unavailable)
    done = finished(client, client.post(target.url + "/prepare", headers=INTERVIEWER, json=BACKGROUND))
    assert done["status"] == "failed" and done["error"] == "AI服务响应超时，请稍后重试"
    # 后台生成时放宽单次等待时间，并在超时后自动再试一次。
    assert [call.options["timeout"] for call in calls] == [tasks.PREPARE_TIMEOUT] * (tasks.RETRIES + 1)
    state = state_of(client, target)
    assert state["prepared_questions"] == []
    assert state["tasks"]["prepare"]["status"] == "failed" and state["tasks"]["prepare"]["error"] == "AI服务响应超时，请稍后重试"
    # 同步方式生成成功后，此前的失败提示不再显示。
    monkeypatch.undo()
    assert client.post(target.url + "/prepare", headers=INTERVIEWER).status_code == 200
    assert state_of(client, target)["tasks"]["prepare"] is None


def test_listening_ends_at_once_and_the_report_is_generated_in_the_background(client, answered, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = intelligence.generate

    def slow(db, session, ctx, **options):
        entered.set()
        assert release.wait(20)
        return original(db, session, ctx, **options)

    monkeypatch.setattr(intelligence, "generate", slow)
    mark = support.audit_mark(client)
    assert client.post(answered.url + "/finish", headers=HR, json=BACKGROUND).status_code == 403
    started = client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND)
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "generating" and started.json()["operation"]["kind"] == "listening_report"
    assert entered.wait(20)
    try:
        state = state_of(client, answered)
        # 本场已经结束，面试官不用等报告；报告还没有内容。
        assert state["status"] == "completed" and state["comprehensive_report"] is None
        assert state["comprehensive_report_meta"]["status"] == "generating"
        assert state["tasks"]["report"]["status"] == "running" and state["tasks"]["report"]["progress"]
        listed = client.get("/api/listening/candidates", headers=INTERVIEWER, params={"batch_id": answered.batch["id"]}).json()
        assert listed[0]["listening_status"] == "completed" and listed[0]["comprehensive_status"] == "generating"
        assert client.post(answered.url + "/start", headers=INTERVIEWER, json={"consented": True}).status_code == 409
        assert client.get(answered.url + "/report", headers=REVIEWER).status_code == 404
        # 再次结束、重新生成都不会重复发起。
        again = client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND)
        assert again.status_code == 200 and again.json()["status"] == "generating" and again.json()["operation"] is None
        assert client.post(answered.url + "/report/regenerate", headers=INTERVIEWER).status_code == 409
    finally:
        release.set()
    done = support.wait_operation(client, started.json()["operation"], INTERVIEWER)
    assert done["status"] == "completed" and done["result"] == {"generation_mode": "测试环境固定内容", "findings": 1}

    state = state_of(client, answered)
    report = state["comprehensive_report"]
    assert state["comprehensive_report_meta"]["status"] == "pending_review" and state["comprehensive_report_meta"]["current_version"] == 1
    assert state["tasks"]["report"]["status"] == "completed"
    assert report["mode"] == "standalone" and report["findings"][0]["answer_excerpt"] in ANSWER
    saved = client.get(answered.url + "/report", headers=REVIEWER).json()
    assert [(v["version"], v["version_type"], v["reason"]) for v in saved["versions"]] == [(1, "ai_original", "AI原始生成")]
    assert saved["current_content"] == report and saved["generation_error"] == ""
    # 报告生成后，同步方式再次结束返回已有的报告。
    monkeypatch.undo()
    assert client.post(answered.url + "/finish", headers=INTERVIEWER).json() == report
    actions = [item["action"] for item in reversed(support.audits_since(client, mark))]
    assert actions == ["listening_finished", "combined_report_generated"]


def test_report_generated_without_the_model_can_be_regenerated(client, answered, monkeypatch):
    calls = model(monkeypatch, unavailable)
    done = finished(client, client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND))
    assert done["status"] == "completed" and done["result"]["generation_mode"] == "证据保全降级"
    assert calls[-1].options["timeout"] == tasks.REPORT_TIMEOUT
    first = state_of(client, answered)["comprehensive_report"]
    assert first["generation_mode"] == "证据保全降级" and first["generation_note"] == "AI服务响应超时，请稍后重试"
    assert first["findings"][0]["answer_excerpt"] in ANSWER and first["findings"][0]["human_review_required"] is True

    for role in ("hr_admin", "business_user", "candidate"):
        assert client.post(answered.url + "/report/regenerate", headers=support.staff(role, role)).status_code == 403
    mark = support.audit_mark(client)
    model(monkeypatch, analysis)
    done = finished(client, client.post(answered.url + "/report/regenerate", headers=INTERVIEWER))
    assert done["status"] == "completed" and done["result"] == {"generation_mode": "文本模型分析", "findings": 1}
    saved = client.get(answered.url + "/report", headers=REVIEWER).json()
    # 重新生成的内容记为新版本，此前的版本保留。
    assert [(v["version"], v["version_type"], v["reason"]) for v in saved["versions"]] == [
        (1, "ai_original", "AI原始生成"), (2, "ai_original", "AI重新生成（interviewer 发起）")]
    assert saved["current_version"] == 2 and saved["status"] == "pending_review"
    assert saved["versions"][0]["content"] == first
    assert saved["current_content"]["generation_mode"] == "文本模型分析" and saved["current_content"]["generation_note"] == ""
    assert saved["current_content"]["findings"][0]["analysis"] == "回答说明了招聘工作年限。"
    assert [item["action"] for item in reversed(support.audits_since(client, mark))] == [
        "combined_report_regenerate", "combined_report_generated"]

    # 复核人员也可以重新生成；人工修改或确认之后不能再重新生成。
    assert finished(client, client.post(answered.url + "/report/regenerate", headers=REVIEWER), REVIEWER)["status"] == "completed"
    latest = client.get(answered.url + "/report", headers=REVIEWER).json()
    assert latest["current_version"] == 3
    content = dict(latest["current_content"], stage_two_summary="考官补充：表达清楚。")
    assert client.put(answered.url + "/report", headers=REVIEWER, json={"content": content, "reason": "补充现场评价"}).status_code == 200
    refused = client.post(answered.url + "/report/regenerate", headers=INTERVIEWER)
    assert refused.status_code == 409 and "已有人工修改" in refused.json()["detail"]
    assert client.post(answered.url + "/report/confirm", headers=REVIEWER, json={"reason": "已核对录音"}).status_code == 200
    refused = client.post(answered.url + "/report/regenerate", headers=INTERVIEWER)
    assert refused.status_code == 409 and "已经人工确认" in refused.json()["detail"]
    assert client.get(answered.url + "/report", headers=REVIEWER).json()["current_version"] == 4


def test_report_that_could_not_be_generated_says_why_and_can_be_regenerated(client, answered, monkeypatch):
    def broken(db, session, ctx, **options):
        raise HTTPException(413, "本场材料超出当前分析容量，请人工复核；未静默截断证据")

    monkeypatch.setattr(intelligence, "generate", broken)
    mark = support.audit_mark(client)
    done = finished(client, client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND))
    assert done["status"] == "failed" and "超出当前分析容量" in done["error"]
    state = state_of(client, answered)
    assert state["status"] == "completed" and state["comprehensive_report"] is None
    assert state["comprehensive_report_meta"]["status"] == "generation_failed"
    assert "超出当前分析容量" in state["comprehensive_report_meta"]["generation_error"]
    assert state["tasks"]["report"]["status"] == "failed" and "超出当前分析容量" in state["tasks"]["report"]["error"]
    listed = client.get("/api/listening/candidates", headers=INTERVIEWER, params={"batch_id": answered.batch["id"]}).json()
    assert listed[0]["comprehensive_status"] == "generation_failed"
    failed = support.audits_since(client, mark, action="combined_report_failed")
    assert len(failed) == 1 and "超出当前分析容量" in failed[0]["detail"]
    # 没有报告内容时，报告列表和对比里都不出现这名候选人。
    assert client.get(f"/api/comprehensive-reports?batch_id={answered.batch['id']}", headers=REVIEWER).json()["items"] == []

    monkeypatch.undo()
    done = finished(client, client.post(answered.url + "/report/regenerate", headers=INTERVIEWER))
    assert done["status"] == "completed"
    state = state_of(client, answered)
    assert state["comprehensive_report_meta"]["status"] == "pending_review" and state["comprehensive_report"]["findings"]
    assert state["comprehensive_report_meta"]["generation_error"] == "" and state["tasks"]["report"]["status"] == "completed"
    assert [(v["version"], v["reason"]) for v in state["comprehensive_report_meta"]["versions"]] == [(1, "AI原始生成")]


def test_generation_interrupted_by_a_restart_is_reported(client, answered):
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=answered.id).one()
        session.status, session.comprehensive_status = "completed", "generating"
        db.commit()
    state = state_of(client, answered)
    # 数据库里还在“生成中”，后台却没有在处理：服务中途重启过。
    assert state["comprehensive_report_meta"]["status"] == "generating"
    assert state["tasks"]["report"]["status"] == "interrupted" and "重新生成" in state["tasks"]["report"]["error"]
    again = client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND).json()
    assert again["operation"] is None and again["report"]["status"] == "interrupted"
    done = finished(client, client.post(answered.url + "/report/regenerate", headers=INTERVIEWER))
    assert done["status"] == "completed"
    assert state_of(client, answered)["comprehensive_report_meta"]["status"] == "pending_review"


def test_review_waits_while_the_report_is_being_regenerated(client, answered, monkeypatch):
    assert client.post(answered.url + "/finish", headers=INTERVIEWER).status_code == 200
    entered, release = threading.Event(), threading.Event()
    original = intelligence.generate

    def slow(db, session, ctx, **options):
        entered.set()
        assert release.wait(20)
        return original(db, session, ctx, **options)

    monkeypatch.setattr(intelligence, "generate", slow)
    started = client.post(answered.url + "/report/regenerate", headers=INTERVIEWER)
    assert started.status_code == 200 and entered.wait(20)
    try:
        report = client.get(answered.url + "/report", headers=REVIEWER).json()
        assert report["status"] == "generating" and report["current_version"] == 1
        content = report["current_content"]
        reason = {"reason": "重新生成期间的操作"}
        assert client.put(answered.url + "/report", headers=REVIEWER, json={"content": content, **reason}).status_code == 409
        assert client.post(answered.url + "/report/return", headers=REVIEWER, json=reason).status_code == 409
        assert client.post(answered.url + "/report/confirm", headers=REVIEWER, json=reason).status_code == 409
        assert client.get(answered.url + "/report/export", headers=REVIEWER).status_code == 409
    finally:
        release.set()
    assert support.wait_operation(client, started.json()["operation"], INTERVIEWER)["status"] == "completed"
    assert client.post(answered.url + "/report/confirm", headers=REVIEWER, json={"reason": "已核对录音"}).status_code == 200


def test_finish_in_the_background_needs_consent_recording_and_an_answer(client, target):
    assert client.post(target.url + "/finish", headers=INTERVIEWER, json=BACKGROUND).status_code == 409
    assert client.post(target.url + "/report/regenerate", headers=INTERVIEWER).status_code == 409
    assert client.post(target.url + "/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    # 没有候选人的回答时不结束本场。
    support.add_capture("background-question", target.id, "请介绍一下你做过的招聘工作。")
    client.post(target.url + "/speaker", headers=INTERVIEWER, json={"capture_id": "background-question", "speaker": "interviewer"})
    refused = client.post(target.url + "/finish", headers=INTERVIEWER, json=BACKGROUND)
    assert refused.status_code == 409 and "候选人回答" in refused.json()["detail"]
    assert client.post(target.url + "/report/regenerate", headers=INTERVIEWER).status_code == 409
    state = state_of(client, target)
    assert state["status"] == "running" and state["comprehensive_report_meta"]["status"] == "not_generated"
    assert state["tasks"]["report"] is None
    assert client.post("/api/listening/999999/finish", headers=INTERVIEWER, json=BACKGROUND).status_code == 404
    assert client.post("/api/listening/999999/report/regenerate", headers=INTERVIEWER).status_code == 404


def test_report_waits_for_a_suggestion_that_is_still_being_generated(client, answered, monkeypatch):
    with SessionLocal() as db:
        session_id = db.query(ListeningSession.id).filter_by(candidate_id=answered.id).scalar()
    # 补充提问还在生成：同步方式如实告知稍后再试；后台生成等它结束后接着生成。
    with intelligence.LOCK:
        intelligence.ACTIVE.add(session_id)
    try:
        assert client.post(answered.url + "/suggest", headers=INTERVIEWER).status_code == 409
        monkeypatch.setattr(tasks, "REPORT_WAIT", 20)
        started = client.post(answered.url + "/finish", headers=INTERVIEWER, json=BACKGROUND)
        assert started.status_code == 200
        threading.Timer(0.6, lambda: intelligence.ACTIVE.discard(session_id)).start()
        assert support.wait_operation(client, started.json()["operation"], INTERVIEWER)["status"] == "completed"
    finally:
        intelligence.ACTIVE.discard(session_id)
    assert state_of(client, answered)["comprehensive_report_meta"]["status"] == "pending_review"
