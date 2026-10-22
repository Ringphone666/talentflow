"""Editable material copies and explicit provenance, without changing source files."""
from __future__ import annotations

import copy
import json
import re

from matching_core.services.privacy import contains_unmasked_sensitive, mask_name


MATERIAL_FIELD_LABELS = {
    'education': '教育经历', 'work_experience': '工作经历', 'projects': '项目经历',
    'skills': '专业技能', 'tenure': '任职时间', 'interview_evaluation': '面试评价',
    'additional_material': '补充资料',
}
EMPTY_MATERIAL_VALUES = {'', '待人工确认', '无充分证据', '未识别', '未提供', '暂无'}


def material_value(value):
    value = str(value or '').strip()
    return '' if value in EMPTY_MATERIAL_VALUES else value


def has_material_content(parsed):
    return any(material_value(field.get('value')) for field in parsed.get('fields', {}).values())


def prepare_material_update(parsed, fields, *, full_name=None, confirmed=True):
    """Return a new reviewed copy; changed keys describe content, not confirmation."""
    if not isinstance(fields, dict) or set(fields) - set(MATERIAL_FIELD_LABELS):
        raise ValueError('资料字段不合法，请刷新后重试')
    if any(not isinstance(value, str) for value in fields.values()):
        raise ValueError('资料内容必须是文本')
    result = copy.deepcopy(parsed)
    result.setdefault('fields', {})
    version = int(result.get('material_version', 0)) + 1
    changed = []
    for key, label in MATERIAL_FIELD_LABELS.items():
        field = result['fields'].setdefault(key, {})
        defaults = dict(label=label, value='', status='待人工确认', evidence='无充分证据',
                        source_file='', location='未定位到相关证据')
        for name, default in defaults.items():
            field.setdefault(name, default)
    if full_name is not None:
        if not isinstance(full_name, str) or not full_name.strip() or full_name.strip() == '待人工确认':
            raise ValueError('请填写候选人姓名后保存')
        name = full_name.strip()
        if len(name) > 100 or '\n' in name or '\r' in name:
            raise ValueError('姓名应为100字以内的单行文本')
        if name != result.get('full_name'):
            changed.append('full_name')
        result.update(full_name=name, masked_name=mask_name(name), name_manually_edited=True)
    evidence = copy.deepcopy(result.get('raw_evidence', []))
    values = dict(fields)
    if confirmed:
        # Confirmation applies to the whole saved copy, including a draft saved
        # in an earlier request and now confirmed without resending its fields.
        values = {key: field.get('value', '') for key, field in result['fields'].items()
                  if key in MATERIAL_FIELD_LABELS} | values
    for key, value in values.items():
        field = result['fields'][key]
        value = material_value(value)
        different = value != material_value(field.get('value'))
        if different:
            changed.append(key)
            field.setdefault('original_reference', {name: copy.deepcopy(field.get(name, ''))
                             for name in ('value', 'evidence', 'source_file', 'location')})
            field['manual_modified'] = True
        field.update(value=value, status='人工已确认' if confirmed else '人工已修改，待确认',
                     manual_override=True)
        if field.get('manual_modified'):
            field.update(evidence=value or '工作人员已清空该字段，尚无可用证据',
                         source_file='人工核实记录', location=f"字段：{field['label']}；资料版本{version}")
            evidence = [item for item in evidence if not (item.get('origin') == 'human_review' and item.get('field_key') == key)]
            evidence.append(dict(text=f"人工核实{field['label']}：{value or '工作人员已清空提取值，尚待补充核实'}。该记录为当前人工修正，不视为原文。",
                                 file='人工核实记录', location=field['location'], origin='human_review',
                                 field_key=key, cleared=not bool(value), confirmed=bool(confirmed)))
    result.update(raw_evidence=evidence, material_version=version, manual_confirmed=bool(confirmed),
                  parse_status='人工已复核' if confirmed else '待人工确认')
    if contains_unmasked_sensitive(json.dumps(result, ensure_ascii=False)):
        raise ValueError('人工修正内容包含未脱敏手机号或身份证号，请先脱敏')
    return result, changed


def effective_material_evidence(parsed):
    """Use current corrections for analysis; retain untouched original evidence separately."""
    fields = parsed.get('fields', {})
    revised = {key: field for key, field in fields.items() if field.get('manual_modified')}
    latest = {item.get('field_key'): item for item in parsed.get('raw_evidence', [])
              if item.get('origin') == 'human_review'}
    result = []
    for item in parsed.get('raw_evidence', []):
        if item.get('origin') == 'human_review':
            continue
        text = item.get('text', '').strip()
        current_text = text
        for field in revised.values():
            original = field.get('original_reference', {})
            original_text = material_value(original.get('evidence')) or material_value(original.get('value'))
            source = str(original.get('source_file') or '')
            same_source = bool(item.get('file')) and str(item['file']) in source
            # PDF/OCR locators can identify a whole page. Sharing that locator
            # must not erase unrelated education, projects, or experience.
            lines = []
            labels = '|'.join(re.escape(label) for label in MATERIAL_FIELD_LABELS.values())
            for line in current_text.splitlines():
                for segment in re.split(rf'(?=(?:{labels})\s*[:：])', line):
                    labelled = re.match(re.escape(field.get('label', '')) + r'\s*[:：]', segment.strip())
                    if labelled:
                        continue
                    if same_source and original_text and original_text in segment:
                        segment = segment.replace(original_text, '').strip(' ；;，,')
                    if segment.strip():
                        lines.append(segment)
            current_text = '\n'.join(lines)
        if current_text:
            remaining = copy.deepcopy(item)
            remaining['text'] = current_text
            if current_text != text:
                remaining['review_filter'] = '已排除人工修改字段的旧提取片段'
            result.append(remaining)
    for key, item in latest.items():
        if key == 'full_name':
            continue
        # An explicit clear is a constraint, never supporting evidence for a score.
        if key in revised and not material_value(revised[key].get('value')):
            continue
        result.append(copy.deepcopy(item))
    return result


def material_text(parsed):
    return '\n'.join(item['text'] for item in effective_material_evidence(parsed))


def material_for_analysis(parsed):
    result = copy.deepcopy(parsed)
    result['raw_evidence'] = effective_material_evidence(parsed)
    return result
