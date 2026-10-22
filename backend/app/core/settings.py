"""平台运行配置：统一的 .env、数据目录和运行模式。

两个业务模块共用一份配置。变量既可写在平台根目录的 ``.env``，也可由进程环境变量提供；
进程环境变量优先，便于服务器部署时由运维注入密钥。
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

PLATFORM_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = Path(os.getenv("TALENTFLOW_HR_ENV_FILE", str(PLATFORM_ROOT / ".env")))


def _load_env_file() -> None:
    if ENV_FILE.is_file():
        for name, value in dotenv_values(ENV_FILE).items():
            if value is not None and name not in os.environ:
                os.environ[name] = value
    # 人岗匹配核心沿用旧变量名，未单独配置时复用统一的模型网关和密钥。
    aliases = {
        "TALENTFLOW_MATCH_LLM_API_KEY": "TALENTFLOW_LLM_API_KEY",
        "TALENTFLOW_MATCH_LLM_BASE_URL": "TALENTFLOW_MODEL_BASE_URL",
    }
    for legacy, unified in aliases.items():
        if not os.environ.get(legacy) and os.environ.get(unified):
            os.environ[legacy] = os.environ[unified]


_load_env_file()

DATA_ROOT = Path(os.getenv("TALENTFLOW_HR_DATA_DIR", str(PLATFORM_ROOT / "data"))).resolve()
INTERVIEW_DATA_DIR = Path(os.getenv("TALENTFLOW_DATA_DIR", str(DATA_ROOT / "interview"))).resolve()
MATCHING_DATA_DIR = Path(os.getenv("TALENTFLOW_MATCHING_DATA_DIR", str(DATA_ROOT / "matching"))).resolve()
SECRETS_DIR = Path(os.getenv("TALENTFLOW_HR_SECRETS_DIR", str(PLATFORM_ROOT / ".secrets"))).resolve()

# 让人岗匹配核心与平台使用同一数据根目录。
os.environ.setdefault("TALENTFLOW_HR_DATA_DIR", str(DATA_ROOT))
os.environ.setdefault("TALENTFLOW_MATCHING_DATA_DIR", str(MATCHING_DATA_DIR))


def runtime_profile() -> str:
    return os.getenv("TALENTFLOW_RUNTIME_PROFILE", "production").strip().lower()


def is_test_runtime() -> bool:
    return runtime_profile() == "test"


def admin_entry_mode() -> str:
    """local：本机免登录管理入口；host：由主系统后端授权进入。"""
    return os.getenv("TALENTFLOW_ADMIN_ENTRY_MODE", "local").strip().lower()


def allowed_web_origins() -> list[str]:
    configured = os.getenv("TALENTFLOW_WEB_ORIGINS", "").strip()
    if configured:
        return [item.strip().rstrip("/") for item in configured.split(",") if item.strip()]
    # 默认接受本机的两个来源：前端开发服务器，以及由后端直接提供页面时后端自己的地址。
    ports = dict.fromkeys((os.getenv("TALENTFLOW_WEB_PORT", "5173").strip() or "5173",
                           os.getenv("TALENTFLOW_API_PORT", "8000").strip() or "8000"))
    return [f"http://{host}:{port}" for port in ports for host in ("localhost", "127.0.0.1")]


def int_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def matching_upload_limit() -> int:
    """单次匹配任务可上传的简历份数，可由环境变量调整。"""
    return int_setting("TALENTFLOW_MATCHING_UPLOAD_LIMIT", 20, 1, 500)


def comparison_default_limit() -> int:
    """候选人对比默认选中人数上限；0 表示该批次全部。"""
    return int_setting("TALENTFLOW_COMPARISON_DEFAULT_LIMIT", 0, 0, 500)
