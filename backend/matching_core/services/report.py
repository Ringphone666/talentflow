from __future__ import annotations

from datetime import datetime
from pathlib import Path

from matching_core.config import DECISIONS, DISCLAIMER, REPORT_DIR, load_brand
from matching_core.db import connect, decode_candidate, decode_candidate_job_match, decode_job, now_iso, row, rows
from matching_core.services import report_style as style
from matching_core.services.audit import record_audit
from matching_core.services.scoring import assessment_summary_data, score_sort_key, score_value


def _candidate_name(candidate: dict) -> str:
    name = candidate.get("full_name") or candidate.get("parsed", {}).get("full_name") or candidate.get("masked_name")
    return style.person_label(name, candidate.get("source_filename", ""))


def report_readiness(candidate: dict) -> tuple[bool, list[str]]:
    """Human-confirmed fields and a final decision are mandatory for export."""
    missing: list[str] = []
    if candidate.get("parse_status") != "人工已复核":
        missing.append("候选人字段尚未完成人工确认")
    if candidate.get("decision") not in DECISIONS:
        missing.append("尚未保存人工最终决策")
    if candidate.get("score", {}).get("requires_reassessment"):
        missing.append("候选人材料或岗位标准已更新，请重新分析后再导出报告")
    return not missing, missing


def fit_report_readiness(matches: list[dict]) -> tuple[bool, list[str]]:
    if not matches:
        return False, ["暂无岗位匹配结果"]
    if any(item.get("score", {}).get("requires_reassessment") for item in matches):
        return False, ["候选人材料或岗位标准已更新，请重新分析相关岗位后再导出报告"]
    if not any(item.get("decision") in {"推荐至该岗位", "作为备选岗位", "暂不推荐"} for item in matches):
        return False, ["尚未保存人工岗位推荐结论"]
    return True, []


# ---- 版式：页面、段落和表格的样式统一在 report_style 中定义 ---------------------------

def _new_document(title, report_type=""):
    return style.new_document(title, report_type)


def _paragraph(doc, text, *, bold=False, secondary=False):
    return style.paragraph(doc, str(text), size=9.5 if secondary else 10.5, bold=bold,
                           color=style.MUTED if secondary else style.INK)


def _add_heading(doc, text, level=1):
    return style.heading(doc, text, level)


def _add_bullets(doc, values):
    style.bullets(doc, values)


def _table(doc, headers, records, widths, centered=(), split=False):
    """widths 只表示各列的比例，表格总宽等于版心宽度。"""
    return style.table(doc, headers, records, widths, centered, split=split)


def _save(doc, output_path):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_path)
    return output_path


def _score_metric(score):
    """摘要卡里的综合匹配度：大号数字；没有形成综合匹配度时写“待评估”，不写 0 分。"""
    value = score_value(score)
    if value is None:
        return style.metric("综合匹配度", "待评估", size=16)
    return style.metric("综合匹配度", f"{value:.1f}", " / 100")


def _hard_summary(score) -> str:
    checks = score.get("hard_checks", [])
    if not checks:
        return "岗位未配置硬性条件"
    passed = sum(item.get("status") == "满足" for item in checks)
    failed = sum(item.get("status") == "不满足" for item in checks)
    return f"满足 {passed} 项 / 不满足 {failed} 项 / 待核实 {len(checks) - passed - failed} 项"


def _overview(doc, score, job, decision, label="人工结论"):
    """结果摘要卡：综合匹配度、匹配结论、覆盖岗位权重、人工结论和硬性条件核验结果。"""
    summary = assessment_summary_data(score, job)
    coverage = [[("覆盖岗位权重", 9, False, style.MUTED)],
                [(f"{summary['coverage_percent']:g}%", 11, True, style.INK),
                 (f"（{summary['evidence_summary'].split(' · ')[0]}）", 9, False, style.MUTED)]]
    style.card(doc, [
        [(5, _score_metric(score)), (6, style.inline_fact("匹配结论", summary["conclusion"]))],
        [(3, coverage), (3, style.fact(label, decision)), (5, style.fact("硬性条件核验", _hard_summary(score)))],
    ])
    _paragraph(doc, "材料支持范围：" + summary["evidence_summary"] + "。" + summary["score_note"], secondary=True)
    return summary


