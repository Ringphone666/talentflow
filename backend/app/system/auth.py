"""登录与入口。

工作人员不在本系统单独登录：本机部署使用本机管理入口，接入主系统后由主系统后端授权。
候选人使用系统随机生成的账号密码登录；连续输错会临时锁定。
"""
from __future__ import annotations

import hmac
import os
from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core import security
from ..core.database import get_db
from ..core.deps import ROLE_LABELS, actor_context, audit, permissions_of
from ..core.settings import admin_entry_mode, is_test_runtime
from ..interview.common import now
from ..interview.models import User

router = APIRouter(prefix="/api/auth", tags=["登录与入口"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class HostEntryRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    role: str


def session_body(username: str, display_name: str, role: str, token: str, expires: int, candidate_id=None) -> dict:
    return {"username": username, "display_name": display_name, "role": role, "role_label": ROLE_LABELS[role],
            "permissions": permissions_of(role), "access_token": token, "expires_at": expires,
            "candidate_id": candidate_id}


def entry_session(username: str, role: str, source: str):
    token, expires = security.issue(username, role, source=source)
    return session_body(username, "管理工作台" if source == "local_entry" else username, role, token, expires)


def aware(value):
    """SQLite 取回的时间不带时区，统一按 UTC 比较。"""
    from datetime import timezone
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


@router.post("/login")
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username.strip()))
    if user and user.role != "candidate":
        raise HTTPException(403, "此处仅用于应聘者登录，工作人员请使用管理入口")
    locked_until = aware(user.locked_until) if user else None
    if locked_until and locked_until > now():
        minutes = max(1, int((locked_until - now()).total_seconds() // 60) + 1)
        raise HTTPException(423, f"密码连续输错次数过多，账号已临时锁定，请约 {minutes} 分钟后再试或联系工作人员重置密码")
    if not user or not user.password_hash or not security.verify_password(body.password, user.password_hash):
        if user:
            user.failed_logins = (user.failed_logins or 0) + 1
            if user.failed_logins >= security.LOGIN_MAX_FAILURES:
                user.locked_until = now() + timedelta(seconds=security.LOGIN_LOCK_SECONDS)
                user.failed_logins = 0
                audit(db, {"role": "candidate", "user": user.username}, "login_locked", "user", user.id,
                      "连续输错密码，账号临时锁定")
            db.commit()
        raise HTTPException(401, "账号或密码错误")
    user.failed_logins = 0
    user.locked_until = None
    audit(db, {"role": user.role, "user": user.username}, "login", "user", user.id, "用户登录")
    db.commit()
    token, expires = security.issue(user.username, user.role)
    return session_body(user.username, user.display_name, user.role, token, expires, user.candidate_id)


@router.post("/admin-entry")
def local_admin_entry(request: Request):
    if admin_entry_mode() != "local":
        raise HTTPException(403, "请从主系统授权入口进入")
    local_hosts = {"127.0.0.1", "::1"} | ({"testclient"} if is_test_runtime() else set())
    if not request.client or request.client.host not in local_hosts:
        raise HTTPException(403, "独立管理入口仅限本机访问，请通过主系统授权入口进入")
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "管理入口来源不受信任")
    return entry_session("local-workbench", "system_admin", "local_entry")


@router.post("/host-session")
def host_admin_entry(body: HostEntryRequest, x_host_entry_key: str | None = Header(default=None), db: Session = Depends(get_db)):
    secret = os.getenv("TALENTFLOW_HOST_ENTRY_SECRET", "")
    if admin_entry_mode() != "host" or len(secret) < 32 or not x_host_entry_key or not hmac.compare_digest(secret, x_host_entry_key):
        raise HTTPException(403, "主系统授权验证失败")
    if body.role not in ROLE_LABELS or body.role == "candidate" or not body.username.strip():
        raise HTTPException(422, "请提供有效的工作人员身份与角色")
    username = "host:" + body.username.strip()
    audit(db, {"role": body.role, "user": username}, "host_entry", "user", username, "主系统授权进入")
    db.commit()
    return entry_session(username, body.role, "host_entry")


@router.get("/session")
def current_entry_session(ctx=Depends(actor_context), authorization: str | None = Header(default=None)):
    token = (authorization or "").removeprefix("Bearer ").strip()
    try:
        payload = security.verify(token)
    except ValueError:
        raise HTTPException(401, "授权已失效，请重新进入") from None
    display = "管理工作台" if payload.get("source") == "local_entry" else ctx["user"]
    return session_body(ctx["user"], display, ctx["role"], token, payload["exp"])
