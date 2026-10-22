"""人工面试的AI旁听：提问建议、两阶段联动与综合报告。

旁听有两种依据：
- linked：候选人已完成第一阶段AI面试，建议和综合分析关联第一阶段报告；
- standalone：没有第一阶段，直接依据候选人简历和岗位要求。
两种方式的引用都必须能在原文中定位，定位不到的结论不保存。
"""
import hashlib
import json
import re
import threading
import time
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from . import listening_roles as roles
from . import text_models
from .interview_context import resume_context, speaker_context
from .standards import DIMENSIONS, filter_sensitive
from .models import AuditLog, Candidate, Interview, Job, ListeningContext, Report, ReportVersion, SensitiveBlock, SpeechCapture
from .rule_store import consent_notice

DEFAULT_NOTICE_VERSION = 'INTERVIEW-TWO-STAGE-3.0'
DEFAULT_NOTICE = '本次告知覆盖第一阶段AI面试和第二阶段人工面试AI旁听：仅采集音频，不采集视频；音频发送至火山引擎豆包转写，录音、原始转写和时间信息本地留存。转写与第一阶段报告交给文本模型辅助提问和汇总，须人工复核，不自动决定录用。拒绝后不启动采集。'
ONSITE_METHOD = '面试官现场告知并取得同意'
PRIOR_METHOD = '引用前置两阶段合规告知'
SPEAKER_RULES = ('简历仅用于核实岗位相关经历，引用时在resume_excerpt填写连续原文；无简历不得编造。'
                 'speaker_analysis提供声音分组和与转写对齐的时间段，但声音编号不代表身份；重叠、多声音或缺少对齐时不得断言回答归属。'
                 'dialogue是连续混合对话，不是候选人独白。只能从明确回答考官问题的上下文中引用疑似候选人原话，并填写speaker_basis说明语境依据；'
                 '无法区分则不提出建议或标记证据不足。禁止把考官提问、假设、举例当作候选人经历。角色归属均待人工核对，不作确定判断。'
                 '带有turns的录音已经逐段区分了发言人：role为interviewer是考官、candidate是候选人、unknown是无法判断；'
                 'basis为inferred是按对话语境推断的，confirmed是面试官确认过的。引用这类录音时，只能引用role为candidate的turns中的原文，'
                 '不得跨越两段发言；speaker_basis可以留空。')
CITATION_RULES = '所有引用须保留原始数字、标点和用词，不改写、不拼接、不添加省略号。每个引用建议只取10至60字，短回答可完整引用。\n'


def current_notice():
    value = consent_notice()
    return value.get('version', DEFAULT_NOTICE_VERSION), value.get('text', DEFAULT_NOTICE)


LOCK = threading.Lock()
ACTIVE = set()


def context(db, session):
    value = db.get(ListeningContext, session.id)
    if not value:
        value = ListeningContext(session_id=session.id, consent='{}', stage_one='{}', speakers='{}')
        db.add(value)
        db.flush()
    return value


def stage_snapshot(db, candidate_id):
    """第一阶段报告的当前版本；没有可用报告时返回 None。"""
    report = db.scalar(select(Report).where(Report.candidate_id == candidate_id).order_by(Report.id.desc()))
    if not report or not report.current_version:
        return None
    version = db.scalar(select(ReportVersion).where(ReportVersion.report_id == report.id, ReportVersion.version == report.current_version))
    if not version:
        return None
    return {'report_id': report.id, 'version': version.version, 'version_type': version.version_type,
            'status': report.status, 'content': json.loads(version.content)}


def snapshot(db, candidate_id):
    stage = stage_snapshot(db, candidate_id)
    if not stage:
        raise HTTPException(409, '该候选人没有第一阶段报告')
    return stage


def prior_consent(db, candidate_id):
    notice_version, _ = current_notice()
    return db.scalar(select(Interview).where(Interview.candidate_id == candidate_id, Interview.consented == True,  # noqa: E712
                                             Interview.consent_version == notice_version))


def consent_valid(db, session) -> bool:
    """本场旁听是否已具备采集依据：系统内的前置同意，或面试官现场告知并确认。"""
    record = json.loads(context(db, session).consent or '{}')
    if not record.get('accepted'):
        return False
    return record.get('method') == ONSITE_METHOD or bool(prior_consent(db, session.candidate_id))