def _job_context(doc, job):
    items = [[("岗位", job.get("name", "未命名岗位")), ("岗位说明书版本", job.get("jd_version") or "未填写")],
             [("岗位类别", job.get("sequence") or "未填写"), ("职级", job.get("level") or "未填写")]]
    for label, key in (("岗位职责", "responsibilities"), ("任职要求", "requirements")):
        values = job.get(key) or []
        if isinstance(values, str):
            values = [values]
        if values:
            items.append([(label, "\n".join(str(value) for value in values))])
    style.pairs(doc, items)


def _dimensions(doc, score, level=1):
    _add_heading(doc, "各维度评分", level)
    widths = style.spread((4.6, 7.0, 2.2, 3.2), style.content_width(doc))
    lines = [style.header_cells(("岗位评价维度", "单项得分", "岗位权重", "综合分贡献"), widths, (1, 2, 3))]
    for item in score.get("dimensions", []):
        available = item.get("score") is not None and item.get("evidence_available", True)
        weight = float(item.get("weight", 0) or 0)
        value = float(item["score"]) if available else None
        lines.append([
            style.cell(item.get("dimension", "未命名维度"), widths[0]),
            # 没有得分的维度只写说明，不画条，也不按 0 分处理。
            *style.bar_cells(widths[1], value, f"{value:.1f}" if available else "未形成得分 · 待补充证据"),
            style.cell(f"{weight:g}%", widths[2], align="center"),
            style.cell(f"{value * weight / 100:.1f}" if available else "未确认贡献", widths[3], align="center",
                       color=style.INK if available else style.MUTED),
        ])
    if len(lines) > 1:
        # 评分表是一张图，维度不多时整体留在同一页。
        style.grid_table(doc, lines, header_rows=1, together=len(lines) <= 12)
        _paragraph(doc, "横条长度表示单项得分（满分 100）；综合分贡献 = 单项得分 × 岗位权重。", secondary=True)
    else:
        _paragraph(doc, "评分尚未完成，请补充材料或重新评估。")


def _status_cell(status, width):
    """检查结果：满足用主色，不满足用警示色标出，其余为待核实。"""
    if status == "满足":
        return style.cell(status, width, align="center", bold=True, color=style.BRAND)
    if status == "不满足":
        return style.cell(status, width, align="center", bold=True, fill=style.WARN_PALE,
                          edges={"left": (style.WARN, 18)})
    return style.cell(status, width, align="center", color=style.MUTED)


def _hard_checks(doc, score, level=1):
    _add_heading(doc, "硬性条件检查", level)
    checks = score.get("hard_checks", [])
    if not checks:
        _paragraph(doc, "当前岗位未配置硬性条件；请结合岗位说明书人工确认。")
        return
    widths = style.spread((5.2, 2.4, 9.4), style.content_width(doc))
    lines = [style.header_cells(("硬性条件", "检查结果", "检查依据"), widths, (1,))]
    for item in checks:
        lines.append([
            style.cell(item.get("condition", item.get("name", "未命名条件")), widths[0]),
            _status_cell(item.get("status", "待核实"), widths[1]),
            style.cell(item.get("reason") or item.get("evidence") or "待补充材料核验", widths[2]),
        ])
    style.grid_table(doc, lines, header_rows=1)


def _analysis(doc, summary, level=1):
    for heading, key, fallback in (
        ("关键优势", "strengths", "现有材料不足以确认岗位优势。"),
        ("主要短板与待核实差距", "gaps", "暂未识别明确差距，请结合原始材料复核。"),
        ("风险提示", "risks", "当前未发现额外风险，仍需人工核验。"),
        ("建议核验材料", "verification", "核对岗位说明书与候选人原始材料。"),
        ("建议结构化面试问题", "questions", "请候选人结合实际项目说明如何完成该岗位核心职责。"),
    ):
        _add_heading(doc, heading, level)
        if key == "questions":
            style.numbered(doc, summary.get(key) or [fallback])
        else:
            _add_bullets(doc, summary.get(key) or [fallback])
    _add_heading(doc, "AI辅助建议", level)
    _paragraph(doc, summary["next_step"])


def _unique(entries):
    """去掉空白和重复的证据，保持原有顺序。"""
    result = []
    for text, source, location in entries:
        entry = (str(text), str(source), str(location))
        if entry[0].strip() and entry not in result:
            result.append(entry)
    return result


