"""AI 生成面试题目：后台生成、进度、失败处理、自动重试和题目之间不重复。

模型请求全部换成本地替身，不访问外部服务。
"""
import threading
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

from backend.app.core.database import SessionLocal
from backend.app.interview import standards, text_models
from backend.app.interview.models import SensitiveBlock
from backend.app.interview.routers import questions as question_routes

from . import support

HR = support.staff("hr_admin", "hr")
REVIEWER = support.staff("question_reviewer", "question_reviewer")
ADMIN = support.staff()
TIMEOUT = "AI服务响应超时，请稍后重试"
BUSY = "该批次正在生成题目，请等待完成"
DIMENSION_NAMES = [item[0] for item in standards.DIMENSIONS]


@pytest.fixture(autouse=True)
def fresh_generation_state():
    """生成状态保存在进程内存里；每个用例从空的状态开始。"""
    question_routes._generations.clear()
    yield
    question_routes._generations.clear()


def new_batch(client, created, code, **options):
    return support.create_batch(client, created, code, "题目生成测试批次", **options)["id"]


def generate_path(batch_id):
    return f"/api/batches/{batch_id}/questions/generate"


def start(client, batch_id, count=6, headers=HR):
    return client.post(generate_path(batch_id), headers=headers, json={"count": count, "background": True})


def finish(client, response, headers=HR):
    assert response.status_code == 200, response.text
    return support.wait_operation(client, response.json(), headers)