def job_brief(db, candidate):
    job = db.get(Job, candidate.job_id) if candidate else None
    if not job:
        return {}
    try:
        model = json.loads(job.competency_model)
    except (TypeError, json.JSONDecodeError):
        model = []
    return {'name': job.name, 'duties': job.duties, 'requirements': job.requirements,
            'professional_requirements': job.professional_requirements,
            'competency_model': [{'dimension': item.get('dimension'), 'behavior': item.get('behavior')}
                                 for item in model if isinstance(item, dict)]}


def begin(db, session, candidate, body, ctx):
    c = context(db, session)
    authorization = prior_consent(db, candidate.id)
    attested = bool(body and getattr(body, 'candidate_confirmed', False))
    if not authorization and not attested:
        raise HTTPException(409, '未找到候选人的采集同意记录。请先当面告知采集事项并取得同意，再勾选确认后开始旁听')
    if not json.loads(c.stage_one):
        stage = stage_snapshot(db, candidate.id) or {}
        stage['listening_resume'] = resume_context(candidate)
        stage['job'] = job_brief(db, candidate)
        c.stage_one = json.dumps(stage, ensure_ascii=False)
    session.mode = 'linked' if json.loads(c.stage_one).get('report_id') else 'standalone'
    notice_version, notice_text = current_notice()
    from datetime import datetime, timezone
    c.consent = json.dumps({
        'accepted': True, 'candidate_id': candidate.id, 'candidate_code': candidate.code,
        'notice_version': notice_version, 'notice_text': notice_text,
        'confirmed_at': (authorization.consented_at.isoformat() if authorization and authorization.consented_at
                         else datetime.now(timezone.utc).isoformat()),
        'recorded_by': ctx['user'], 'method': PRIOR_METHOD if authorization else ONSITE_METHOD,
        'method_code': 'prior_consent' if authorization else 'onsite_attested',
        'interview_id': authorization.id if authorization else None, 'audio': True, 'video': False}, ensure_ascii=False)


def preview(db, candidate):
    """还没有旁听记录时的展示内容：只读取，不写库。"""
    notice_version, notice_text = current_notice()
    stage = stage_snapshot(db, candidate.id)
    return {'resume_context': resume_context(candidate), 'stage_one': stage, 'mode': 'linked' if stage else 'standalone',
            'consent_record': {}, 'prior_consent_valid': bool(prior_consent(db, candidate.id)), 'speakers': {},
            'notice_version': notice_version, 'notice_text': notice_text}


def info(db, session):
    notice_version, notice_text = current_notice()
    c = context(db, session)
    stage = json.loads(c.stage_one)
    candidate = db.get(Candidate, session.candidate_id)
    if not stage.get('report_id') and session.status != 'completed':
        # 旁听尚未锁定依据前，始终展示最新的第一阶段报告（如有）。
        latest = stage_snapshot(db, session.candidate_id)
        if latest:
            stage = {**latest, **{key: stage[key] for key in ('listening_resume', 'job') if key in stage}}
    resume = stage.get('listening_resume') or stage.get('content', {}).get('resume_context') or resume_context(candidate)
    return {'resume_context': resume, 'stage_one': stage if stage.get('report_id') else None,
            'mode': 'linked' if stage.get('report_id') else 'standalone',
            'consent_record': json.loads(c.consent), 'prior_consent_valid': bool(prior_consent(db, session.candidate_id)),
            'speakers': speakers_view(db, c), 'notice_version': notice_version, 'notice_text': notice_text}


def record_version(session, content, ctx, *, regenerated=False):
    """把AI生成的综合报告记为一个版本，交人工复核。重新生成时保留此前的版本。"""
    from datetime import datetime, timezone
    from .report_builder import AI_EDITOR
    versions = json.loads(session.comprehensive_versions or '[]') if regenerated else []
    number = max([int(item.get('version', 0)) for item in versions] or [0]) + 1
    versions.append({'version': number, 'version_type': 'ai_original', 'editor': AI_EDITOR,
                     'reason': f"AI重新生成（{ctx['user']} 发起）" if regenerated else 'AI原始生成',
                     'created_at': datetime.now(timezone.utc).isoformat(), 'content': content})
    session.comprehensive_status = 'pending_review'
    session.comprehensive_version = number
    session.comprehensive_versions = json.dumps(versions, ensure_ascii=False)
    session.comprehensive_error = ''


def speakers_view(db, c):
    """各段录音的发言人标注。连续对话附带逐段区分的结果（turns），不返回内部使用的逐句记录。"""
    labels = json.loads(c.speakers)
    captures = {item.id: item for item in db.scalars(
        select(SpeechCapture).where(SpeechCapture.id.in_(list(labels)))).all()} if labels else {}
    view = {}
    for capture_id, label in labels.items():
        shown = {key: value for key, value in label.items() if key != 'sentences'}
        capture = captures.get(capture_id)
        if label.get('speaker') == 'dialogue' and capture and label.get('sentences'):
            shown['turns'] = roles.turns(capture.transcript or '', label['sentences'], keep_basis=True)
        view[capture_id] = shown
    return view