def _evidence_groups(score, tags):
    """按评价维度归集证据。返回 [(维度, 评分依据, 证据)] 和不属于任何维度的其他引用材料。"""
    tagged = {}
    for item in tags or []:
        if str(item.get("evidence") or "").strip() not in ("", "无充分证据"):
            tagged.setdefault(item.get("dimension"), []).append(
                (item["evidence"], item.get("source_file", ""), item.get("location", "")))
    groups, shown = [], set()
    for item in score.get("dimensions", []):
        name = item.get("dimension", "未命名维度")
        entries = _unique([(entry.get("text", ""), entry.get("file", ""), entry.get("location", ""))
                           for entry in item.get("evidence", [])] + tagged.pop(name, []))
        shown.update(entries)
        groups.append((name, item.get("reason"), entries))
    others = [entry for entries in tagged.values() for entry in entries]
    reasoning = score.get("reasoning_analysis") or {}
    for section_key in ("sections", "comprehensive_sections"):
        for entries in reasoning.get(section_key, {}).values():
            for item in entries:
                others += [(entry.get("text", ""), entry.get("file", ""), entry.get("location", ""))
                           for entry in item.get("evidence", [])]
    return groups, [entry for entry in _unique(others) if entry not in shown]


def _quotes(doc, entries):
    for text, source, location in entries:
        style.quote(doc, text, (source or "未记录") + " · " + (location or "未记录"))


def _evidence(doc, score, tags, level=1):
    _add_heading(doc, "关键证据", level)
    reasoning = score.get("reasoning_analysis") or {}
    state = []
    if reasoning.get("model") in ("chat-primary", "chat-evaluation", "chat-reasoner"):
        state.append("分析模型：" + reasoning["model"])
    if reasoning.get("status"):
        state.append("分析状态：" + str(reasoning["status"]))
    if state:
        _paragraph(doc, "　　".join(state), secondary=True)
    assessed = score.get("scoring_method") == "ai_semantic_v1"
    groups, others = _evidence_groups(score, tags)
    if assessed or any(entries for _, _, entries in groups):
        _paragraph(doc, ("AI逐项评分依据和引用的材料原文" if assessed else "引用的材料原文")
                   + "按评价维度列出；原文以左侧竖线标出，其下为出处（文件 · 位置）。", secondary=True)
    for name, reason, entries in groups:
        if not assessed and not entries:
            continue
        _add_heading(doc, name, 3)
        if assessed:
            style.paragraph(doc, [("评分依据：", 10.5, True, style.INK),
                                  (str(reason or "待补充材料核验"), 10.5, False, style.INK)], line=1.3)
        _quotes(doc, entries)
        if assessed and not entries:
            _paragraph(doc, "该维度暂无可定位的原文。", secondary=True)
    if others:
        _add_heading(doc, "其他引用材料", 3)
        _quotes(doc, others)
    if not others and not any(entries for _, _, entries in groups):
        _paragraph(doc, "暂无可定位的支撑材料，请补充原始文件并人工核验。")


def _candidate_material(doc, candidate):
    """候选人信息。报告只在人工复核之后导出，各字段都已核对过，不再逐项标注复核状态。"""
    _add_heading(doc, "候选人信息")
    fields = [(field.get("label", "未命名字段"), field.get("value") or "未填写")
              for field in candidate.get("parsed", {}).get("fields", {}).values()]
    if fields:
        _table(doc, ("字段", "内容"), fields, (1.4, 5.5), split=True)
    else:
        _paragraph(doc, "尚未记录候选人信息字段。")


def _review(doc, comment_label, comment, decision_label, decision):
    """人工复核内容：意见和结论各占一行，结论加粗。"""
    width = style.content_width(doc)
    style.grid_table(doc, [
        [style.cell(comment_label, 1900, bold=True, fill=style.LIGHT), style.cell(comment, width - 1900)],
        [style.cell(decision_label, 1900, bold=True, fill=style.LIGHT),
         style.cell(decision, width - 1900, size=10.5, bold=True)],
    ])


