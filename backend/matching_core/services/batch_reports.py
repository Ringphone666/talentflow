"""Batch exports always resolve their selection and review state from storage."""
from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from matching_core.config import DB_PATH, DECISIONS, DISCLAIMER, REPORT_DIR, load_brand
from matching_core.db import connect, decode_candidate, decode_candidate_job_match, decode_job, now_iso
from matching_core.services import report_style as style
from matching_core.services.audit import record_audit
from matching_core.services.auth import can
from matching_core.services.privacy import redact_sensitive
from matching_core.services.report import (
    _add_heading, _new_document, _paragraph, _save,
    build_fit_report, build_report, fit_report_readiness, report_readiness,
)
from matching_core.services.scoring import assessment_summary_data, score_sort_key, score_value

FIT_DECISIONS = {"推荐至该岗位", "作为备选岗位", "暂不推荐"}
_PATH = re.compile(r"(?i)(?:(?<![a-z0-9])[a-z]:[\\/]|\\\\)[^\r\n\"'<>，；。,;]+|(?<![\w:/])/(?:[^/\s\"'<>，；。]+/)+[^\s\"'<>，；。]+")
_SECRET = re.compile(r"(?i)\b(?:sk-[a-z0-9_-]{8,}|Bearer\s+[a-z0-9._-]+)|(?:api[_ -]?key|access[_ -]?token|password|secret|密钥)[\"']?\s*[:=：]\s*[\"']?[^\s，；。]+")


def _safe_text(value) -> str:
    text = redact_sensitive("" if value is None else str(value)).text
    return _SECRET.sub("[敏感配置已隐藏]", _PATH.sub("[路径已隐藏]", text))


def _safe_payload(value, key=""):
    if isinstance(value, dict):
        return {k: _safe_payload(v, k) for k, v in value.items()
                if k not in {"original_path", "redacted_path", "structured_path", "api_key", "key", "password", "token"}}
    if isinstance(value, list):
        return [_safe_payload(item, key) for item in value]
    if isinstance(value, str):
        if key in {"file", "source_file", "source_filename"}:
            value = value.replace("\\", "/").rsplit("/", 1)[-1]
        return _safe_text(value)
    return value


def _name(candidate):
    """姓名未确认的人员显示“姓名待确认（简历文件名）”，多人报告里才能区分。"""
    name = candidate.get("full_name") or candidate.get("masked_name")
    return _safe_text(style.person_label(name, candidate.get("source_filename", "")))


def _code(candidate):
    return _safe_text(candidate.get("parsed", {}).get("candidate_code") or candidate["id"])