def evidence(db, session, c, finalized=False):
    labels = json.loads(c.speakers)
    captures = db.scalars(select(SpeechCapture).where(SpeechCapture.kind == 'listening', SpeechCapture.target_id == session.candidate_id).order_by(SpeechCapture.created_at)).all()
    result = []
    for capture in captures:
        if capture.id not in labels or not capture.transcript.strip():
            continue
        if capture.status not in (('completed', 'linked') if finalized else ('recording', 'completed', 'linked')):
            continue
        label = labels[capture.id]
        item = {'id': capture.id, 'speaker': label['speaker'], 'text': capture.transcript,
                'provisional': capture.status == 'recording', 'labelled_by': label['actor'], 'speaker_analysis': speaker_context(capture)}
        if label['speaker'] == 'dialogue' and label.get('sentences'):
            # 只保留已经判断过的段落；还没判断的部分不当作任何人的发言。
            item['turns'] = [{key: turn[key] for key in ('role', 'basis', 'text')}
                             for turn in roles.turns(capture.transcript, label['sentences']) if turn['basis'] != 'pending']
        result.append(item)
    return result


def candidate_turn(entry, excerpt):
    """引用落在哪一段候选人发言里；没有落在候选人发言里时返回 None。"""
    return next((turn for turn in entry.get('turns') or [] if turn['role'] == 'candidate' and excerpt in turn['text']), None)


def separated(entry) -> bool:
    """这段连续对话是否已经逐段区分了发言人。"""
    return entry['speaker'] == 'dialogue' and bool(entry.get('turns'))


def has_candidate_speech(entry) -> bool:
    if entry['speaker'] == 'candidate':
        return True
    if entry['speaker'] != 'dialogue':
        return False
    return not entry.get('turns') or any(turn['role'] == 'candidate' for turn in entry['turns'])


def answer_located(entry, excerpt) -> bool:
    if not excerpt or excerpt not in entry['text']:
        return False
    return candidate_turn(entry, excerpt) is not None if separated(entry) else True


def speaker_note(entry, excerpt, given=''):
    """回答归属的说明，以及这个归属是不是推断的。"""
    if entry['speaker'] != 'dialogue':
        return given, False
    turn = candidate_turn(entry, excerpt) if separated(entry) else None
    # 已经逐段区分发言人的对话统一用下面的说明，不采用模型自己写的归属依据（其中常带有内部字段名）。
    if turn and turn['basis'] == 'confirmed':
        return '面试官已确认这段话是候选人说的。', False
    if turn:
        return '系统按对话语境判断这段话是候选人说的，须核对录音确认。', True
    return given, True


class PreparedQuestion(BaseModel):
    text: str = Field(min_length=4, max_length=400)
    dimension: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1, max_length=600)
    resume_excerpt: str = Field(default='', max_length=500)
    job_excerpt: str = Field(default='', max_length=500)


class PreparedQuestions(BaseModel):
    questions: list[PreparedQuestion] = Field(max_length=8)


class LinkedSuggestion(BaseModel):
    text: str = Field(min_length=4, max_length=400)
    reason: str = Field(min_length=1, max_length=1000)
    dimension: str
    stage_one_excerpt: str = ''
    capture_id: str
    answer_excerpt: str = Field(min_length=1)
    speaker_basis: str = ''
    resume_excerpt: str = ''


class SuggestionBatch(BaseModel):
    suggestions: list[LinkedSuggestion] = Field(max_length=2)


class CombinedFinding(BaseModel):
    dimension: str
    stage_one_excerpt: str = ''
    capture_id: str = ''
    answer_excerpt: str = ''
    analysis: str
    status: Literal['新增证据待复核', '存在差异待核实', '证据不足']
    speaker_basis: str = ''
    resume_excerpt: str = ''


class CombinedReport(BaseModel):
    findings: list[CombinedFinding] = Field(min_length=1, max_length=12)


def strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [s for item in value for s in strings(item)]
    if isinstance(value, dict):
        return [s for item in value.values() for s in strings(item)]
    return []


def linked(stage) -> bool:
    return bool(stage.get('report_id'))


