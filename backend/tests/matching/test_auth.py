from matching_core.services.auth import ROLE_PERMISSIONS, can, operator_name, operator_role


def test_role_permissions_match_workflow_responsibilities():
    assert ROLE_PERMISSIONS["招聘人员"]["create_task"] is True
    assert ROLE_PERMISSIONS["招聘人员"]["edit_job"] is True
    assert ROLE_PERMISSIONS["用人部门"]["create_task"] is False
    assert ROLE_PERMISSIONS["用人部门"]["edit_job"] is False
    assert ROLE_PERMISSIONS["用人部门"]["review"] is True
    assert ROLE_PERMISSIONS["用人部门"]["export_report"] is True
    assert ROLE_PERMISSIONS["面试官"]["edit_job"] is False
    assert ROLE_PERMISSIONS["面试官"]["export_report"] is False


def test_operator_carries_role_and_login_name():
    assert can("招聘人员｜hr01", "create_task")
    assert not can("面试官｜zhang", "export_report")
    assert operator_role("用人部门｜li") == "用人部门"
    assert operator_name("用人部门｜li") == "li"
    # 旧审计记录只有业务角色。
    assert can("招聘人员", "edit_job") and operator_name("招聘人员") == "招聘人员"


def test_unknown_operator_has_no_permission():
    assert not can("zhang", "view")
    assert not can("", "view")
