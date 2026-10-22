"""Batch identity, human review status and downloadable audit views."""
import csv
import io
import json

from matching_core.config import DB_PATH
from matching_core.db import rows
from matching_core.services import workflow
from matching_core.services.report import report_readiness, fit_report_readiness
from matching_core.services.scoring import assessment_summary_data, score_value, score_sort_key


def batch_title(task, jobs=None):
    if task.get('batch_name', '').strip():
        return task['batch_name']
    date = str(task.get('created_at', ''))[:16].replace('T', ' ')
    jobs = jobs or {}
    names = '、'.join(jobs[j]['name'] for j in task.get('job_ids', [task.get('job_id')]) if j in jobs)
    flow = '人才适岗' if task.get('task_mode') == '人找岗位' else '岗位选才'
    return ' · '.join(value for value in (date, names or flow) if value) or task['id']


def review_status(candidate, matches=None, fit=False, expected_jobs=None):
    matches = matches or []
    scores = [m.get('score', {}) for m in matches] if fit else [candidate.get('score', {})]
    if any(s.get('requires_reassessment') for s in scores):
        return '需重新审核'
    if fit:
        if candidate.get('parse_status') != '人工已复核':
            return '待审核'
        decisions = [m.get('decision') for m in matches]
        if '推荐至该岗位' in decisions:
            return '通过'
        if '作为备选岗位' in decisions:
            return '保留'
        if decisions and all(d == '暂不推荐' for d in decisions) and len(matches) >= (expected_jobs or len(matches)):
            return '未通过'
        return '待审核'
    if candidate.get('parse_status') != '人工已复核':
        return '待审核'
    return {'进入下一轮': '通过', '淘汰': '未通过', '保留': '保留'}.get(candidate.get('decision'), '待审核')


def analysis_status(score):
    if score.get('requires_reassessment'):
        return '资料已更新，待重分析'
    state = score.get('reasoning_analysis', {})
    attempt = state.get('last_attempt', state)
    if score.get('scoring_method') == 'ai_semantic_v1' and attempt.get('status') not in ('调用成功', None):
        return '重试未完成（保留上次结果）' if score_value(score) is not None else '待重试'
    if score_value(score) is None:
        return '待补充材料'
    if score.get('unassessed_dimensions'):
        return '部分维度待核实'
    return '分析完成'


