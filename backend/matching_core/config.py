"""人岗匹配核心的路径与常量。

数据目录由 ``TALENTFLOW_HR_DATA_DIR`` 统一指定（默认 ``<平台根目录>/data``），
人岗匹配的数据库和附件位于其下的 ``matching`` 子目录；配置文件位于 ``backend/config``。
"""
from __future__ import annotations

import json
import os
from pathlib import Path


PLATFORM_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PLATFORM_ROOT / "backend"
# 旧代码用 BASE_DIR 定位 .env；统一后模型配置放在平台根目录的 .env。
BASE_DIR = PLATFORM_ROOT
DATA_ROOT = Path(os.getenv("TALENTFLOW_HR_DATA_DIR", str(PLATFORM_ROOT / "data"))).resolve()
DATA_DIR = Path(os.getenv("TALENTFLOW_MATCHING_DATA_DIR", str(DATA_ROOT / "matching"))).resolve()
CONFIG_DIR = Path(os.getenv("TALENTFLOW_MATCHING_CONFIG_DIR", str(BACKEND_DIR / "config"))).resolve()
ASSETS_DIR = BACKEND_DIR / "assets"
DB_PATH = DATA_DIR / "matching.db"
ORIGINAL_DIR = DATA_DIR / "uploads" / "original"
REDACTED_DIR = DATA_DIR / "redacted"
STRUCTURED_DIR = DATA_DIR / "structured"
REPORT_DIR = DATA_DIR / "reports"
QUEUE_DIR = DATA_DIR / "queue"

DISCLAIMER = (
    "本报告由人岗匹配智能体根据候选人材料和岗位配置生成，仅作为招聘筛选与决策参考，"
    "不构成自动录用或淘汰决定。最终决策由招聘人员和用人部门作出。"
)
DECISIONS = ("进入下一轮", "保留", "淘汰")
ROLES = ("招聘人员", "用人部门", "面试官")

DEFAULT_BRAND = {
    "company": "TalentFlow",
    "primary": "#197465",
    "secondary": "#12B58E",
    "accent": "#2EAD67",
    "warning": "#C98D58",
    "danger": "#E5483F",
    "info": "#2E74FD",
    "font": "Microsoft YaHei",
}


_DATA_FOLDERS = ("uploads", "redacted", "structured", "reports", "queue", "talent")


def portable_path(value: str | Path | None, data_dir: Path | None = None, *, prefer_current: bool = False) -> str:
    """把库里保存的绝对路径换算到当前数据目录。

    数据库和队列载荷保存的是写入时的绝对路径。整个数据目录迁移到另一台机器或另一个位置后，
    原路径不再存在，这里按数据目录内的相对位置重新定位，调用方无需先做路径改写。
    prefer_current 用于数据迁移：即使原路径仍然存在，也改用当前数据目录中的同名文件。
    """
    text = str(value or "")
    if not text or (not prefer_current and Path(text).exists()):
        return text
    parts = [part for part in text.replace("\\", "/").split("/") if part]
    root = Path(data_dir) if data_dir else DATA_DIR
    for index in range(len(parts) - 1, 0, -1):
        if parts[index] in _DATA_FOLDERS and parts[index - 1] in ("data", "matching", root.name):
            candidate = root.joinpath(*parts[index:])
            return str(candidate) if candidate.exists() else text
    return text


def ensure_directories() -> None:
    for path in (DATA_DIR, ORIGINAL_DIR, REDACTED_DIR, STRUCTURED_DIR, REPORT_DIR, QUEUE_DIR):
        path.mkdir(parents=True, exist_ok=True)


def load_brand() -> dict:
    path = CONFIG_DIR / "brand.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return DEFAULT_BRAND.copy()
