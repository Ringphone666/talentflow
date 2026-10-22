from backend.app.interview.mock_engine import generate_followup


def test_followup_uses_candidate_answer_excerpt():
    first = generate_followup(1, "我先查看温度记录，再让同事复测，最后向负责人报告。")
    second = generate_followup(1, "我先检查包装标签，再隔离问题产品并登记。")

    assert first["allowed"] is True
    assert first["basis"] in first["content"]
    assert second["basis"] in second["content"]
    assert first["content"] != second["content"]


def test_sensitive_answer_excerpt_is_blocked_before_followup_display():
    result = generate_followup(1, "我询问了对方的年龄以后才决定如何处理。")

    assert result["allowed"] is False
    assert result["reason"] == "年龄歧视"
    assert result["content"]

