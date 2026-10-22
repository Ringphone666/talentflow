"""口令、随机密码和签名会话。

密码口径按等级保护三级的通用要求实现：长度不少于 8 位（本系统生成 12 位），
同时包含大写字母、小写字母、数字和特殊字符，不含账号本身；连续登录失败后临时锁定。
具体位数、更换周期等如业务另有制度，以业务制度为准，可通过环境变量调整。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from .settings import SECRETS_DIR, int_setting

# 去掉易混淆字符（0/O、1/l/I），便于现场抄录和口头传达。
_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
_LOWER = "abcdefghijkmnpqrstuvwxyz"
_DIGITS = "23456789"
_SPECIAL = "@#$%&*+-=?"
_CLASSES = (_UPPER, _LOWER, _DIGITS, _SPECIAL)

LOGIN_MAX_FAILURES = 5
LOGIN_LOCK_SECONDS = 10 * 60


def password_length() -> int:
    return int_setting("TALENTFLOW_CANDIDATE_PASSWORD_LENGTH", 12, 8, 32)


def password_problems(password: str, username: str = "") -> list[str]:
    """返回不满足强度要求的原因；空列表表示合格。"""
    problems = []
    if len(password) < 8:
        problems.append("长度不少于8位")
    if not any(c.isupper() for c in password):
        problems.append("需包含大写字母")
    if not any(c.islower() for c in password):
        problems.append("需包含小写字母")
    if not any(c.isdigit() for c in password):
        problems.append("需包含数字")
    if not any(not c.isalnum() for c in password):
        problems.append("需包含特殊字符")
    if username and len(username) >= 3 and username.lower() in password.lower():
        problems.append("不得包含登录账号")
    return problems


def generate_password(username: str = "") -> str:
    """生成满足四类字符要求的随机密码，使用系统安全随机源。"""
    length = password_length()
    alphabet = "".join(_CLASSES)
    while True:
        chars = [secrets.choice(group) for group in _CLASSES]
        chars += [secrets.choice(alphabet) for _ in range(length - len(chars))]
        secrets.SystemRandom().shuffle(chars)
        password = "".join(chars)
        if not password_problems(password, username):
            return password


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 120_000).hex()
    return f"pbkdf2_sha256$120000${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt, digest = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), int(rounds)).hex()
        return hmac.compare_digest(actual, digest)
    except (ValueError, TypeError):
        return False


# ---- 签名会话 -----------------------------------------------------------------

SECRET_FILE = SECRETS_DIR / "session-signing-key.txt"
TOKEN_TTL_SECONDS = 12 * 60 * 60


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _secret() -> bytes:
    configured = os.getenv("TALENTFLOW_SESSION_SECRET", "").strip()
    if configured:
        return configured.encode("utf-8")
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    value = SECRET_FILE.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise RuntimeError("会话签名密钥长度不足")
    return value.encode("utf-8")


def issue(username: str, role: str, source: str = "password", *, ttl: int = TOKEN_TTL_SECONDS, **claims) -> tuple[str, int]:
    expires_at = int(time.time()) + ttl
    body = {"sub": username, "role": role, "exp": expires_at, "source": source, **claims}
    payload = _encode(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = _encode(hmac.new(_secret(), payload.encode("ascii"), hashlib.sha256).digest())
    return f"{payload}.{signature}", expires_at


def verify(token: str) -> dict:
    try:
        payload, signature = token.split(".", 1)
        expected = _encode(hmac.new(_secret(), payload.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        data = json.loads(_decode(payload))
        if int(data["exp"]) <= int(time.time()) or not data.get("sub") or not data.get("role"):
            raise ValueError("expired")
        return data
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("invalid token") from None
