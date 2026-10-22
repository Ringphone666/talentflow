from __future__ import annotations

import re
from dataclasses import dataclass


PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d{9})(?!\d)")
ID_RE = re.compile(r"(?<![0-9A-Za-z])(\d{17}[0-9Xx])(?![0-9A-Za-z])")


@dataclass(frozen=True)
class RedactionResult:
    text: str
    detected: bool
    types: list[str]
    counts: dict[str, int]


def mask_phone(value: str) -> str:
    return f"{value[:3]}****{value[-4:]}"


def mask_id(value: str) -> str:
    return f"{value[:6]}********{value[-4:]}"


def redact_sensitive(text: str) -> RedactionResult:
    phone_matches = PHONE_RE.findall(text)
    id_matches = ID_RE.findall(text)
    redacted = PHONE_RE.sub(lambda m: mask_phone(m.group(1)), text)
    redacted = ID_RE.sub(lambda m: mask_id(m.group(1)), redacted)
    types = []
    if phone_matches:
        types.append("中国大陆11位手机号")
    if id_matches:
        types.append("18位中国大陆身份证号")
    return RedactionResult(
        text=redacted,
        detected=bool(types),
        types=types,
        counts={"手机号": len(phone_matches), "身份证号": len(id_matches)},
    )


def contains_unmasked_sensitive(text: str) -> bool:
    return bool(PHONE_RE.search(text) or ID_RE.search(text))


def mask_name(name: str) -> str:
    name = name.strip()
    if not name or name == "待人工确认":
        return "待人工确认"
    return name[0] + "*" * max(1, len(name) - 1)

