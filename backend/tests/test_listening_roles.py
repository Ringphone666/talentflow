"""人工面试录音里有考官和候选人两个人：按语境逐段区分发言人，补充提问和综合报告只引用候选人的话。"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.core.database import SessionLocal
from backend.app.interview import listening_intelligence as intelligence
from backend.app.interview import listening_roles as roles
from backend.app.interview.models import ListeningContext, ListeningSession

from . import support

HR = support.staff("hr_admin", "hr")
INTERVIEWER = support.staff("interviewer", "interviewer")
QUESTION_ONE = "请介绍一下你最近负责的招聘项目。"
ANSWER_ONE = "我最近负责销售团队的扩招，三个月内招聘了十五名销售代表。"
QUESTION_TWO = "面试评分表是你自己设计的吗？"
ANSWER_TWO = "是我设计的。入职三个月后我还回访了留存情况。"
DIALOGUE = QUESTION_ONE + ANSWER_ONE + QUESTION_TWO + ANSWER_TWO
CAPTURE = "roles-dialogue"


@pytest.fixture
def talk(client, created):
    """仅旁听的候选人，已开始旁听并保存了一段考官和候选人的连续对话。"""
    batch = support.create_batch(client, created, "ROLES-1", "发言人测试批次", mode="listening_only", recruitment_type="内部竞聘")
    person = support.create_candidate(client, created, batch["id"], "发言人测试候选人")
    target = SimpleNamespace(id=person["id"], url=f"/api/listening/{person['id']}")
    assert client.post(target.url + "/start", headers=INTERVIEWER,
                       json={"consented": True, "candidate_confirmed": True}).status_code == 200
    add_dialogue(client, target, CAPTURE, DIALOGUE)
    return target


def add_dialogue(client, target, capture_id, transcript, **fields):
    support.add_capture(capture_id, target.id, transcript, **fields)
    labelled = client.post(target.url + "/speaker", headers=INTERVIEWER, json={"capture_id": capture_id, "speaker": "dialogue"})
    assert labelled.status_code == 200, labelled.text


def turns_of(client, target, capture_id=CAPTURE):
    return client.get(target.url, headers=INTERVIEWER).json()["speakers"][capture_id].get("turns")


def stored_sentences(target, capture_id=CAPTURE):
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=target.id).one()
        return roles.json.loads(db.get(ListeningContext, session.id).speakers)[capture_id].get("sentences")


def model(monkeypatch, reply):
    """文本模型换成测试里给出的答复，并记录每次请求。"""
    calls = []

    def request(name, task, data, schema, **options):
        calls.append(SimpleNamespace(model=name, task=task, data=data, schema=schema, options=options))
        return reply(data, schema)

    monkeypatch.setattr(intelligence.text_models, "enabled", lambda: True)
    monkeypatch.setattr(intelligence.text_models, "request_json", request)
    return calls


def by_question_mark(data, schema):
    """按“问句是考官说的”答复逐句判断的请求。"""
    return schema(sentences=[{"index": item["index"], "role": "interviewer" if item["text"].endswith("？") or item["text"].startswith("请") else "candidate"}
                             for item in data["sentences"] if "role" not in item])


def test_transcript_is_split_into_sentences_and_merged_into_turns():
    text = "请介绍一下自己。\n我做了三年招聘！效果不错；后来转做培训？是的"
    assert [item[2] for item in roles.spans(text)] == ["请介绍一下自己。", "我做了三年招聘！", "效果不错；", "后来转做培训？", "是的"]
    # 每句在原文中的位置可以直接取回原文。
    assert all(text[start:end] == sentence for start, end, sentence in roles.spans(text))
    assert roles.spans("") == [] and roles.spans("  \n ") == []

    stored = [{"text": "请介绍一下自己。", "role": "interviewer", "basis": "inferred"},
              {"text": "我做了三年招聘！", "role": "candidate", "basis": "confirmed"},
              {"text": "效果不错；", "role": "candidate", "basis": "inferred"},
              {"text": "文字已经变化的一句", "role": "interviewer", "basis": "inferred"}]
    assert [(item["role"], item["basis"]) for item in roles.aligned(text, stored)] == [
        ("interviewer", "inferred"), ("candidate", "confirmed"), ("candidate", "inferred"),
        ("unknown", "pending"), ("unknown", "pending")]
    merged = roles.turns(text, stored)
    assert [(turn["role"], turn["basis"], turn["first"], turn["last"]) for turn in merged] == [
        ("interviewer", "inferred", 0, 0), ("candidate", "inferred", 1, 2), ("unknown", "pending", 3, 4)]
    # 一段话的文字取自原文（含句子之间的换行），引用可以直接在其中核对。
    assert merged[1]["text"] == "我做了三年招聘！效果不错；" and merged[0]["text"] in text and merged[2]["text"] == "后来转做培训？是的"
    # 页面显示时，面试官确认过的句子单独成段，改错了还能单独改回来。
    shown = roles.turns(text, stored, keep_basis=True)
    assert [(turn["role"], turn["basis"], turn["first"], turn["last"]) for turn in shown] == [
        ("interviewer", "inferred", 0, 0), ("candidate", "confirmed", 1, 1), ("candidate", "inferred", 2, 2),
        ("unknown", "pending", 3, 4)]
    assert roles.complete(text, stored) is False and roles.complete("请介绍一下自己。", stored) is True
    # 同一个人连着说的几句全部确认过，这一段才算已确认。
    confirmed = [dict(item, basis="confirmed") for item in stored[:3]]
    assert [turn["basis"] for turn in roles.turns("请介绍一下自己。我做了三年招聘！效果不错；", confirmed)] == ["confirmed", "confirmed"]


def test_only_new_sentences_are_sent_to_the_model(monkeypatch):
    calls = model(monkeypatch, by_question_mark)
    first = roles.infer(DIALOGUE, [], ["最近负责的招聘项目是什么？"])
    assert [item["role"] for item in first] == ["interviewer", "candidate", "interviewer", "candidate", "candidate"]
    assert all(item["basis"] == "inferred" for item in first)
    assert calls[0].model == roles.MODEL and calls[0].schema is roles.SentenceRoles
    assert calls[0].data["questions"] == ["最近负责的招聘项目是什么？"]
    assert [item["index"] for item in calls[0].data["sentences"]] == [0, 1, 2, 3, 4]
    assert all("role" not in item for item in calls[0].data["sentences"])

    first[1].update(role="candidate", basis="confirmed", actor="interviewer")
    longer = DIALOGUE + "那留存情况怎么样？九成的人都留下来了。"
    second = roles.infer(longer, first, [])
    # 已经判断过的句子只作为上下文带上（附带原来的判断），只要求返回新增的两句。
    sent = calls[1].data["sentences"]
    assert [item["index"] for item in sent] == [0, 1, 2, 3, 4, 5, 6]
    assert [item.get("role") for item in sent] == ["interviewer", "candidate", "interviewer", "candidate", "candidate", None, None]
    assert second[:5] == first and second[1]["actor"] == "interviewer"
    assert [(item["role"], item["basis"]) for item in second[5:]] == [("interviewer", "inferred"), ("candidate", "inferred")]
    # 没有新句子时不再请求模型。
    assert roles.infer(longer, second, []) == second and len(calls) == 2


def test_sentences_the_model_leaves_out_are_marked_unknown(monkeypatch):
    calls = model(monkeypatch, lambda data, schema: schema(sentences=[{"index": 0, "role": "interviewer"}, {"index": 9, "role": "candidate"}]))
    result = roles.infer(QUESTION_ONE + ANSWER_ONE, [], [])
    assert [(item["role"], item["basis"]) for item in result] == [("interviewer", "inferred"), ("unknown", "inferred")]
    assert len(calls) == 1


def test_long_dialogue_is_judged_in_batches(monkeypatch):
    calls = model(monkeypatch, by_question_mark)
    text = "".join(f"第{index}个问题是什么？这是第{index}个回答。" for index in range(40))
    result = roles.infer(text, [], [])
    assert len(result) == 80 and len(calls) == 2
    assert sum(1 for item in calls[0].data["sentences"] if "role" not in item) == roles.BATCH
    second = calls[1].data["sentences"]
    assert [item["index"] for item in second][0] == roles.BATCH - roles.CONTEXT_SENTENCES
    assert sum(1 for item in second if "role" not in item) == 20
    assert [item["role"] for item in result[:4]] == ["interviewer", "candidate", "interviewer", "candidate"]


def test_saved_dialogue_is_separated_and_shown_by_turn(client, talk):
    before = client.get(talk.url, headers=INTERVIEWER).json()
    assert before["speakers"][CAPTURE]["speaker"] == "dialogue" and "turns" not in before["speakers"][CAPTURE]
    for role in ("hr_admin", "business_user", "candidate"):
        assert client.post(talk.url + "/roles", headers=support.staff(role, role)).status_code == 403
    done = client.post(talk.url + "/roles", headers=INTERVIEWER)
    assert done.status_code == 200 and done.json()["handled"] == 1
    turns = done.json()["speakers"][CAPTURE]["turns"]
    assert [(turn["role"], turn["basis"], turn["first"], turn["last"], turn["text"]) for turn in turns] == [
        ("interviewer", "inferred", 0, 0, QUESTION_ONE), ("candidate", "inferred", 1, 1, ANSWER_ONE),
        ("interviewer", "inferred", 2, 2, QUESTION_TWO), ("candidate", "inferred", 3, 4, ANSWER_TWO)]
    state = client.get(talk.url, headers=INTERVIEWER).json()
    label = state["speakers"][CAPTURE]
    assert label["turns"] == turns and label["roles_status"] == "completed" and "sentences" not in label
    # 已经区分过的录音不重复处理。
    assert client.post(talk.url + "/roles", headers=INTERVIEWER).json()["handled"] == 0


def test_interviewer_corrects_a_turn_and_the_correction_is_kept(client, talk):
    mark = support.audit_mark(client)
    client.post(talk.url + "/roles", headers=INTERVIEWER)
    body = {"capture_id": CAPTURE, "first": 3, "last": 3, "role": "interviewer"}
    for role in ("hr_admin", "candidate"):
        assert client.post(talk.url + "/turns", headers=support.staff(role, role), json=body).status_code == 403
    # 别人采集的录音不能改。
    assert client.post(talk.url + "/turns", headers=support.staff("interviewer", "another-interviewer"), json=body).status_code == 403
    assert client.post(talk.url + "/turns", headers=INTERVIEWER, json={**body, "role": "judge"}).status_code == 422
    assert client.post(talk.url + "/turns", headers=INTERVIEWER, json={**body, "first": 4, "last": 9}).status_code == 409
    assert client.post(talk.url + "/turns", headers=INTERVIEWER, json={**body, "first": -1}).status_code == 422

    changed = client.post(talk.url + "/turns", headers=INTERVIEWER, json=body)
    assert changed.status_code == 200, changed.text
    # 改正过的这一段单独显示，不和前面推断为面试官的一句合在一起。
    assert [(turn["role"], turn["basis"], turn["first"], turn["last"]) for turn in changed.json()["turns"]] == [
        ("interviewer", "inferred", 0, 0), ("candidate", "inferred", 1, 1), ("interviewer", "inferred", 2, 2),
        ("interviewer", "confirmed", 3, 3), ("candidate", "inferred", 4, 4)]
    # 改错了可以单独改回来。
    back = client.post(talk.url + "/turns", headers=INTERVIEWER, json={**body, "role": "candidate"})
    assert [(turn["role"], turn["basis"], turn["first"], turn["last"]) for turn in back.json()["turns"]][3:] == [
        ("candidate", "confirmed", 3, 3), ("candidate", "inferred", 4, 4)]
    assert client.post(talk.url + "/turns", headers=INTERVIEWER, json=body).status_code == 200
    # 确认一段推断正确的话：角色不变，标记为已确认。
    kept = client.post(talk.url + "/turns", headers=INTERVIEWER, json={"capture_id": CAPTURE, "first": 1, "last": 1, "role": "candidate"})
    assert [(turn["role"], turn["basis"]) for turn in kept.json()["turns"]][1] == ("candidate", "confirmed")
    sentences = stored_sentences(talk)
    assert [(item["role"], item["basis"]) for item in sentences] == [
        ("interviewer", "inferred"), ("candidate", "confirmed"), ("interviewer", "inferred"),
        ("interviewer", "confirmed"), ("candidate", "inferred")]
    assert sentences[3]["actor"] == "interviewer"
    audits = support.audits_since(client, mark, action="speaker_turn_confirmed")
    assert len(audits) == 4 and all(item["target_id"] == CAPTURE and item["actor"] == "interviewer" for item in audits)
    # 再次判断不改动面试官确认过的内容。
    assert client.post(talk.url + "/roles", headers=INTERVIEWER).json()["handled"] == 0
    assert turns_of(client, talk) == kept.json()["turns"]

    # 整段标注了发言人的录音不再逐段改。
    assert client.post(talk.url + "/speaker", headers=INTERVIEWER, json={"capture_id": CAPTURE, "speaker": "candidate"}).status_code == 200
    assert client.post(talk.url + "/turns", headers=INTERVIEWER, json=body).status_code == 409
    assert turns_of(client, talk) is None
    # 改回连续对话后重新区分。
    assert client.post(talk.url + "/speaker", headers=INTERVIEWER, json={"capture_id": CAPTURE, "speaker": "dialogue"}).status_code == 200
    assert client.post(talk.url + "/roles", headers=INTERVIEWER).json()["handled"] == 1


def test_questions_and_reports_quote_only_what_the_candidate_said(client, talk):
    suggestion = client.post(talk.url + "/suggest", headers=INTERVIEWER).json()["suggestions"][0]
    # 生成补充提问时顺带区分发言人；引用的是候选人说的话，不是开头的提问。
    assert turns_of(client, talk)[1]["role"] == "candidate"
    assert suggestion["capture_id"] == CAPTURE and suggestion["answer_excerpt"] == ANSWER_ONE
    assert suggestion["speaker_inferred"] is True and "按对话语境" in suggestion["speaker_basis"]

    assert client.post(talk.url + "/turns", headers=INTERVIEWER,
                       json={"capture_id": CAPTURE, "first": 1, "last": 1, "role": "candidate"}).status_code == 200
    report = client.post(talk.url + "/finish", headers=INTERVIEWER).json()
    finding = report["findings"][0]
    assert finding["answer_excerpt"] == ANSWER_ONE and finding["capture_id"] == CAPTURE
    # 面试官确认过的发言不再标为推断。
    assert finding["speaker_inferred"] is False and finding["evidence_sufficient"] is True
    assert "面试官已确认" in finding["speaker_basis"] and report["speakers_separated"] is True
    evidence = report["stage_two_evidence"][0]
    assert evidence["speaker"] == "dialogue" and [turn["role"] for turn in evidence["turns"]] == [
        "interviewer", "candidate", "interviewer", "candidate"]
    assert evidence["turns"][1] == {"role": "candidate", "basis": "confirmed", "text": ANSWER_ONE}


def test_exported_report_lists_the_dialogue_by_speaker(client, talk, monkeypatch):
    reviewer = support.staff("report_reviewer", "report_reviewer")
    long_id = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    add_dialogue(client, talk, long_id, "请说说离职原因？我想找一个更稳定的平台。")
    assert client.post(talk.url + "/roles", headers=INTERVIEWER).json()["handled"] == 2
    assert client.post(talk.url + "/turns", headers=INTERVIEWER,
                       json={"capture_id": CAPTURE, "first": 1, "last": 1, "role": "candidate"}).status_code == 200

    def unavailable(data, schema):
        raise HTTPException(504, "AI服务响应超时，请稍后重试")

    model(monkeypatch, unavailable)
    report = client.post(talk.url + "/finish", headers=INTERVIEWER).json()
    assert report["generation_mode"] == "证据保全降级"
    assert client.post(talk.url + "/report/confirm", headers=reviewer, json={"reason": "已核对录音"}).status_code == 200
    exported = client.get(talk.url + "/report/export", headers=reviewer)
    assert exported.status_code == 200
    text = support.document_xml(exported.content)
    # 逐段列出发言人，标明是推断还是面试官确认过；面试官的话不写成候选人的。
    for expected in ("1-1", "1-2", "2-2", "面试官", "候选人", "（推断）", "（已确认）", QUESTION_ONE, ANSWER_ONE, "我想找一个更稳定的平台。"):
        assert expected in text, expected
    assert "混合对话待核对" not in text and "连续对话由系统按对话语境逐段区分发言人" in text
    # 完整的录音编号很长，报告里只写前 8 位。
    assert "a1b2c3d4…" in text and long_id not in text and CAPTURE in text
    # 没有得到模型分析的报告在开头说明，回答归属写在证据旁边。
    assert "本报告生成时没有得到模型的分析结果（AI服务响应超时，请稍后重试）" in text
    assert "回答归属：" in text


def test_model_quoting_the_interviewer_is_asked_to_correct_and_then_rejected(client, talk, monkeypatch):
    quotes = [QUESTION_ONE, ANSWER_ONE[:10] + QUESTION_TWO[:4]]

    def reply(data, schema):
        if schema is roles.SentenceRoles:
            return by_question_mark(data, schema)
        return schema(suggestions=[{"text": "请补充招聘渠道的选择依据。", "reason": "核实", "dimension": "岗位专业能力",
                                    "capture_id": CAPTURE, "answer_excerpt": quotes[0]}])

    calls = model(monkeypatch, reply)
    assert client.post(talk.url + "/suggest", headers=INTERVIEWER).status_code == 502
    generation = [call for call in calls if call.schema is intelligence.SuggestionBatch]
    assert len(generation) == 2 and "不在候选人的发言里" in generation[1].data["validation_error"]
    # 交给模型的引用选项里只有候选人说的话。
    offered = generation[0].data["citation_options"]["stage_two"][0]["excerpts"]
    assert ANSWER_ONE in offered and QUESTION_ONE not in offered and QUESTION_TWO not in offered
    assert [turn["role"] for turn in generation[0].data["second_stage"][0]["turns"]] == [
        "interviewer", "candidate", "interviewer", "candidate"]
    assert "只能引用role为candidate的turns中的原文" in generation[0].task
    assert client.get(talk.url, headers=INTERVIEWER).json()["suggestions"] == []

    # 综合报告里同样不保存引用了考官的话的结论，如实给出证据保全的版本。
    def finish_reply(data, schema):
        if schema is roles.SentenceRoles:
            return by_question_mark(data, schema)
        return schema(findings=[{"dimension": "岗位专业能力", "capture_id": CAPTURE, "answer_excerpt": QUESTION_TWO,
                                 "analysis": "候选人设计了评分表。", "status": "新增证据待复核"}])

    model(monkeypatch, finish_reply)
    report = client.post(talk.url + "/finish", headers=INTERVIEWER).json()
    assert report["generation_mode"] == "证据保全降级" and report["discarded_findings"] == 1
    assert report["generation_note"] == "模型给出的结论无法在原文中定位"
    assert report["findings"][0]["answer_excerpt"] == ANSWER_ONE and report["findings"][0]["speaker_inferred"] is True


def test_model_may_quote_the_candidate_without_explaining_the_speaker(client, talk, monkeypatch):
    def reply(data, schema):
        if schema is roles.SentenceRoles:
            return by_question_mark(data, schema)
        return schema(suggestions=[
            {"text": "留存情况是怎么回访的？", "reason": "核实回访做法", "dimension": "岗位专业能力",
             "capture_id": CAPTURE, "answer_excerpt": "入职三个月后我还回访了留存情况"},
            {"text": "面试评分表包含哪些维度？", "reason": "核实评分表", "dimension": "逻辑思维",
             "capture_id": CAPTURE, "answer_excerpt": "是我设计的。", "speaker_basis": "基于turns中role为candidate的语境"}])

    calls = model(monkeypatch, reply)
    result = client.post(talk.url + "/suggest", headers=INTERVIEWER)
    assert result.status_code == 200, result.text
    assert len([call for call in calls if call.schema is intelligence.SuggestionBatch]) == 1
    first, second = result.json()["suggestions"]
    assert first["answer_excerpt"] == "入职三个月后我还回访了留存情况" and first["speaker_inferred"] is True
    assert first["speaker_basis"] == "系统按对话语境判断这段话是候选人说的，须核对录音确认。"
    # 模型自己写的归属依据常带内部字段名，已区分发言人的对话统一用系统的说明。
    assert second["speaker_basis"] == first["speaker_basis"]


def test_dialogue_without_any_answer_is_not_used_as_candidate_evidence(client, talk):
    with SessionLocal() as db:
        from backend.app.interview.models import SpeechCapture
        db.get(SpeechCapture, CAPTURE).transcript = "请先介绍一下自己？然后请说明离职原因？"
        db.commit()
    skipped = client.post(talk.url + "/suggest", headers=INTERVIEWER).json()
    assert skipped["suggestions"] == [] and skipped["skipped"] == "这段对话里还没有候选人的回答，暂不提出补充提问"
    assert client.post(talk.url + "/finish", headers=INTERVIEWER).status_code == 409
    assert client.post(talk.url + "/finish", headers=INTERVIEWER, json={"background": True}).status_code == 409
    assert client.get(talk.url, headers=INTERVIEWER).json()["status"] == "running"


def test_failed_separation_is_recorded_and_the_old_way_still_works(client, talk, monkeypatch):
    def reply(data, schema):
        if schema is roles.SentenceRoles:
            raise HTTPException(504, "AI服务响应超时，请稍后重试")
        return schema(suggestions=[{"text": "请补充招聘渠道的选择依据。", "reason": "核实", "dimension": "岗位专业能力",
                                    "capture_id": CAPTURE, "answer_excerpt": ANSWER_ONE,
                                    "speaker_basis": "这句话是在回答前面的提问"}])

    model(monkeypatch, reply)
    result = client.post(talk.url + "/suggest", headers=INTERVIEWER)
    assert result.status_code == 200, result.text
    # 区分不出来时不猜：沿用原来的办法，由模型在引用时说明归属依据。
    suggestion = result.json()["suggestions"][0]
    assert suggestion["speaker_inferred"] is True and suggestion["speaker_basis"] == "这句话是在回答前面的提问"
    label = client.get(talk.url, headers=INTERVIEWER).json()["speakers"][CAPTURE]
    assert label["roles_status"] == "failed" and label["roles_error"] == "AI服务响应超时，请稍后重试" and "turns" not in label


def test_separation_needs_the_text_model_outside_test_runtime(client, talk, monkeypatch):
    monkeypatch.setenv("TALENTFLOW_RUNTIME_PROFILE", "production")
    with SessionLocal() as db:
        session = db.query(ListeningSession).filter_by(candidate_id=talk.id).one()
        assert roles.ensure(db, session, finalized=True) == 1
    monkeypatch.undo()
    label = client.get(talk.url, headers=INTERVIEWER).json()["speakers"][CAPTURE]
    # 正式环境没有启用文本模型时不按固定规则猜测发言人。
    assert label["roles_status"] == "failed" and "文本模型未启用" in label["roles_error"] and "turns" not in label