def batch_snapshot(task_id, db_path=DB_PATH):
    task = next((t for t in workflow.get_tasks(db_path) if t['id'] == task_id), None)
    if not task:
        raise KeyError('批次不存在')
    fit = task.get('task_mode') == '人找岗位'
    jobs = {j['id']: j for j in workflow.get_jobs(db_path, include_inactive=True)}
    candidates = workflow.get_candidates(task_id, db_path)
    matches = workflow.get_candidate_job_matches(task_id=task_id, db_path=db_path) if fit else []
    all_audits = rows("SELECT object_id,operation_type,operation_time,operator,after_json FROM audits WHERE operation_type IN ('人工决策','岗位推荐确认') OR object_id=? ORDER BY id DESC", (task_id,), db_path=db_path)
    review_audits = {}
    filenames = []
    for audit in all_audits:
        if audit['operation_type'] in ('人工决策', '岗位推荐确认'):
            review_audits.setdefault(audit['object_id'], audit)
        if audit['object_id'] == task_id and not filenames:
            try:
                value = json.loads(audit['after_json']).get('文件名', [])
                if isinstance(value, list):
                    filenames = [name for name in value if isinstance(name, str)]
            except (ValueError, AttributeError):
                pass
    failures = task.get('failure_reasons', [])
    records = []
    for candidate in candidates:
        own = [m for m in matches if m['candidate_id'] == candidate['id']]
        ranked = sorted(own, key=lambda m: score_sort_key(m['score']), reverse=True)
        best = ranked[0] if ranked else None
        score = best['score'] if fit and best else candidate['score']
        from matching_core.services.batch_reports import batch_report_readiness
        task_jobs = {jid: jobs[jid] for jid in task.get('job_ids', [task['job_id']]) if jid in jobs}
        ready, blocked = batch_report_readiness(candidate, own, task_jobs, fit)
        expected = len(task.get('job_ids', []))
        if fit and len(own) < expected:
            ready = False
            blocked = [*blocked, '部分岗位尚未完成分析']
        audited = [review_audits[key] for key in ([candidate['id'] + ':' + m['job_id'] for m in own] if fit else [candidate['id']]) if key in review_audits]
        # A material edit revokes the earlier decisions. Do not present their
        # audit time as a review of the newly edited material.
        has_decision = any(m.get('decision') for m in own) if fit else bool(candidate.get('decision'))
        latest = max(audited, key=lambda a: a['operation_time']) if audited and has_decision else {}
        related_failures = [f for f in failures if f.get('candidate_id') == candidate['id'] or f.get('file') == candidate['source_filename']]
        analysis = analysis_status(score)
        if fit:
            statuses = [analysis_status(m['score']) for m in own]
            if any(m['score'].get('requires_reassessment') for m in own):
                analysis = '资料已更新，待重分析'
            elif len(own) < expected:
                analysis = '部分岗位待分析'
            elif any('重试' in s for s in statuses):
                analysis = '部分岗位待重试'
            elif any(s != '分析完成' for s in statuses):
                analysis = '部分岗位待核实'
        decisions = '；'.join(jobs.get(m['job_id'], {}).get('name', m['job_id']) + '：' + (m.get('decision') or '待审核') for m in own) if fit else candidate.get('decision') or '未确认'
        records.append(dict(candidate_id=candidate['id'], **{
            '候选人编号': candidate['parsed'].get('candidate_code', candidate['id']), '姓名': candidate['full_name'],
            '原始文件': candidate['source_filename'], '综合匹配度': score_value(score),
            '匹配结论': assessment_summary_data(score)['conclusion'], '分析状态': analysis,
            '审核状态': review_status(candidate, own, fit, expected), '人工结论': decisions,
            '资料确认': '已确认' if candidate.get('parse_status') == '人工已复核' else '待确认',
            '已审岗位': f"{sum(bool(m.get('decision')) for m in own)}/{expected}" if fit else '—',
            '复核意见': '；'.join(m.get('review_comment') or '' for m in own) if fit else candidate.get('review_comment') or '',
            '审核人': latest.get('operator', ''), '审核时间': latest.get('operation_time', ''),
            '报告状态': '可导出' if ready else '；'.join(blocked),
            '处理说明': '；'.join(f.get('reason', '') for f in related_failures),
        }))
    existing = {c['source_filename'] for c in candidates}
    missing = list(dict.fromkeys([*filenames, *(f.get('file', '') for f in failures if not f.get('candidate_id'))]))
    for filename in missing:
        if not filename or filename in existing:
            continue
        failed = next((f for f in failures if f.get('file') == filename), None)
        records.append(dict(candidate_id=None, **{'候选人编号': '—', '姓名': '尚未解析', '原始文件': filename,
            '综合匹配度': None, '匹配结论': '待分析', '分析状态': '解析待重试' if failed else '排队 / 处理中',
            '审核状态': '待审核', '人工结论': '未确认', '资料确认': '待确认', '已审岗位': '—', '复核意见': '',
            '审核人': '', '审核时间': '', '报告状态': '等待解析及审核', '处理说明': failed.get('reason', '') if failed else ''}))
    summary = {status: sum(r['审核状态'] == status for r in records) for status in ('通过', '未通过', '保留', '待审核', '需重新审核')}
    summary.update(total=max(task.get('total_files', 0), len(records)), parsed=len(candidates),
                   exportable=sum(r['报告状态'] == '可导出' for r in records), failures=task.get('failure_count', 0))
    return dict(task=task, candidates=candidates, matches=matches, jobs=jobs, rows=records, summary=summary)


def safe_csv(records):
    from matching_core.services.batch_reports import _csv_cell
    stream = io.StringIO(newline='')
    if records:
        writer = csv.DictWriter(stream, fieldnames=list(records[0]))
        writer.writeheader()
        for record in records:
            writer.writerow({key: _csv_cell(value) if isinstance(value, str) else value for key, value in record.items()})
    return stream.getvalue().encode('utf-8-sig')
