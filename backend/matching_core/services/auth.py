"""人岗匹配的业务角色权限。

账号和登录由平台统一管理；这里只保留三类业务角色的操作权限判断。
操作人标识的格式为“业务角色｜登录名”（旧数据只有业务角色），权限按业务角色判断，
审计记录保留完整标识，能追溯到具体操作人。
"""
from __future__ import annotations

OPERATOR_SEPARATOR = "｜"

ROLE_PERMISSIONS = {
    "招聘人员": {
        "view": True, "create_task": True, "edit_job": True,
        "review": True, "export_report": True, "audit": True, "delete_data": True,
    },
    "用人部门": {
        "view": True, "create_task": False, "edit_job": False,
        "review": True, "export_report": True, "audit": False, "delete_data": False,
    },
    "面试官": {
        "view": True, "create_task": False, "edit_job": False,
        "review": True, "export_report": False, "audit": False, "delete_data": False,
    },
}


def operator_role(operator: str) -> str:
    return str(operator or "").split(OPERATOR_SEPARATOR, 1)[0]


def operator_name(operator: str) -> str:
    """用于报告和页面展示的操作人名称。"""
    role, _, name = str(operator or "").partition(OPERATOR_SEPARATOR)
    return name or role


def can(operator: str, permission: str) -> bool:
    return bool(ROLE_PERMISSIONS.get(operator_role(operator), {}).get(permission, False))


def permissions(operator: str) -> dict[str, bool]:
    return dict(ROLE_PERMISSIONS.get(operator_role(operator), {}))