def generation(client, batch_id, headers=HR):
    response = client.get(f"/api/batches/{batch_id}/questions/generation", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def saved_questions(client, batch_id):
    response = client.get(f"/api/questions?batch_id={batch_id}", headers=HR)
    assert response.status_code == 200, response.text
    return response.json()


def question_text(number):
    return f"第{number}题：请结合一个具体事例说明你的做法和结果。"


def question_set(data):
    return text_models.QuestionSet(questions=[
        question_text(data["offset"] + index + 1) for index in range(data["question_count"])])


def use_model(monkeypatch, reply=lambda number, data: question_set(data)):
    """让题目生成走模型请求的分支，并把模型请求换成本地替身。reply 接收第几次请求和请求数据。"""
    calls = []

    def request_json(model, task, data, schema, **options):
        calls.append({"model": model, "task": task, "data": data, "schema": schema, **options})
        return reply(len(calls), data)

    monkeypatch.setattr(text_models, "enabled", lambda: True)
    monkeypatch.setattr(text_models, "request_json", request_json)
    return calls


def timed_out(*_):
    raise HTTPException(504, TIMEOUT)


class SlowModel:
    """代替题目生成函数：报告一次进度后停住，等测试放行，用来制造“正在生成”的状态。"""

    def __init__(self, monkeypatch):
        self.entered = threading.Event()
        self.release = threading.Event()
        monkeypatch.setattr(question_routes, "model_questions", self)

    def __call__(self, job, count, *, timeout, retries, progress):
        progress(f"正在生成第 1 至 6 道（共 {count} 道）")
        self.entered.set()
        if not self.release.wait(30):
            raise HTTPException(504, "测试没有放行生成")
        return [(DIMENSION_NAMES[index % 6], question_text(index + 1)) for index in range(count)]


# ---- 后台生成 --------------------------------------------------------------------

def test_background_generation_returns_an_operation_and_saves_the_questions(client, created):
    batch = new_batch(client, created, "GEN-BG-1")
    mark = support.audit_mark(client)
    started = start(client, batch, 8)
    assert started.status_code == 200, started.text
    operation = started.json()
    assert set(operation) == {"id", "kind", "label", "status", "progress", "result", "error"}
    assert operation["kind"] == "question_generation" and operation["label"] == "生成 8 道主体题"
    assert operation["status"] in ("running", "completed") and operation["id"]

    finished = support.wait_operation(client, operation, HR)
    assert finished["status"] == "completed" and finished["error"] == ""
    assert finished["result"] == {"version": 1, "count": 8, "message": standards.DISCLAIMER}
    assert finished["progress"] == "已生成 8 / 8 道"
    rows = saved_questions(client, batch)
    assert [(row["version"], row["sequence"], row["status"]) for row in rows] == [(1, number, "draft") for number in range(1, 9)]
    assert [row["dimension"] for row in rows] == DIMENSION_NAMES + DIMENSION_NAMES[:2]
    assert len({row["content"] for row in rows}) == 8
    assert {entry["actor"] for row in rows for entry in row["change_log"]} == {"hr"}

    state = generation(client, batch, REVIEWER)
    assert state["running"] is False and state["last_result"] == finished["result"] and "last_error" not in state
    assert state["operation"]["id"] == operation["id"] and state["operation"]["status"] == "completed"
    assert (state["count"], state["started_by"]) == (8, "hr")
    audits = support.audits_since(client, mark)
    assert [(item["action"], item["target_type"], item["target_id"], item["actor"], item["detail"]) for item in audits] == [
        ("question_generated", "batch", str(batch), "hr", "题目版本 1，共 8 道")]

    # 再次生成得到下一个版本。
    assert finish(client, start(client, batch, 3))["result"] == {"version": 2, "count": 3, "message": standards.DISCLAIMER}
    assert sorted({row["version"] for row in saved_questions(client, batch)}) == [1, 2]


def test_default_request_stays_synchronous(client, created):
    batch = new_batch(client, created, "GEN-SYNC-1")
    # 不带 background、明确传 false、空请求体、不带请求体，都按原来的方式同步返回生成结果。
    bodies = [({"count": 3}, 3), ({"count": 3, "background": False}, 3), ({}, 6), (None, 6)]
    for version, (body, count) in enumerate(bodies, start=1):
        response = client.post(generate_path(batch), headers=HR, json=body)
        assert response.status_code == 200, response.text
        assert response.json() == {"version": version, "count": count, "message": standards.DISCLAIMER}
    assert [len([row for row in saved_questions(client, batch) if row["version"] == version]) for version in (1, 2, 3, 4)] == [3, 3, 6, 6]
    # 同步方式不登记后台生成。
    assert generation(client, batch) == {"running": False}


def test_running_generation_is_shown_to_colleagues_and_cannot_be_started_twice(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-RUN-1")
    other = new_batch(client, created, "GEN-RUN-2")
    model = SlowModel(monkeypatch)
    operations = [start(client, batch, 12).json()]
    try:
        assert model.entered.wait(10)
        for viewer in (HR, REVIEWER, ADMIN):
            state = generation(client, batch, viewer)
            assert state["running"] is True and "last_error" not in state and "last_result" not in state
            assert (state["count"], state["started_by"]) == (12, "hr")
            assert datetime.fromisoformat(state["started_at"]).tzinfo is not None
            assert isinstance(state["elapsed_seconds"], int) and 0 <= state["elapsed_seconds"] < 30
            assert state["operation"] == {**operations[0], "status": "running", "progress": "正在生成第 1 至 6 道（共 12 道）",
                                          "result": None, "error": ""}
        # 作业记录只有发起人能按编号查询，其他工作人员通过批次的生成状态看进度。
        assert client.get(f"/api/library/operations/{operations[0]['id']}", headers=HR).json()["status"] == "running"
        assert client.get(f"/api/library/operations/{operations[0]['id']}", headers=REVIEWER).status_code == 404

        for headers, body in ((HR, {"count": 6, "background": True}), (ADMIN, {"count": 6, "background": True}),
                              (HR, {"count": 6})):
            again = client.post(generate_path(batch), headers=headers, json=body)
            assert (again.status_code, again.json()["detail"]) == (409, BUSY)
        assert saved_questions(client, batch) == []

        # 其他批次不受影响。
        assert generation(client, other) == {"running": False}
        model.entered.clear()
        second = start(client, other, 3)
        assert second.status_code == 200, second.text
        operations.append(second.json())
        assert model.entered.wait(10)
        assert generation(client, other)["running"] is True and generation(client, batch)["running"] is True
    finally:
        model.release.set()
        results = [support.wait_operation(client, operation, HR) for operation in operations]
    assert [item["status"] for item in results] == ["completed", "completed"]
    assert [item["result"]["count"] for item in results] == [12, 3]
    assert len(saved_questions(client, batch)) == 12 and len(saved_questions(client, other)) == 3
    assert generation(client, batch)["running"] is False
    # 结束后可以再次发起。
    assert finish(client, start(client, batch, 2))["result"]["version"] == 2


# ---- 失败与重试 ------------------------------------------------------------------

def test_failed_generation_saves_nothing_and_keeps_the_reason(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-FAIL-1")
    failing = {"active": True}

    def reply(number, data):
        if failing["active"] and data["offset"]:
            raise HTTPException(504, TIMEOUT)
        return question_set(data)

    calls = use_model(monkeypatch, reply)
    mark = support.audit_mark(client)
    finished = finish(client, start(client, batch, 12))
    assert (finished["status"], finished["error"], finished["result"]) == ("failed", TIMEOUT, None)
    # 第一批已经生成，第二批连同自动重试的一次都超时：整个生成失败，不保存不完整的题目版本。
    assert [call["data"]["offset"] for call in calls] == [0, 6, 6]
    assert {call["timeout"] for call in calls} == {90}
    assert saved_questions(client, batch) == []

    state = generation(client, batch, REVIEWER)
    assert state["running"] is False and state["last_error"] == TIMEOUT and "last_result" not in state
    assert (state["count"], state["started_by"], state["operation"]["status"]) == (12, "hr", "failed")
    assert datetime.fromisoformat(state["finished_at"]) >= datetime.fromisoformat(state["started_at"])
    assert isinstance(state["elapsed_seconds"], int) and 0 <= state["elapsed_seconds"] < 30
    audits = support.audits_since(client, mark)
    assert [(item["action"], item["target_type"], item["target_id"], item["actor"], item["detail"]) for item in audits] == [
        ("question_generation_failed", "batch", str(batch), "hr", TIMEOUT)]

    # 失败后可以重新生成；有了新的成功生成，不再提示上一次的失败。
    failing["active"] = False
    assert finish(client, start(client, batch, 12))["result"] == {"version": 1, "count": 12, "message": standards.DISCLAIMER}
    state = generation(client, batch)
    assert state["running"] is False and "last_error" not in state and state["last_result"]["count"] == 12
    assert len(saved_questions(client, batch)) == 12
    assert [item["action"] for item in support.audits_since(client, mark)] == ["question_generated", "question_generation_failed"]


def test_synchronous_success_clears_an_earlier_failure(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-FAIL-2")
    with monkeypatch.context() as patched:
        use_model(patched, timed_out)
        assert finish(client, start(client, batch, 6))["status"] == "failed"
    assert generation(client, batch)["last_error"] == TIMEOUT
    assert client.post(generate_path(batch), headers=HR, json={"count": 6}).status_code == 200
    assert generation(client, batch) == {"running": False}


@pytest.mark.parametrize("status,detail", [
    (504, TIMEOUT), (502, "AI服务返回异常，请稍后重试"), (503, "AI服务繁忙，请稍后重试"),
])
def test_temporary_model_failure_is_retried_once_in_the_background(client, created, monkeypatch, status, detail):
    batch = new_batch(client, created, f"GEN-RETRY-{status}")

    def reply(number, data):
        if number == 1:
            raise HTTPException(status, detail)
        return question_set(data)

    calls = use_model(monkeypatch, reply)
    finished = finish(client, start(client, batch, 6))
    assert finished["status"] == "completed" and finished["result"]["count"] == 6
    assert [(call["data"]["offset"], call["timeout"]) for call in calls] == [(0, 90), (0, 90)]
    assert [row["content"] for row in saved_questions(client, batch)] == [question_text(number) for number in range(1, 7)]
    assert "last_error" not in generation(client, batch)

    # 同步方式保持原有设置：单次超时 45 秒，不自动重试。
    calls.clear()
    response = client.post(generate_path(batch), headers=HR, json={"count": 6})
    assert (response.status_code, response.json()["detail"]) == (status, detail)
    assert [(call["data"]["offset"], call["timeout"]) for call in calls] == [(0, 45)]
    assert {row["version"] for row in saved_questions(client, batch)} == {1}


def test_wrong_number_of_questions_is_retried_and_other_errors_are_not(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-RETRY-N")

    def short_once(number, data):
        return text_models.QuestionSet(questions=[question_text(1)]) if number == 1 else question_set(data)

    with monkeypatch.context() as patched:
        calls = use_model(patched, short_once)
        assert finish(client, start(client, batch, 6))["result"]["count"] == 6
        assert len(calls) == 2

    def rejected(*_):
        raise HTTPException(422, "请求内容不符合要求")

    with monkeypatch.context() as patched:
        calls = use_model(patched, rejected)
        finished = finish(client, start(client, batch, 6))
        assert (finished["status"], finished["error"]) == ("failed", "请求内容不符合要求")
        assert len(calls) == 1
    assert {row["version"] for row in saved_questions(client, batch)} == {1}


def test_unexpected_error_does_not_expose_internal_detail(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-FAIL-3")

    def broken(*_):
        raise RuntimeError("C:\\secret\\path synthetic-internal-detail")

    use_model(monkeypatch, broken)
    mark = support.audit_mark(client)
    finished = finish(client, start(client, batch, 6))
    assert finished["status"] == "failed" and finished["error"] == "处理未完成（RuntimeError），请稍后重试"
    state = generation(client, batch)
    assert state["last_error"] == finished["error"] and "synthetic-internal-detail" not in str(state)
    assert [item["detail"] for item in support.audits_since(client, mark, action="question_generation_failed")] == [finished["error"]]
    assert saved_questions(client, batch) == []


# ---- 题目之间不重复、进度 ----------------------------------------------------------

def test_later_batches_are_told_what_has_already_been_generated(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-PREV-1")
    calls = use_model(monkeypatch)
    finished = finish(client, start(client, batch, 14))
    assert finished["status"] == "completed" and finished["result"]["count"] == 14
    assert [(call["data"]["offset"], call["data"]["question_count"]) for call in calls] == [(0, 6), (6, 6), (12, 2)]
    assert {call["model"] for call in calls} == {"chat-primary"} and {call["schema"] for call in calls} == {text_models.QuestionSet}
    # 第一批没有已生成的题目；后面的批次带上此前全部题目，并在任务说明中要求不得重复。
    assert "previous_questions" not in calls[0]["data"] and "previous_questions" not in calls[0]["task"]
    expected = [{"dimension": DIMENSION_NAMES[index % 6], "content": question_text(index + 1)} for index in range(12)]
    assert calls[1]["data"]["previous_questions"] == expected[:6]
    assert calls[2]["data"]["previous_questions"] == expected
    for call in calls[1:]:
        assert "previous_questions" in call["task"] and "不得与其重复" in call["task"]
    assert [dimension for dimension, *_ in calls[2]["data"]["dimensions"]] == DIMENSION_NAMES[:2]
    rows = saved_questions(client, batch)
    assert [row["content"] for row in rows] == [question_text(number) for number in range(1, 15)]


def test_progress_is_reported_for_every_batch_of_six(monkeypatch):
    job = {"code": "TEST", "name": "测试岗位"}
    texts = []
    assert len(text_models.generate_questions(job, 14, progress=texts.append)) == 14
    assert texts == ["正在生成第 1 至 6 道（共 14 道）", "已生成 6 / 14 道", "已生成 6 / 14 道，正在生成第 7 至 12 道",
                     "已生成 12 / 14 道", "已生成 12 / 14 道，正在生成第 13 至 14 道", "已生成 14 / 14 道"]
    texts.clear()
    assert len(text_models.generate_questions(job, 13, progress=texts.append)) == 13
    assert texts[-2:] == ["已生成 12 / 13 道，正在生成第 13 道", "已生成 13 / 13 道"]
    texts.clear()
    assert len(text_models.generate_questions(job, 1, progress=texts.append)) == 1
    assert texts == ["正在生成第 1 道（共 1 道）", "已生成 1 / 1 道"]
    # 不传进度回调时照常生成。
    assert text_models.generate_questions(job, 8) == text_models.generate_questions(job, 8, progress=texts.append)

    texts.clear()
    use_model(monkeypatch, lambda number, data: timed_out() if number == 2 else question_set(data))
    assert len(text_models.generate_questions(job, 12, retries=1, progress=texts.append)) == 12
    assert texts == ["正在生成第 1 至 6 道（共 12 道）", "已生成 6 / 12 道", "已生成 6 / 12 道，正在生成第 7 至 12 道",
                     "第 7 至 12 道未能生成，正在重试（已生成 6 / 12 道）", "已生成 12 / 12 道"]


def test_sensitive_questions_are_still_blocked_in_the_background(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-SENSITIVE-1")
    blocked = "请说明你的宗教信仰对工作安排的影响。"

    def remove_blocks():
        with SessionLocal() as db:
            db.execute(delete(SensitiveBlock).where(SensitiveBlock.content == blocked))
            db.commit()

    created.callbacks.append(remove_blocks)

    def reply(number, data):
        questions = question_set(data)
        questions.questions[2] = blocked
        return questions

    use_model(monkeypatch, reply)
    mark = support.audit_mark(client)
    finished = finish(client, start(client, batch, 6))
    assert finished["status"] == "completed" and finished["result"]["count"] == 5
    rows = saved_questions(client, batch)
    assert [row["sequence"] for row in rows] == [1, 2, 4, 5, 6] and blocked not in [row["content"] for row in rows]
    record = client.get("/api/sensitive-blocks", headers=REVIEWER).json()[0]
    assert (record["content"], record["reason"], record["source_type"]) == (blocked, "民族和宗教", "main_question")
    assert [(item["action"], item["actor"]) for item in reversed(support.audits_since(client, mark))] == [
        ("sensitive_content_blocked", "hr"), ("question_generated", "hr")]


# ---- 权限与前置校验 ----------------------------------------------------------------

def test_generation_permissions_and_preconditions(client, created):
    batch = new_batch(client, created, "GEN-AUTH-1")
    status_path = f"/api/batches/{batch}/questions/generation"
    for role in ("question_reviewer", "business_user", "interviewer", "report_reviewer", "candidate"):
        headers = support.staff(role, role)
        assert client.post(generate_path(batch), headers=headers, json={"count": 3, "background": True}).status_code == 403, role
        expected = 200 if role == "question_reviewer" else 403
        assert client.get(status_path, headers=headers).status_code == expected, role
    assert client.get(status_path).status_code == 401
    assert client.post(generate_path(batch), json={"count": 3, "background": True}).status_code == 401

    assert start(client, 999999).status_code == 404
    assert client.get("/api/batches/999999/questions/generation", headers=HR).status_code == 404
    for body in ({"count": 0, "background": True}, {"count": 31, "background": True}, {"count": 3, "background": "later"}):
        assert client.post(generate_path(batch), headers=HR, json=body).status_code == 422, body

    listening = new_batch(client, created, "GEN-AUTH-2", mode="listening_only")
    refused = start(client, listening)
    assert refused.status_code == 409 and "仅做人工面试旁听" in refused.json()["detail"]
    job = support.create_library_job(client, created, "题目生成测试岗位")
    unconfirmed = new_batch(client, created, "GEN-AUTH-3", library_job_id=job["id"])
    refused = start(client, unconfirmed)
    assert refused.status_code == 409 and "尚未审核" in refused.json()["detail"]

    # 校验没有通过时不登记生成，也不产生题目。
    for batch_id in (batch, listening, unconfirmed):
        assert generation(client, batch_id) == {"running": False}
        assert saved_questions(client, batch_id) == []


# ---- 批次在生成期间被删除 ----------------------------------------------------------

def replace_batch(client, created, batch_id, code):
    """删除批次后新建一个批次；数据库会把刚空出来的编号分配给新批次。"""
    support.purge_batches([batch_id])
    created.batches.remove(batch_id)
    replacement = new_batch(client, created, code)
    if replacement != batch_id:
        pytest.skip("数据库没有重新使用批次编号，无法构造这个场景")
    return replacement


def test_state_of_a_deleted_batch_is_not_shown_for_its_successor(client, created, monkeypatch):
    first = new_batch(client, created, "GEN-REUSE-1")
    with monkeypatch.context() as patched:
        use_model(patched, timed_out)
        assert finish(client, start(client, first, 6))["status"] == "failed"
    assert generation(client, first)["last_error"] == TIMEOUT
    second = replace_batch(client, created, first, "GEN-REUSE-2")
    assert generation(client, second) == {"running": False}
    assert finish(client, start(client, second, 3))["result"] == {"version": 1, "count": 3, "message": standards.DISCLAIMER}


def test_questions_are_not_saved_into_a_batch_that_replaced_the_original(client, created, monkeypatch):
    first = new_batch(client, created, "GEN-GONE-1")
    model = SlowModel(monkeypatch)
    operation = start(client, first, 6).json()
    try:
        assert model.entered.wait(10)
        second = replace_batch(client, created, first, "GEN-GONE-2")
        # 进行中的生成属于已删除的批次，不算在新批次上。
        assert generation(client, second) == {"running": False}
    finally:
        model.release.set()
        finished = support.wait_operation(client, operation, HR)
    assert finished["status"] == "failed" and "已被删除或更换岗位" in finished["error"]
    assert saved_questions(client, second) == []
    assert generation(client, second) == {"running": False}


def test_questions_are_not_saved_when_the_batch_is_deleted_during_generation(client, created, monkeypatch):
    batch = new_batch(client, created, "GEN-GONE-3")
    model = SlowModel(monkeypatch)
    operation = start(client, batch, 6).json()
    try:
        assert model.entered.wait(10)
        support.purge_batches([batch])
        created.batches.remove(batch)
    finally:
        model.release.set()
        finished = support.wait_operation(client, operation, HR)
    assert (finished["status"], finished["error"]) == ("failed", "批次不存在")
    assert saved_questions(client, batch) == []
