import json
from pathlib import Path

from ..core.database import DATA_DIR

CONFIG_DIR = DATA_DIR / "config"
RULES_FILE = CONFIG_DIR / "sensitive-rules.json"
NOTICE_FILE = CONFIG_DIR / "consent-notice.json"

DEFAULT_RULES = {
    "年龄歧视": ["年龄", "几岁", "太老", "太年轻"],
    "性别歧视": ["性别", "男性优先", "女性不适合"],
    "地域歧视": ["哪里人", "外地人", "地域"],
    "民族和宗教": ["民族", "宗教", "信仰"],
    "婚育和家庭隐私": ["婚姻", "结婚", "怀孕", "生育", "孩子"],
    "健康隐私": ["病史", "残疾", "体检结果", "健康隐私"],
    "侮辱性内容": ["蠢", "没用", "废物", "羞辱"],
    "与岗位无关的私人信息": ["身份证", "家庭住址", "私人关系", "父母收入"],
}
DEFAULT_NOTICE = {
    "version": "INTERVIEW-TWO-STAGE-3.0",
    "text": "本次告知覆盖第一阶段AI面试和第二阶段人工面试AI旁听：仅采集音频，不采集视频；音频发送至火山引擎豆包转写，录音、原始转写和时间信息本地留存。转写与第一阶段报告交给文本模型辅助提问和汇总，须人工复核，不自动决定录用。拒绝后不启动采集。",
}


def _read(path: Path, fallback):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, type(fallback)) else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def sensitive_rules():
    return _read(RULES_FILE, DEFAULT_RULES)


def save_sensitive_rules(value: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    RULES_FILE.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def consent_notice():
    return _read(NOTICE_FILE, DEFAULT_NOTICE)


def save_consent_notice(value: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    NOTICE_FILE.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
