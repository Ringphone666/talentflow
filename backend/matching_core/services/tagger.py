from __future__ import annotations

from typing import Any


def build_tags(
    redacted_text: str,
    job: dict[str, Any],
    line_evidence: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    tags: list[dict[str, Any]] = []
    text_lower = redacted_text.lower()
    evidence_items = line_evidence or [
        {"text": line.strip(), "file": "候选人脱敏材料", "location": f"第{line_number}行"}
        for line_number, line in enumerate(redacted_text.splitlines(), 1)
        if line.strip()
    ]
    for dimension in job["dimensions"]:
        name = dimension["name"]
        keywords = dimension.get("keywords", [])
        hits = [keyword for keyword in keywords if keyword.lower() in text_lower]
        if hits:
            score = min(100, 35 + len(hits) * 15)
            matched_items = [
                item for item in evidence_items
                if any(keyword.lower() in item["text"].lower() for keyword in hits)
            ][:3]
            if not matched_items:
                matched_items = [
                    {"text": line.strip(), "file": "候选人脱敏材料", "location": f"第{line_number}行"}
                    for line_number, line in enumerate(redacted_text.splitlines(), 1)
                    if line.strip() and any(keyword.lower() in line.lower() for keyword in hits)
                ][:3]
            evidence = "；".join(item["text"] for item in matched_items)
            source_files = list(dict.fromkeys(item["file"] for item in matched_items))
            if len(source_files) == 1:
                location = "、".join(item["location"] for item in matched_items)
            else:
                location = "；".join(f"{item['file']} {item['location']}" for item in matched_items)
            tags.append({
                "name": "、".join(hits[:3]), "dimension": name, "score": score,
                "evidence": evidence, "source_file": "、".join(source_files),
                "location": location, "confidence": round(min(0.96, 0.55 + len(hits) * 0.09), 2),
                "needs_confirmation": bool("证据冲突" in redacted_text),
            })
        else:
            tags.append({
                "name": "无充分证据", "dimension": name, "score": 0,
                "evidence": "无充分证据", "source_file": "候选人脱敏材料",
                "location": "未定位到相关行", "confidence": 0.0,
                "needs_confirmation": True,
            })
    return tags