def build_report(candidate: dict, job: dict, output_path: str | Path, template: bool = False) -> Path:
    doc = _new_document(f"{load_brand().get('company', 'TalentFlow')}人岗匹配评估报告", "人岗匹配评估报告")
    score = candidate.get("score", {})
    code = candidate.get("parsed", {}).get("candidate_code", candidate["id"])
    style.info_line(doc, [("候选人姓名", _candidate_name(candidate)), ("候选人编号", code),
                          ("目标岗位", job.get("name", "未命名岗位")), ("生成时间", style.now_text())])
    summary = _overview(doc, score, job, candidate.get("decision") or "未决策")
    _paragraph(doc, "本报告用于岗位选才，汇总候选人与目标岗位的综合匹配、优势、差距、材料依据及人工复核结果。")
    style.note(doc, DISCLAIMER, label="说明：")
    _add_heading(doc, "目标岗位与评估范围")
    _job_context(doc, job)
    _candidate_material(doc, candidate)
    _dimensions(doc, score)
    _analysis(doc, summary)
    _hard_checks(doc, score)
    _evidence(doc, score, candidate.get("tags", []))
    _add_heading(doc, "人工复核")
    _review(doc, "复核意见", candidate.get("review_comment") or "未填写",
            "人工最终决策", candidate.get("decision") or "未决策")
    return _save(doc, output_path)


def _fit_ranking(doc, ranked, jobs, recommended):
    widths = style.spread((1.1, 4.6, 5.0, 3.4, 2.9), style.content_width(doc))
    lines = [style.header_cells(("排名", "岗位", "综合匹配度", "匹配结论", "人工推荐结论"), widths, (0, 2, 3, 4))]
    for rank, match in enumerate(ranked, 1):
        data = assessment_summary_data(match["score"], jobs[match["job_id"]])
        value = score_value(match["score"])
        preferred = match is recommended
        lines.append([
            style.cell(str(rank), widths[0], align="center"),
            style.cell(("★ " if preferred else "") + jobs[match["job_id"]]["name"], widths[1], bold=preferred),
            *style.bar_cells(widths[2], value, "待评估" if value is None else f"{value:.1f}"),
            style.cell(data["conclusion"], widths[3], align="center"),
            style.cell(match.get("decision") or "未确认", widths[4], align="center"),
        ])
    style.grid_table(doc, lines, header_rows=1)


def build_fit_report(candidate: dict, matches: list[dict], jobs: dict[str, dict], output_path: str | Path) -> Path:
    """一人多岗的排序和逐岗分析采用与页面相同的综合匹配口径。"""
    doc = _new_document(f"{load_brand().get('company', 'TalentFlow')}人才适岗推荐报告", "人才适岗推荐报告")
    ranked = sorted(matches, key=lambda item: score_sort_key(item["score"]), reverse=True)
    code = candidate.get("parsed", {}).get("candidate_code", candidate["id"])
    style.info_line(doc, [("候选人姓名", _candidate_name(candidate)), ("候选人编号", code),
                          ("参与评估岗位", len(ranked)), ("生成时间", style.now_text())])
    recommended = next((match for match in ranked
                        if assessment_summary_data(match["score"], jobs[match["job_id"]])["recommended"]), None)
    priority = (jobs[recommended["job_id"]]["name"] if recommended else
                "暂无，需先补充材料、核验硬性条件或评估主要差距。")
    if ranked:
        best = ranked[0]
        summary = assessment_summary_data(best["score"], jobs[best["job_id"]])
        style.card(doc, [
            [(6, style.inline_fact("当前排序首位岗位", jobs[best["job_id"]]["name"])), (5, _score_metric(best["score"]))],
            [(3, style.fact("首位岗位匹配结论", summary["conclusion"])),
             (5, style.inline_fact("优先核验岗位", priority, size=10.5)),
             (3, style.fact("人工推荐结论", f"已填写 {sum(bool(m.get('decision')) for m in ranked)}/{len(ranked)} 个岗位"))],
        ])
        _paragraph(doc, "首位岗位的材料支持范围：" + summary["evidence_summary"] + "。" + summary["score_note"], secondary=True)
    else:
        _paragraph(doc, "优先核验岗位：" + priority, bold=True)
    _paragraph(doc, "本报告用于人才适岗，比较同一候选人与多个岗位的综合匹配，列出各岗位的优势、差距、核验建议和人工推荐结论。")
    style.note(doc, DISCLAIMER, label="说明：")
    _add_heading(doc, "岗位适配排序")
    _fit_ranking(doc, ranked, jobs, recommended)
    _paragraph(doc, "综合匹配度用于比较现有材料对各岗位要求的支持程度；不同岗位的评分维度与权重各自独立，推荐时还应结合硬性条件和待核实项。", secondary=True)
    if recommended:
        _paragraph(doc, "★ 为优先核验岗位：综合匹配度不低于 65 分，各维度均已形成得分，硬性条件没有不满足或待核实项；是否推荐以人工推荐结论为准。", secondary=True)
    _candidate_material(doc, candidate)
    for rank, match in enumerate(ranked, 1):
        job, score = jobs[match["job_id"]], match["score"]
        # 每个岗位的分析从新的一页开始。
        _add_heading(doc, f"{rank} {job['name']}").paragraph_format.page_break_before = True
        summary = _overview(doc, score, job, match.get("decision") or "未确认", "人工推荐结论")
        _add_heading(doc, "岗位要求", 2)
        _job_context(doc, job)
        _dimensions(doc, score, 2)
        _analysis(doc, summary, 2)
        _hard_checks(doc, score, 2)
        _evidence(doc, score, match.get("tags", []), 2)
        _add_heading(doc, "人工推荐结论", 2)
        _review(doc, "人工推荐意见", match.get("review_comment") or "未填写",
                "人工推荐结论", match.get("decision") or "未确认")
    return _save(doc, output_path)