def valid_reference(item, stage, candidates):
    """第一阶段引用是否可定位（无第一阶段时不要求）；现场回答引用对应的证据。"""
    if linked(stage):
        first = bool(item.stage_one_excerpt) and any(item.stage_one_excerpt in value for value in strings(stage['content']))
    else:
        first = not item.stage_one_excerpt
    second = next((e for e in candidates if e['id'] == item.capture_id and answer_located(e, item.answer_excerpt)), None)
    return first, second


def reference_error(result, stage, candidates, resume, finish):
    errors = []
    for item in result.findings if finish else result.suggestions:
        if item.resume_excerpt and item.resume_excerpt not in resume.get('text', ''):
            errors.append(f'{item.dimension}: resume_excerpt无法定位，请从resume.text复制连续原文；未引用简历时留空。')
        first, second = valid_reference(item, stage, candidates)
        if not first:
            errors.append(f'{item.dimension}: stage_one_excerpt无法定位，请复制citation_options.stage_one中本维度的excerpt。'
                          if linked(stage) else f'{item.dimension}: 本场没有第一阶段报告，stage_one_excerpt必须留空。')
        needs_answer = not finish or item.capture_id or item.answer_excerpt or item.status != '证据不足'
        if needs_answer and not second:
            source = next((e for e in candidates if e['id'] == item.capture_id), None)
            if source and separated(source) and item.answer_excerpt and item.answer_excerpt in source['text']:
                errors.append(f'{item.dimension}: answer_excerpt不在候选人的发言里（引用了考官的话，或跨越了两个人的发言），'
                              '请只引用该录音turns中role为candidate的原文。')
            else:
                errors.append(f'{item.dimension}: answer_excerpt无法定位，请复制citation_options.stage_two中对应capture_id的一个excerpt，不要引用考官提问。')
        if second and second['speaker'] == 'dialogue' and not separated(second) and not item.speaker_basis.strip():
            errors.append(f'{item.dimension}: 混合对话须填写speaker_basis说明候选人回答归属依据，不确定归属时不引用。')
    return '\n'.join(errors) or None


RETRY_STATUS = (502, 503, 504)


def request_with_retry(args, *, timeout, retries=0, progress=None, **options):
    """模型服务超时或暂时异常时再试；其余错误重试也不会有不同结果。"""
    for attempt in range(retries + 1):
        try:
            return text_models.request_json(*args, timeout=timeout, **options)
        except HTTPException as error:
            if attempt >= retries or error.status_code not in RETRY_STATUS:
                raise
            if progress:
                progress(f'模型服务暂时没有返回结果（{error.detail}），正在重试')


def prepare_questions(db, session, ctx, *, timeout: float = 45, retries: int = 0, progress=None):
    """旁听开始前，依据候选人简历和岗位要求生成提问建议，不依赖第一阶段面试。"""
    candidate = db.get(Candidate, session.candidate_id)
    resume = resume_context(candidate)
    job = job_brief(db, candidate)
    if resume.get('status') != 'ready' and not job:
        raise HTTPException(409, '缺少候选人简历和岗位资料，无法生成提问建议')
    stage = stage_snapshot(db, session.candidate_id)
    if text_models.enabled():
        result = request_with_retry((
            'chat-primary',
            '你在为面试官准备人工面试的提问建议。依据岗位要求和候选人简历，提出4至6个面试官可以直接念出的问题，'
            '每个问题只问一个重点，覆盖不同评价维度，优先核实简历中与岗位相关的经历、本人职责和结果。'
            'dimension必须取自dimensions。引用简历时在resume_excerpt填写简历中的连续原文，引用岗位要求时在job_excerpt填写岗位资料中的连续原文；'
            '不得改写引用，不得编造候选人经历。没有简历时只依据岗位要求提问，resume_excerpt留空。'
            '有第一阶段报告时可针对其中待核实的内容提问。不得涉及年龄、性别、婚育、民族、宗教、健康等与岗位无关的个人信息。',
            {'job': job, 'resume': resume, 'dimensions': [item[0] for item in DIMENSIONS],
             'first_stage': {'to_verify': (stage or {}).get('content', {}).get('match_analysis', {}).get('to_verify', []),
                             'offline_questions': (stage or {}).get('content', {}).get('offline_questions', [])} if stage else None},
            PreparedQuestions), timeout=timeout, retries=retries, progress=progress)
        questions = result.questions
    else:
        text_models.require_live_or_test_mock()
        questions = [PreparedQuestion(text=f'请结合一段真实经历，说明你在“{name}”方面做过什么、承担了哪些职责，结果如何？',
                                      dimension=name, reason='依据岗位评价维度准备的基础问题。') for name, *_ in DIMENSIONS[:4]]
    job_text = '\n'.join(strings(job))
    prepared = []
    for item in questions:
        allowed, reason = filter_sensitive(item.text)
        if not allowed:
            db.add(SensitiveBlock(content=item.text, reason=reason, source_type='listening_prepared_question'))
            db.add(AuditLog(actor=ctx['user'], role=ctx['role'], action='sensitive_content_blocked', target_type='listening',
                            target_id=str(session.id), detail=reason))
            continue
        # 定位不到的引用直接丢弃，问题本身保留，避免把模型改写的内容当作原文展示。
        resume_excerpt = item.resume_excerpt if item.resume_excerpt and item.resume_excerpt in resume.get('text', '') else ''
        job_excerpt = item.job_excerpt if item.job_excerpt and item.job_excerpt in job_text else ''
        prepared.append({'id': len(prepared) + 1, 'text': item.text, 'dimension': item.dimension, 'reason': item.reason,
                         'resume_excerpt': resume_excerpt, 'job_excerpt': job_excerpt, 'status': 'pending'})
    session.prepared_questions = json.dumps(prepared, ensure_ascii=False)
    db.add(AuditLog(actor=ctx['user'], role=ctx['role'], action='listening_questions_prepared', target_type='listening',
                    target_id=str(session.id),
                    detail=f"依据{'简历和' if resume.get('status') == 'ready' else ''}岗位资料生成 {len(prepared)} 个提问建议"))
    db.commit()
    return prepared