def _filename(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", _safe_text(value)).strip(" .")
    return value[:70] or "批次"


def _snapshot(task_id, candidate_ids, operator, db_path):
    if not can(operator, "export_report"):
        raise PermissionError("当前角色无权导出报告")
    if isinstance(candidate_ids, (str, bytes)):
        raise ValueError("请选择本批次的候选人")
    selected = list(dict.fromkeys(candidate_ids))
    if not selected or any(not isinstance(cid, str) or not cid for cid in selected):
        raise ValueError("请至少选择一名本批次候选人")
    with connect(db_path) as conn:
        # One SQLite read transaction keeps jobs, reviews and candidates consistent.
        conn.execute("BEGIN")
        task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise KeyError("批次不存在")
        task = dict(task)
        candidates = {r["id"]: decode_candidate(dict(r)) for r in conn.execute(
            "SELECT * FROM candidates WHERE task_id=?", (task_id,))}
        if any(cid not in candidates for cid in selected):
            raise ValueError("所选候选人不属于当前批次或已被删除，请刷新后重新选择")
        fit = task.get("task_mode") == "人找岗位"
        job_ids = list(dict.fromkeys(json.loads(task.get("job_ids_json") or "[]") or [task["job_id"]]))
        if not fit:
            job_ids = [task["job_id"]]
            if any(candidates[cid]["job_id"] != task["job_id"] for cid in selected):
                raise ValueError("候选人与批次岗位不一致，请先核验批次数据")
        jobs = {}
        for job_id in job_ids:
            stored = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not stored:
                raise ValueError("批次岗位配置缺失，请先核验岗位资料")
            jobs[job_id] = decode_job(dict(stored))
        matches = {cid: [] for cid in selected}
        if fit:
            for stored in conn.execute("SELECT * FROM candidate_job_matches WHERE task_id=? ORDER BY id", (task_id,)):
                if stored["candidate_id"] in matches and stored["job_id"] in jobs:
                    matches[stored["candidate_id"]].append(decode_candidate_job_match(dict(stored)))
    label = str(task.get("batch_name") or "").strip()
    if not label:
        label = f"{'人才适岗' if fit else jobs[task['job_id']]['name']} {task.get('created_at', '')[:10]} {task['id']}"
    return dict(task=task, candidates=[candidates[cid] for cid in selected], matches=matches,
                jobs=jobs, fit=fit, batch_name=_safe_text(label))


def _analysis_state(score):
    if score.get("requires_reassessment"):
        return "待重新分析"
    if score.get("scoring_method") == "ai_semantic_v1" and score.get("reasoning_analysis", {}).get("status") not in (None, "", "调用成功"):
        return "待分析（分析失败）"
    return "待分析" if score_value(score) is None else "已分析"


NOT_CONFIRMED = "未确认"


def _manual(candidate, match=None, *, fit=False):
    """人工结论：只写人工确认过、仍然有效的结论；没有的写“未确认”，资料更新或分析未完成的写明原因。"""
    subject = match or candidate
    score = subject.get("score", {})
    decision = subject.get("decision")
    if score.get("requires_reassessment"):
        return "待重新分析后确认"
    if candidate.get("parse_status") != "人工已复核" or decision not in (FIT_DECISIONS if fit else DECISIONS):
        return NOT_CONFIRMED
    if _analysis_state(score) != "已分析":
        return "待分析后确认"
    return decision


def _score(score):
    if _analysis_state(score) != "已分析":
        return _analysis_state(score)
    return f"{score_value(score):.1f}"


def batch_report_readiness(candidate, matches, jobs, fit=False):
    _, missing = fit_report_readiness(matches) if fit else report_readiness(candidate)
    missing = list(missing)
    if fit:
        if candidate.get("parse_status") != "人工已复核":
            missing.append("候选人字段尚未完成人工确认")
        if {m["job_id"] for m in matches} != set(jobs):
            missing.append("部分岗位尚未完成分析")
        scores = [item["score"] for item in matches]
    else:
        scores = [candidate.get("score", {})]
    if any(_analysis_state(score).startswith("待分析") for score in scores):
        missing.append("评分尚未完成，请完成分析并人工复核后导出")
    return not missing, list(dict.fromkeys(missing))


def _csv_cell(value):
    text = _safe_text(value)
    # Leading whitespace/control characters must not bypass spreadsheet protection.
    if text.lstrip(" \t\r\n\ufeff").startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")):
        return "'" + text
    return text


def _audit(snapshot, selected, operator, db_path, export_type, filename, **extra):
    record_audit("批次报告导出", "批量任务", snapshot["task"]["id"], {}, {
        "导出类型": export_type, "批次名称": snapshot["batch_name"], "所选候选人": selected,
        "导出文件名": filename, **extra,
    }, operator, db_path)


def export_single_report(task_id, candidate_id, operator, db_path=DB_PATH) -> Path:
    """Create one official report with the same fresh review gate as a batch ZIP."""
    snapshot = _snapshot(task_id, [candidate_id], operator, db_path)
    candidate = snapshot["candidates"][0]
    matches = snapshot["matches"][candidate_id]
    ready, missing = batch_report_readiness(candidate, matches, snapshot["jobs"], snapshot["fit"])
    if not ready:
        raise ValueError("报告生成条件未满足：" + "；".join(missing))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_type = "人才适岗推荐报告" if snapshot["fit"] else "人岗匹配报告"
    output = REPORT_DIR / f"{report_type}_{_filename(_name(candidate))}_{uuid4().hex[:12]}.docx"
    safe = _safe_payload(candidate)
    try:
        if snapshot["fit"]:
            build_fit_report(safe, _safe_payload(matches), _safe_payload(snapshot["jobs"]), output)
        else:
            build_report(safe, _safe_payload(snapshot["jobs"][candidate["job_id"]]), output)
        with connect(db_path) as conn:
            conn.execute("INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)",
                         (candidate_id, str(output), now_iso(), operator))
        _audit(snapshot, [candidate_id], operator, db_path, "单人报告", output.name,
               流程="人才适岗" if snapshot["fit"] else "岗位选才")
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return output


def export_batch_reports(task_id, candidate_ids, operator, db_path=DB_PATH) -> dict:
    """Return path/exported/blocked; unready selections never enter the official ZIP."""
    snapshot = _snapshot(task_id, candidate_ids, operator, db_path)
    exported, blocked, ready_candidates = [], [], []
    for candidate in snapshot["candidates"]:
        ready, reasons = batch_report_readiness(candidate, snapshot["matches"][candidate["id"]], snapshot["jobs"], snapshot["fit"])
        item = {"candidate_id": candidate["id"], "name": _name(candidate)}
        if ready:
            ready_candidates.append(candidate)
            exported.append(item)
        else:
            blocked.append({**item, "reasons": reasons})
    result = dict(path=None, exported=exported, blocked=blocked, task_id=task_id, batch_name=snapshot["batch_name"])
    selected = [candidate["id"] for candidate in snapshot["candidates"]]
    if not ready_candidates:
        _audit(snapshot, selected, operator, db_path, "单人报告打包", "", 已导出=[], 未导出=blocked)
        return result
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    output = REPORT_DIR / f"{_filename(snapshot['batch_name'])}_单人报告_{uuid4().hex[:12]}.zip"
    csv_buffer = io.StringIO(newline="")
    writer = csv.writer(csv_buffer)
    writer.writerow(("批次名称", "候选人编号", "姓名", "岗位", "分析状态", "人工结论", "人工审核依据", "导出结果", "未导出原因"))
    blocked_by_id = {item["candidate_id"]: item for item in blocked}
    for candidate in snapshot["candidates"]:
        subjects = snapshot["matches"][candidate["id"]] if snapshot["fit"] else [candidate]
        for subject in subjects or [{"job_id": snapshot["task"]["job_id"], "score": {}}]:
            exclusion = blocked_by_id.get(candidate["id"])
            writer.writerow([_csv_cell(value) for value in (
                snapshot["batch_name"], _code(candidate), _name(candidate), snapshot["jobs"][subject["job_id"]]["name"],
                _analysis_state(subject.get("score", {})), _manual(candidate, subject, fit=snapshot["fit"]),
                subject.get("review_comment") or "未填写", "未导出" if exclusion else "已导出",
                "；".join(exclusion["reasons"]) if exclusion else "",
            )])
    try:
        with TemporaryDirectory(prefix="matching-batch-") as temporary, ZipFile(output, "w", ZIP_DEFLATED) as archive:
            for index, (candidate, item) in enumerate(zip(ready_candidates, exported), 1):
                # Ordinal and UUID prevent same names or duplicated candidate codes overwriting.
                filename = f"{index:03d}_{_filename(_name(candidate))}_{uuid4().hex[:8]}.docx"
                target = Path(temporary) / filename
                safe = _safe_payload(candidate)
                if snapshot["fit"]:
                    build_fit_report(safe, _safe_payload(snapshot["matches"][candidate["id"]]), _safe_payload(snapshot["jobs"]), target)
                else:
                    build_report(safe, _safe_payload(snapshot["jobs"][candidate["job_id"]]), target)
                archive.write(target, filename)
                item["filename"] = filename
            archive.writestr("审核摘要.csv", csv_buffer.getvalue().encode("utf-8-sig"))
        with connect(db_path) as conn:
            conn.executemany("INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)",
                             [(c["id"], str(output), now_iso(), operator) for c in snapshot["candidates"]])
        _audit(snapshot, selected, operator, db_path, "单人报告打包", output.name,
               已导出=[item["candidate_id"] for item in exported], 未导出=blocked)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    result["path"] = output
    return result


def _person_cell(candidate, width):
    """人员一格：姓名在上（未确认时带简历文件名），编号在下。"""
    return style.cell([[(_name(candidate), 9.5, True, style.INK), ("\n" + _code(candidate), 8.5, False, style.MUTED)]], width)


def _preferred(matches, jobs):
    """优先核验岗位：按综合匹配度排序后第一个满足推荐条件的岗位，与页面上的“推荐岗位”一致。"""
    ranked = sorted(matches, key=lambda match: score_sort_key(match["score"]), reverse=True)
    return next((match["job_id"] for match in ranked
                 if assessment_summary_data(match["score"], jobs[match["job_id"]])["recommended"]), None)


def _matrix_cell(candidate, match, width, preferred):
    """矩阵的一格：综合匹配度，其下是已确认的人工结论；没有分析结果的只写当前状态。

    已分析的按得分深浅着色，优先核验岗位加粗并标“★”。
    """
    if not match:
        return style.cell("待分析", width, align="center", color=style.MUTED)
    score, marked = match["score"], match["job_id"] == preferred
    analysed = _analysis_state(score) == "已分析"
    manual = _manual(candidate, match, fit=True)
    text = [[(("★ " if marked else "") + _score(score), 10.5 if analysed else 9.5, analysed, style.INK)]]
    if analysed and manual != NOT_CONFIRMED:
        text[0].append(("\n" + manual, 9, marked, style.INK))
    return style.cell(text, width, align="center", fill=style.heat_fill(score_value(score)) if analysed else None)


def _panel_widths(doc, shown, columns, share):
    """人员列（占版心的 share%）加若干等宽的列。最后一组不满时表格相应变窄，各组的列宽保持一致。"""
    total = style.content_width(doc)
    person = total * share // 100
    each = (total - person) // columns
    last = total - person - each * (columns - 1) if shown == columns else each
    return [person, *([each] * (shown - 1)), last]


def _matrix(doc, candidates, matches, jobs, panel, columns):
    widths = _panel_widths(doc, len(panel), columns, 30)
    lines = [style.header_cells(["人员", *(jobs[job_id]["name"] for job_id in panel)], widths,
                                range(1, len(panel) + 1), size=9)]
    for candidate in candidates:
        own = {match["job_id"]: match for match in matches[candidate["id"]]}
        preferred = _preferred(matches[candidate["id"]], jobs)
        lines.append([_person_cell(candidate, widths[0]),
                      *(_matrix_cell(candidate, own.get(job_id), width, preferred) for job_id, width in zip(panel, widths[1:]))])
    style.grid_table(doc, lines, header_rows=1)


def _people_table(doc, candidates):
    widths = style.spread((5.2, 7.6, 4.2), style.content_width(doc))
    lines = [style.header_cells(("人员及编号", "综合匹配度", "人工结论"), widths, (1, 2))]
    for candidate in candidates:
        score = candidate["score"]
        analysed = _analysis_state(score) == "已分析"
        lines.append([
            _person_cell(candidate, widths[0]),
            # 没有形成综合匹配度的只写当前状态（待分析、待重新分析等），不画条。
            *style.bar_cells(widths[1], score_value(score) if analysed else None, _score(score)),
            style.cell(_manual(candidate), widths[2], align="center"),
        ])
    style.grid_table(doc, lines, header_rows=1)


def _dimension_table(doc, candidates, job, panel, columns):
    widths = _panel_widths(doc, len(panel), columns, 22)
    lines = [style.header_cells(["人员", *(f"{name}\n权重{float(job['weights'][name]):g}%" for name in panel)], widths,
                                range(1, len(panel) + 1), size=9)]
    for candidate in candidates:
        values = {d["dimension"]: d for d in candidate["score"].get("dimensions", [])}
        line = [style.cell(_name(candidate), widths[0], bold=True)]
        for name, width in zip(panel, widths[1:]):
            dimension = values.get(name, {})
            scored = (_analysis_state(candidate["score"]) == "已分析" and dimension.get("score") is not None
                      and dimension.get("evidence_available", True))
            line.append(style.cell(f"{dimension['score']:.1f}" if scored else "待核实", width, align="center",
                                   color=style.INK if scored else style.MUTED,
                                   fill=style.heat_fill(dimension["score"]) if scored else None))
        lines.append(line)
    style.grid_table(doc, lines, header_rows=1)


def _summary_card(doc, candidates, matches, jobs, fit):
    """结果摘要卡：对比范围、已形成综合匹配度的数量和人工结论的分布。"""
    subjects = [(c, m) for c in candidates for m in matches[c["id"]]] if fit else [(c, c) for c in candidates]
    analysed = [(score_value(s["score"]), c) for c, s in subjects if _analysis_state(s.get("score", {})) == "已分析"]
    decisions = Counter(_manual(c, s, fit=fit) for c, s in subjects)
    unit = "组" if fit else "人"
    if fit:
        total = len(candidates) * len(jobs)
        # 还没有分析结果的人岗组合也没有人工结论。
        decisions[NOT_CONFIRMED] += total - len(subjects)
        first = [(1, style.metric("选中人数", len(candidates), " 人")), (1, style.metric("参与岗位", len(jobs), " 个"))]
        progress = style.fact("已完成分析", f"{len(analysed)}/{total} 个人岗组合")
    else:
        top = max(analysed, key=lambda item: item[0], default=None)
        first = [(1, style.metric("选中人数", len(candidates), " 人")),
                 (1, style.metric("已形成综合匹配度", len(analysed), " 人"))]
        progress = style.fact("最高综合匹配度", f"{top[0]:.1f}（{_name(top[1])}）" if top else "暂无")
    # 每一项内部用不换行空格，换行只发生在两项之间。
    counts = "；".join(f"{name}\u00a0{count}\u00a0{unit}" for name, count in decisions.items() if count)
    style.card(doc, [first, [(4, progress), (7, style.fact("人工结论", counts or "暂无", size=10))]])


def _key_evidence(subject, score):
    """逐人分析里的关键材料依据：原文和出处，最多两条。"""
    evidence = []
    for dimension in score.get("dimensions", []):
        for item in dimension.get("evidence", []):
            if item.get("text"):
                evidence.append(f"{item['text']}（{item.get('file') or '来源未记录'} · {item.get('location') or '位置未记录'}）")
    for tag in subject.get("tags", []):
        if tag.get("evidence") and tag["evidence"] != "无充分证据":
            evidence.append(f"{tag['evidence']}（{tag.get('source_file') or '来源未记录'} · {tag.get('location') or '位置未记录'}）")
    return list(dict.fromkeys(evidence))[:2]


def _person_details(doc, candidate, subjects, jobs, fit):
    _add_heading(doc, f"{_name(candidate)} {_code(candidate)}", 2)
    if not subjects:
        _paragraph(doc, "待分析：尚无岗位匹配结果，也没有人工结论。")
        return
    for subject in subjects:
        score = subject.get("score", {})
        job = jobs[subject["job_id"]]
        _add_heading(doc, job["name"], 3)
        manual = _manual(candidate, subject, fit=fit)
        # 综合匹配度一格在没有分析结果时写当前状态（待分析、待重新分析等）。
        items = [[("综合匹配度", _score(score)), ("人工结论", manual)]]
        if _analysis_state(score) == "已分析":
            summary = assessment_summary_data(score, job)
            items.append([("辅助分析结论", summary["conclusion"] + "。" + summary["evidence_summary"])])
            for label, key in (("主要优势", "strengths"), ("差距及待核实项", "gaps"), ("风险提示", "risks")):
                values = summary.get(key) or []
                items.append([(label, "\n".join(values[:2]) if values else "暂无明确记录，仍需人工核验。")])
            items.append([("关键材料依据", "\n".join(_key_evidence(subject, score)) or "暂无可定位证据，需补充原始材料。")])
        else:
            items.append([("分析说明", "当前分析不能作为正式评估结论；请完成最新材料分析并人工复核。")])
        if subject.get("review_comment"):
            items.append([("复核意见", subject["review_comment"])])
        if subject.get("decision") and manual != subject["decision"]:
            items.append([("历史保存的人工意见", subject["decision"] + "；当前尚未满足正式确认条件。")])
        style.pairs(doc, items, label=1700)


def export_comparison_report(task_id, candidate_ids, operator, db_path=DB_PATH) -> Path:
    """Export selected people with explicit pending states; never infer human approval."""
    snapshot = _snapshot(task_id, candidate_ids, operator, db_path)
    safe = _safe_payload(snapshot)
    candidates, jobs, fit = safe["candidates"], safe["jobs"], safe["fit"]
    mode = "人才适岗" if fit else "岗位选才"
    doc = _new_document(f"{load_brand().get('company', 'TalentFlow')}{mode}多人对比报告", f"{mode}多人对比报告")
    scope = ("参与岗位", f"{len(jobs)} 个") if fit else ("目标岗位", jobs[safe["task"]["job_id"]]["name"])
    style.info_line(doc, [("批次名称", safe["batch_name"]), scope, ("选中人数", len(candidates)),
                          ("生成时间", style.now_text())])
    _summary_card(doc, candidates, safe["matches"], jobs, fit)
    _paragraph(doc, "本报告汇总所选人员的材料分析和人工结论，供招聘人员和用人部门比较。尚未确认人工结论或尚未完成分析的人员按当前状态列出，不代表通过。")
    style.note(doc, DISCLAIMER, label="说明：", after=0)
    style.note(doc, "综合匹配度采用完整岗位权重计算；缺少证据不等于能力为零，辅助分析结论不代表人工通过。")
    if fit:
        _add_heading(doc, "人员与岗位匹配矩阵")
        for legend in ("单元格列出综合匹配度，其下是已确认的人工结论；底色越深表示综合匹配度越高。各岗位采用自身评价标准，分数须结合岗位要求和材料依据判断。",
                       "★ 为优先核验岗位：综合匹配度不低于 65 分，各维度均已形成得分，硬性条件没有不满足或待核实项；是否推荐以人工结论为准。"):
            # 图例与矩阵留在同一页。
            _paragraph(doc, legend, secondary=True).paragraph_format.keep_with_next = True
        job_ids = list(jobs)
        # Four roles per panel retain legibility for arbitrarily wide batches.
        for offset in range(0, len(job_ids), 4):
            if len(job_ids) > 4:
                _add_heading(doc, f"岗位组 {offset // 4 + 1}", 2)
            _matrix(doc, candidates, safe["matches"], jobs, job_ids[offset:offset + 4], min(len(job_ids), 4))
    else:
        job = jobs[safe["task"]["job_id"]]
        _add_heading(doc, "同一岗位人员对比")
        p = _paragraph(doc, f"目标岗位：{job['name']}　岗位说明书版本：{job.get('jd_version') or '未填写'}")
        p.paragraph_format.keep_with_next = True
        _people_table(doc, candidates)
        dimensions = list(job.get("weights", {}))
        for offset in range(0, len(dimensions), 4):
            _add_heading(doc, "维度评分对比" + (f" {offset // 4 + 1}" if len(dimensions) > 4 else ""), 2)
            _dimension_table(doc, candidates, job, dimensions[offset:offset + 4], min(len(dimensions), 4))
        if dimensions:
            _paragraph(doc, "底色越深表示该维度得分越高；“待核实”表示该维度尚未形成得分，不按 0 分处理。", secondary=True)
    _add_heading(doc, "逐人简要分析")
    for candidate in candidates:
        subjects = safe["matches"][candidate["id"]] if fit else [candidate]
        _person_details(doc, candidate, subjects, jobs, fit)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    output = REPORT_DIR / f"{_filename(safe['batch_name'])}_多人对比_{uuid4().hex[:12]}.docx"
    selected = [candidate["id"] for candidate in snapshot["candidates"]]
    try:
        _save(doc, output)
        with connect(db_path) as conn:
            conn.executemany("INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)",
                             [(cid, str(output), now_iso(), operator) for cid in selected])
        _audit(snapshot, selected, operator, db_path, "多人对比报告", output.name, 流程=mode)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return output