def export_report(candidate: dict, job: dict, operator: str, db_path, output_path: str | Path | None = None) -> Path:
    stored_candidate = row("SELECT * FROM candidates WHERE id=?", (candidate["id"],), db_path)
    if not stored_candidate:
        raise KeyError(f"候选人不存在：{candidate['id']}")
    candidate = decode_candidate(stored_candidate)
    stored_job = row("SELECT * FROM jobs WHERE id=?", (candidate["job_id"],), db_path)
    if not stored_job:
        raise KeyError(f"岗位不存在：{candidate['job_id']}")
    job = decode_job(stored_job)
    ready, missing = report_readiness(candidate)
    if not ready:
        raise ValueError("报告生成条件未满足：" + "；".join(missing))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    if output_path is None:
        safe_code = candidate["parsed"].get("candidate_code", candidate["id"]).replace("/", "-")
        output_path = REPORT_DIR / f"人岗匹配报告_{safe_code}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.docx"
    path = build_report(candidate, job, output_path)
    with connect(db_path) as conn:
        conn.execute("INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)", (candidate["id"], str(path), now_iso(), operator))
    record_audit("报告导出", "候选人", candidate["id"], {}, {"报告路径": str(path)}, operator, db_path)
    return path




def export_fit_report(
    candidate: dict,
    matches: list[dict],
    jobs: dict[str, dict],
    operator: str,
    db_path,
    output_path: str | Path | None = None,
) -> Path:
    from matching_core.services.auth import can
    if not can(operator, "export_report"):
        raise PermissionError("当前角色无权导出报告")
    stored = row("SELECT * FROM candidates WHERE id=?", (candidate["id"],), db_path)
    if not stored:
        raise KeyError("候选人不存在")
    candidate = decode_candidate(stored)
    matches = [decode_candidate_job_match(item) for item in rows(
        "SELECT * FROM candidate_job_matches WHERE candidate_id=? AND task_id=?",
        (candidate["id"], candidate["task_id"]), db_path)]
    ready, missing = fit_report_readiness(matches)
    if not ready:
        raise ValueError("报告生成条件未满足：" + "；".join(missing))
    jobs = {}
    for item in matches:
        stored_job = row("SELECT * FROM jobs WHERE id=?", (item["job_id"],), db_path)
        if not stored_job:
            raise ValueError("岗位配置缺失，请先核验岗位资料")
        jobs[item["job_id"]] = decode_job(stored_job)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    if output_path is None:
        safe_code = candidate["parsed"].get("candidate_code", candidate["id"]).replace("/", "-")
        output_path = REPORT_DIR / f"人才适岗推荐报告_{safe_code}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.docx"
    path = build_fit_report(candidate, matches, jobs, output_path)
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO reports(candidate_id,path,generated_at,operator) VALUES(?,?,?,?)",
            (candidate["id"], str(path), now_iso(), operator),
        )
    record_audit(
        "适岗报告导出",
        "候选人",
        candidate["id"],
        {},
        {"报告路径": str(path), "岗位数量": len(matches)},
        operator,
        db_path,
    )
    return path