def generate(db, session, ctx, finish=False, *, timeout: float | None = None, wait: float = 0, background=False):
    """生成补充提问（finish=False）或综合报告（finish=True）。

    timeout 是单次模型调用的超时秒数；wait 是本场已有分析在进行时最多等多久；
    background 表示在后台生成：本场已经结束，没有候选人回答时也给出一份待人工补充的报告。
    """
    deadline = time.monotonic() + wait
    while True:
        with LOCK:
            if session.id not in ACTIVE:
                ACTIVE.add(session.id)
                break
        if time.monotonic() >= deadline:
            raise HTTPException(409, '本场分析正在生成，请稍后')
        time.sleep(0.5)
    try:
        return _generate(db, session, ctx, finish, timeout, background)
    finally:
        with LOCK:
            ACTIVE.discard(session.id)


def check_ready(db, session):
    """能不能结束本场并生成综合报告；不能时说明原因。"""
    c = context(db, session)
    if not json.loads(c.stage_one) or not consent_valid(db, session):
        raise HTTPException(409, '请先完成采集告知确认，再开始旁听分析')
    if not any(has_candidate_speech(item) for item in evidence(db, session, c, finalized=True)):
        raise HTTPException(409, NO_ANSWER)


def answer_excerpt_of(ref):
    """证据保全时引用的原文：已区分发言人的对话取候选人说得最长的一段。"""
    spoken = [turn['text'] for turn in ref.get('turns') or [] if turn['role'] == 'candidate']
    return (max(spoken, key=len) if spoken else ref['text'])[:120]


def _fallback_finding(stage, ref, text):
    evaluations = stage.get('content', {}).get('evaluations', []) if linked(stage) else []
    first = next((s for e in evaluations for s in strings(e.get('reason', '')) if s), '') if linked(stage) else ''
    dimension = evaluations[0].get('dimension', DIMENSIONS[0][0]) if evaluations else DIMENSIONS[0][0]
    if not ref:
        return CombinedFinding(dimension=dimension, stage_one_excerpt=first, analysis=text, status='证据不足')
    excerpt = answer_excerpt_of(ref)
    mixed = '该段为混合对话，角色归属依据上下文待人工核对。' if ref['speaker'] == 'dialogue' and not separated(ref) else ''
    return CombinedFinding(
        dimension=dimension, stage_one_excerpt=first, capture_id=ref['id'], answer_excerpt=excerpt,
        analysis=text, status='新增证据待复核', speaker_basis=speaker_note(ref, excerpt, mixed)[0])


NO_ANSWER = '请先保存录音，并标注至少一段候选人回答；混合或未知发言不作为候选人证据'


