"""统一的身份、角色权限和审计入口，两个业务模块共用。"""
from __future__ import annotations

from typing import Any

from fastapi import Header, HTTPException
from sqlalchemy.orm import Session

from . import security
from .settings import admin_entry_mode, is_test_runtime

ROLE_LABELS = {
    "system_admin": "系统管理员",
    "hr_admin": "HR管理员",
    "business_user": "用人部门",
    "question_reviewer": "题目审核人",
    "interviewer": "面试官",
    "report_reviewer": "报告复核人",
    "candidate": "候选人",
}
STAFF_ROLES = tuple(role for role in ROLE_LABELS if role != "candidate")

_INTERVIEW_HR = {
    "batch:read", "batch:create", "batch:edit", "batch:delete",
    "question:read", "question:generate", "question:edit", "question:submit",
    "candidate:read", "candidate:create", "candidate:edit", "candidate:delete",
    "report:read", "report:export", "compare:read", "onsite:manage",
}
_MATCHING_FULL = {"matching:view", "matching:create", "matching:review", "matching:export", "matching:delete"}

PERMISSIONS = {
    "system_admin": {"*"},
    "hr_admin": {"dashboard", "job:read", "job:edit", "person:read", "person:edit", "config:edit", "audit:read",
                 *_INTERVIEW_HR, *_MATCHING_FULL},
    "business_user": {"dashboard", "job:read", "person:read", "report:read", "compare:read",
                      "matching:view", "matching:review", "matching:export"},
    "question_reviewer": {"dashboard", "job:read", "batch:read", "question:read", "question:review",
                          "question:publish", "question:disable"},
    "interviewer": {"dashboard", "job:read", "person:read", "report:read", "listening:use", "compare:read",
                    "matching:view", "matching:review"},
    "report_reviewer": {"dashboard", "job:read", "person:read", "report:read", "report:edit", "report:return",
                        "report:confirm", "report:export", "compare:read", "listening:use",
                        "matching:view", "matching:review", "matching:export"},
    "candidate": {"interview:use"},
}

# 人岗匹配核心按三类业务角色判断权限，这里把平台角色映射过去。
_MATCHING_ROLES = {
    "system_admin": "招聘人员",
    "hr_admin": "招聘人员",
    "business_user": "用人部门",
    "report_reviewer": "用人部门",
    "interviewer": "面试官",
}
OPERATOR_SEPARATOR = "｜"


def actor_context(
    authorization: str | None = Header(default=None),
    x_user_role: str | None = Header(default=None),
    x_user_name: str | None = Header(default=None),
):
    if is_test_runtime() and x_user_role and x_user_name:
        role, user, claims = x_user_role, x_user_name, {}
    else:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "请先登录")
        try:
            claims = security.verify(authorization.split(" ", 1)[1].strip())
        except ValueError:
            raise HTTPException(401, "登录状态已失效，请重新登录") from None
        role, user = str(claims["role"]), str(claims["sub"])
        source = claims.get("source")
        if role == "onsite":
            raise HTTPException(403, "现场入口凭证只能用于选择候选人并开始面试")
        if role != "candidate" and (source not in {"local_entry", "host_entry"}
                                    or (source == "local_entry" and admin_entry_mode() != "local")
                                    or (source == "host_entry" and admin_entry_mode() != "host")):
            raise HTTPException(401, "请从管理入口重新进入")
        if role == "candidate" and source == "onsite" and onsite_entry_closed(str(claims.get("entry") or "")):
            raise HTTPException(401, "现场入口已关闭，请联系工作人员")
    if role not in ROLE_LABELS:
        raise HTTPException(401, "无效的用户角色")
    return {"role": role, "user": user, "claims": claims}


def onsite_entry_closed(token_id: str) -> bool:
    """工作人员关闭现场入口后，经该入口进入的面试会话随之失效。入口只是到期的，已开始的面试可以做完。"""
    from sqlalchemy import select

    from ..interview.models import OnsiteEntry
    from .database import SessionLocal

    with SessionLocal() as db:
        entry = db.scalar(select(OnsiteEntry).where(OnsiteEntry.token_id == token_id))
        return entry is None or entry.revoked_at is not None


def permissions_of(role: str) -> list[str]:
    return sorted(PERMISSIONS.get(role, set()))


def allowed(ctx: dict, permission: str) -> bool:
    granted = PERMISSIONS.get(ctx["role"], set())
    return "*" in granted or permission in granted


def require(ctx: dict, permission: str):
    if not allowed(ctx, permission):
        raise HTTPException(403, f"当前角色无权限执行：{permission}")


def require_any(ctx: dict, *permissions: str):
    if not any(allowed(ctx, permission) for permission in permissions):
        raise HTTPException(403, f"当前角色无权限执行：{permissions[0]}")


def matching_operator(ctx: dict) -> str:
    """生成人岗匹配核心使用的操作人标识：“业务角色｜登录名”，写入其审计记录。"""
    role = _MATCHING_ROLES.get(ctx["role"])
    if not role:
        raise HTTPException(403, "当前角色无权使用人岗匹配")
    return f"{role}{OPERATOR_SEPARATOR}{ctx['user']}"


def audit(db: Session, ctx: dict, action: str, target_type: str, target_id: Any, detail: str = ""):
    from ..interview.models import AuditLog

    db.add(AuditLog(
        actor=ctx["user"],
        role=ctx["role"],
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        detail=detail,
    ))