def _generate(db, session, ctx, finish, timeout=None, background=False):
    c = context(db, session)
    stage = json.loads(c.stage_one)
    if not stage or not consent_valid(db, session):
        raise HTTPException(409, '请先完成采集告知确认，再开始旁听分析')
    # 连续对话先按语境区分发言人；区分不出来的录音沿用原来的办法，由模型在引用时说明归属依据。
    roles.ensure(db, session, finalized=finish)
    db.refresh(c)
    all_evidence = evidence(db, session, c, finalized=finish)
    candidates = [e for e in all_evidence if has_candidate_speech(e)]
    existing = json.loads(session.suggestions)
    if not candidates and not (finish and background):
        if not finish:
            only_interviewer = any(e['speaker'] == 'dialogue' for e in all_evidence)
            return {'suggestions': existing, 'skipped': ('这段对话里还没有候选人的回答，暂不提出补充提问' if only_interviewer
                                                         else '尚无已标注为候选人的回答，不推断发言人身份')}
        raise HTTPException(409, NO_ANSWER)
    digest = hashlib.sha256(json.dumps(candidates, ensure_ascii=False).encode()).hexdigest()
    if not finish and c.last_evidence_hash == digest:
        return {'suggestions': existing, 'skipped': '没有新增回答证据'}
    resume = stage.get('listening_resume') or stage.get('content', {}).get('resume_context')
    if not resume:
        resume = resume_context(db.get(Candidate, session.candidate_id))
        stage['listening_resume'] = resume
        c.stage_one = json.dumps(stage, ensure_ascii=False)
    has_stage = linked(stage)
    payload = {'resume': resume, 'job': stage.get('job') or job_brief(db, db.get(Candidate, session.candidate_id)),
               'second_stage': all_evidence, 'previous_questions': existing, 'speaker_rules': SPEAKER_RULES}
    if has_stage:
        payload['first_stage_report'] = {key: stage[key] for key in ('report_id', 'version', 'status', 'content') if key in stage}
    else:
        payload['dimensions'] = [item[0] for item in DIMENSIONS]
    if len(json.dumps(payload, ensure_ascii=False)) > 100000:
        raise HTTPException(413, '本场材料超出当前分析容量，请人工复核；未静默截断证据')
    # 在完整证据之外提供短引用选项，帮助模型准确引用；不替代模型分析。
    payload['citation_options'] = {
        'stage_one': [{'dimension': item.get('dimension'),
                       'excerpt': (item.get('reason') or item.get('evidence_excerpt') or '')[:100]}
                      for item in stage.get('content', {}).get('evaluations', [])] if has_stage else [],
        # 已区分发言人的对话只提供候选人说的话，不提供考官的话。
        'stage_two': [{'capture_id': item['id'], 'excerpts': [
            sentence[:100] for part in ([turn['text'] for turn in item['turns'] if turn['role'] == 'candidate']
                                        if separated(item) else [item['text']])
            for sentence in re.findall(r'[^。！？!?；;\n]+[。！？!?；;]?', part)
        ]} for item in candidates],
    }
    if has_stage:
        citation = ('优先完整复制citation_options中的短引用，stage_one_excerpt取stage_one对应维度的excerpt；'
                    'answer_excerpt取stage_two对应capture_id的一个excerpts元素。\n')
        task = ('联合分析两个阶段，对第一阶段每个评价维度分别返回一条findings，指出新证据、差异或不足。必须逐字引用第一阶段和候选人回答；'
                '无第二阶段证据则标记证据不足。不得把考官陈述作为候选人行为，不重新打分，不覆盖人工判断。' if finish else
                '结合第一阶段报告中最值得核实的一点和候选人最新回答，每次只提出一个不重复的补充问题。问题须简洁、口语化、可由面试官直接念出，'
                '一次只问一个重点，避免背景说明、评价性表述和多问合一；优先追问具体情境、本人行动、判断依据或结果。'
                '结构化数据中仍须说明理由、维度，并逐字引用第一阶段原文及候选人回答，供后台追溯，但不要把这些依据写进问题正文。'
                '没有必要追问则返回空列表；不得重复已采用或忽略的问题。')
    else:
        citation = ('本场没有第一阶段AI面试，stage_one_excerpt一律留空。answer_excerpt取citation_options.stage_two对应capture_id的一个excerpts元素；'
                    'dimension必须取自dimensions。\n')
        task = ('依据岗位要求、候选人简历和本场人工面试的候选人回答，对dimensions中有回答证据的评价维度分别返回一条findings，'
                '说明回答展示了什么、与简历或岗位要求是否一致、还缺少什么；没有回答证据的维度标记证据不足。'
                '必须逐字引用候选人回答。不得把考官陈述作为候选人行为，不打分，不输出录用或淘汰结论。' if finish else
                '结合岗位要求、候选人简历和候选人最新回答，每次只提出一个不重复的补充问题。问题须简洁、口语化、可由面试官直接念出，'
                '一次只问一个重点；优先追问具体情境、本人行动、判断依据或结果，或核实简历中与岗位相关的经历。'
                '结构化数据中须说明理由、维度，并逐字引用候选人回答；引用简历时填写resume_excerpt。'
                '没有必要追问则返回空列表；不得重复已采用或忽略的问题。')
    fallback_used = False
    fallback_reason = ''
    request_args = None
    options = {'timeout': timeout} if timeout else {'timeout': 30} if finish else {}
    if not candidates:
        # 后台生成时本场已经结束：没有识别到候选人的回答，也给出一份如实说明、待人工补充的报告。
        fallback_used, fallback_reason = True, '本场录音中没有识别到候选人的回答'
        result = CombinedReport(findings=[_fallback_finding(
            stage, None, '本场录音中没有识别到候选人的回答，未作分析；请核对录音后人工补充结论。')])
    elif text_models.enabled():
        try:
            request_args = ('chat-primary', SPEAKER_RULES + '\n' + CITATION_RULES + citation + task,
                            payload, CombinedReport if finish else SuggestionBatch)
            result = text_models.request_json(*request_args, **options)
        except HTTPException as error:
            # 文本服务响应慢或不可用时，综合报告先保全原文证据并标记待人工补充，避免面试官无法结束本场。
            if not finish or error.status_code not in (502, 503, 504):
                raise
            fallback_used, fallback_reason = True, str(error.detail)
            result = CombinedReport(findings=[_fallback_finding(
                stage, candidates[-1], '文本模型暂未返回结构化结果，已保全原文证据；请人工核实后补充结论。')])
    else:
        # 固定内容只用于自动化测试；正式环境没有启用文本模型时直接说明，不给出看似分析的结果。
        text_models.require_live_or_test_mock()
        ref = candidates[-1]
        if finish:
            result = CombinedReport(findings=[_fallback_finding(stage, ref, '已关联现场回答原文，新增证据是否充分须人工核实。')])
        else:
            base = _fallback_finding(stage, ref, '')
            result = SuggestionBatch(suggestions=[LinkedSuggestion(
                text='请补充刚才事例中的判断依据、你的具体行动与最终结果。',
                reason='结合已有评价和现场回答，核实具体行为依据。' if has_stage else '结合岗位要求和现场回答，核实具体行为依据。',
                dimension=base.dimension, stage_one_excerpt=base.stage_one_excerpt,
                capture_id=ref['id'], answer_excerpt=base.answer_excerpt)])
    if text_models.enabled() and not fallback_used:
        error = reference_error(result, stage, candidates, resume, finish)
        if error:
            corrected_payload = {**payload, 'validation_error': error, 'previous_result': result.model_dump()}
            try:
                result = text_models.request_json(
                    request_args[0], request_args[1] + '\n上次结果引用校验失败。按照validation_error校正原话引用后返回完整结果，不能通过编造或删掉已有证据规避校验。',
                    corrected_payload, request_args[3], **options)
            except HTTPException:
                # 结束旁听时校正请求失败，沿用第一次的结果；其中定位不到原文的结论在下面被丢弃。
                if not finish:
                    raise
    if finish:
        # 模型校正一次后仍有问题的结论：引用在原文中定位不到的不保存；引用可定位但没有说明回答归属的，
        # 保留并标明归属待核对。这样面试官总能结束本场，报告里也不会出现无法核对的内容。
        findings, discarded = [], 0
        for item in result.findings:
            first, second = valid_reference(item, stage, candidates)
            resume_located = not item.resume_excerpt or item.resume_excerpt in resume.get('text', '')
            needs_answer = bool(item.capture_id or item.answer_excerpt or item.status != '证据不足')
            if not resume_located or not first or (needs_answer and not second):
                discarded += 1
                continue
            finding = item.model_dump()
            basis, inferred = speaker_note(second, item.answer_excerpt, item.speaker_basis) if second else (item.speaker_basis, False)
            if inferred and not basis.strip():
                basis = '模型未说明该段回答的归属依据，须核对录音确认是否为候选人所说。'
            finding['speaker_basis'] = basis
            findings.append({**finding, 'speaker_inferred': inferred,
                             'evidence_sufficient': bool(second and not inferred), 'human_review_required': True})
        if not findings:
            fallback_used = True
            fallback_reason = fallback_reason or '模型给出的结论无法在原文中定位'
            last = candidates[-1] if candidates else None
            kept = result.findings[0] if not last else _fallback_finding(
                stage, last, '模型给出的结论无法在原文中定位，未予保存；已保全原文证据，请人工核实后补充结论。')
            findings = [{**kept.model_dump(), 'speaker_inferred': bool(last) and speaker_note(last, kept.answer_excerpt)[1],
                         'evidence_sufficient': False, 'human_review_required': True}]
        stage_content = stage.get('content', {}) if has_stage else {}
        candidate_evidence = [item for item in all_evidence if item.get('speaker') in ('candidate', 'dialogue')]
        prepared = json.loads(session.prepared_questions or '[]')
        content = {
            'disclaimer': 'AI辅助生成，须人工复核', 'status': 'pending_review', 'mode': 'linked' if has_stage else 'standalone',
            'generation_mode': ('证据保全降级' if fallback_used else '文本模型分析' if text_models.enabled()
                                else '测试环境固定内容'),
            # 没有得到模型分析时说明原因，页面据此提示可以重新生成。
            'generation_note': fallback_reason,
            'speakers_separated': any(separated(item) for item in all_evidence),
            'stage_one': stage if has_stage else None,
            'stage_one_summary': stage_content.get('summary', '') if has_stage else '本场未进行第一阶段AI面试，综合分析依据简历、岗位要求和人工面试回答。',
            'stage_one_evaluations': stage_content.get('evaluations', []),
            'stage_one_qa_records': stage_content.get('qa_records', []),
            'stage_one_match_analysis': stage_content.get('match_analysis', {}),
            'stage_one_risks': stage_content.get('risks', []),
            'stage_two_summary': f"人工面试共留存 {len(all_evidence)} 段有效转写，其中 {len(candidate_evidence)} 段包含候选人回答或待核对的混合对话。",
            'stage_two_evidence': all_evidence, 'findings': findings, 'discarded_findings': discarded,
            'resume_context': resume,
            'job_context': stage.get('job') or {},
            'resume_checks': stage_content.get('resume_checks', []),
            'adopted_questions': [s.get('edited_text') or s['text'] for s in existing if s['status'] in ('adopted', 'edited')]
                                 + [q['text'] for q in prepared if q.get('status') == 'adopted'],
            'risks': ['连续对话中的回答归属按语境推测，必须核对录音，不作为已确认身份',
                      '综合分析不修改第一阶段报告或人工评分' if has_stage else '本场没有第一阶段评分，综合分析不含量化评分，须由考官结合现场情况评价'],
            'decision': None}
        session.comprehensive_report = json.dumps(content, ensure_ascii=False)
        session.status = 'completed'
        record_version(session, content, ctx, regenerated=background and bool(json.loads(session.comprehensive_versions or '[]')))
    else:
        added, skipped = 0, ''
        for item in result.suggestions:
            if item.resume_excerpt and item.resume_excerpt not in resume.get('text', ''):
                raise HTTPException(502, '建议中的简历引用无法定位')
            first, second = valid_reference(item, stage, candidates)
            if not first or not second:
                raise HTTPException(502, '建议引用无法定位到原文，请重试')
            basis, inferred = speaker_note(second, item.answer_excerpt, item.speaker_basis)
            if inferred and not basis.strip():
                skipped = '模型没有说明回答是谁说的，这条补充提问未采用'
                continue
            if any((s.get('edited_text') or s['text']) == item.text for s in existing):
                continue
            allowed, reason = filter_sensitive(item.text)
            if not allowed:
                db.add(SensitiveBlock(content=item.text, reason=reason, source_type='listening_suggestion'))
                db.add(AuditLog(actor=ctx['user'], role=ctx['role'], action='sensitive_content_blocked', target_type='listening', target_id=str(session.id), detail=reason))
                continue
            existing.append({**item.model_dump(), 'speaker_basis': basis, 'id': len(existing)+1, 'status': 'pending', 'edited_text': '',
                'report_id': stage.get('report_id'), 'report_version': stage.get('version'),
                'provisional': second['provisional'], 'speaker_inferred': inferred})
            added += 1
        session.suggestions = json.dumps(existing, ensure_ascii=False)
        c.last_evidence_hash = digest
        content = {'suggestions': existing, **({'skipped': skipped} if skipped and not added else {})}
    basis = f"依据第一阶段报告 {stage['report_id']} v{stage['version']} 与人工面试证据" if has_stage else '依据简历、岗位要求与人工面试证据'
    db.add(AuditLog(actor=ctx['user'], role=ctx['role'], action='combined_report_generated' if finish else 'dynamic_followup_generated',
        target_type='listening', target_id=str(session.id),
        detail=basis + ('；未取得可核对的模型结论，已生成证据保全版待人工补充' if fallback_used else '')
        + (f'；{discarded} 条结论的引用无法在原文中定位，未保存' if finish and discarded else '')))
    db.commit()
    return content
