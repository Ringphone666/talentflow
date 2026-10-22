"""启动初始化：建表、为旧库补列、写入固定的六维评价体系。

正式环境不写入任何岗位、批次、候选人或账号，业务数据全部由使用者在页面中建立（或由旧系统
迁移而来）。测试环境（TALENTFLOW_RUNTIME_PROFILE=test）另外写入一套固定的测试数据，供自动化
测试使用。
"""
import json

from sqlalchemy import select

from ..core.database import SessionLocal, upgrade_schema
from ..core.security import hash_password
from ..core.settings import is_test_runtime
from .mock_engine import DEFAULT_TRANSCRIPTS, HR_QUESTIONS, QUESTIONS, build_report
from .models import (Answer, AuditLog, Batch, Candidate, EvaluationDimension, Interview, Job, ListeningSession,
                     Question, Report, ReportVersion, User)
from .rule_store import consent_notice
from .standards import DIMENSIONS, RUBRIC

TEST_PASSWORD = "ChangeMe123!"  # Synthetic test credential; never used by production startup.
TEST_USERS = [
    ("admin", "系统管理员", "system_admin"),
    ("hr", "HR管理员", "hr_admin"),
    ("question_reviewer", "题目审核人", "question_reviewer"),
    ("interviewer", "面试官", "interviewer"),
    ("report_reviewer", "报告复核人", "report_reviewer"),
    ("candidate", "测试候选人", "candidate"),
]
TEST_CANDIDATES = [
    ("CAND-2026-001", "林晓川", [4, 4, 4, 4, 4, 4]),
    ("CAND-2026-002", "周晴禾", [3, 4, 4, 3, 4, 4]),
    ("CAND-2026-003", "陈默言", [4, 4, 3, 5, 3, 4]),
    ("CAND-2026-004", "许安宁", [2, 3, 3, 3, 4, 3]),
]
TEST_HR_JOBS = [
    ("JOB-HR-001", "人力资源运营专员", "维护招聘流程和演示资料；协调面试安排；整理经人工核验的流程记录。"),
    ("JOB-HR-002", "人力资源分析专员", "分析虚构招聘需求与岗位能力要求；维护演示候选人信息；核对报告证据。"),
]


def initialize() -> None:
    upgrade_schema()
    with SessionLocal() as db:
        if not db.scalar(select(EvaluationDimension.id).limit(1)):
            db.add_all([EvaluationDimension(name=name, definition=definition, weight=weight,
                                            rubric=json.dumps(RUBRIC, ensure_ascii=False))
                        for name, definition, weight in DIMENSIONS])
        if not db.scalar(select(AuditLog.id).limit(1)):
            db.add(AuditLog(actor="system", role="system_admin", action="system_initialized", target_type="system",
                            target_id="talentflow-hr-platform", detail="初始化系统结构和六维评价体系"))
        db.commit()
        if is_test_runtime():
            seed_test_data(db)
            db.commit()


def competency_model():
    return json.dumps([{"dimension": name, "behavior": definition, "levels": RUBRIC} for name, definition, _ in DIMENSIONS],
                      ensure_ascii=False)


def published_questions(db, batch: Batch, job: Job, source) -> list[Question]:
    rows = db.scalars(select(Question).where(Question.batch_id == batch.id, Question.version == 1)
                      .order_by(Question.sequence)).all()
    if rows:
        return rows
    rows = [Question(batch_id=batch.id, job_id=job.id, sequence=sequence, dimension=dimension, content=content,
                     time_limit=90, version=1, status="published", review_comment="题目审核通过",
                     change_log=json.dumps([{"version": 1, "action": "生成并发布", "actor": "题目审核人"}], ensure_ascii=False))
            for sequence, (dimension, content) in enumerate(source, start=1)]
    db.add_all(rows)
    db.flush()
    return rows


def seed_test_data(db) -> None:
    """自动化测试使用的固定数据：一个已发布题目的批次、四名虚构候选人及其面试报告。"""
    if not db.scalar(select(User.id).limit(1)):
        db.add_all([User(username=username, display_name=name, role=role, password_hash=hash_password(TEST_PASSWORD))
                    for username, name, role in TEST_USERS])
        db.flush()

    job = db.scalar(select(Job).where(Job.code == "JOB-2026-001"))
    if not job:
        job = Job(code="JOB-2026-001", name="制造生产储备岗",
                  duties="学习生产流程与作业规范；执行班组任务与交接；记录关键过程数据；识别质量、安全和进度异常并升级；参与现场改善。",
                  requirements="具备基础理工或相关专业知识；能适应班组协作与现场节奏；具备清晰表达、复盘和持续学习能力。",
                  professional_requirements="理解基本生产流程、质量控制点、异常上报、标准作业和现场数据记录。",
                  competency_model=competency_model(), material_version="JD-1.0", audit_status="approved")
        db.add(job)
        db.flush()
    batch = db.scalar(select(Batch).where(Batch.code == "2026-D01"))
    if not batch:
        batch = Batch(code="2026-D01", name="2026年社会招聘批次", recruitment_type="社会招聘", job_id=job.id,
                      status="active", question_version=1)
        db.add(batch)
        db.flush()
    questions = published_questions(db, batch, job, QUESTIONS)

    hr_jobs = {}
    for code, name, duties in TEST_HR_JOBS:
        hr_job = db.scalar(select(Job).where(Job.code == code))
        if not hr_job:
            hr_job = Job(code=code, name=name, duties=duties,
                         requirements="大学本科；人力资源、企业管理、经济等相关专业优先；普通话；能够遵守保密和业务审核要求。",
                         professional_requirements="人力资源规划、劳动法、招聘与调配、薪酬绩效、劳动关系、培训管理、人事档案。",
                         competency_model=competency_model(), material_version="HR-JD-1.0", audit_status="approved")
            db.add(hr_job)
            db.flush()
        hr_jobs[code] = hr_job
    hr_batch = db.scalar(select(Batch).where(Batch.code == "2026-HR-01"))
    if not hr_batch:
        hr_batch = Batch(code="2026-HR-01", name="人力资源演示批次", recruitment_type="内部竞聘",
                         job_id=hr_jobs["JOB-HR-002"].id, status="active", question_version=1)
        db.add(hr_batch)
        db.flush()
    published_questions(db, hr_batch, hr_jobs["JOB-HR-002"], HR_QUESTIONS)

    notice_version = consent_notice().get("version", "INTERVIEW-TWO-STAGE-3.0")
    for index, (code, name, profile) in enumerate(TEST_CANDIDATES):
        candidate = db.scalar(select(Candidate).where(Candidate.code == code))
        if not candidate:
            candidate = Candidate(code=code, name=name, is_fictional=True, batch_id=batch.id, job_id=job.id)
            db.add(candidate)
            db.flush()
        if index == 0:
            # 第一名候选人用于走完整的面试流程：未填资料、未同意、未开始。
            login = db.scalar(select(User).where(User.username == "candidate"))
            if login:
                login.candidate_id = candidate.id
        elif not candidate.profile_json or candidate.profile_json == "{}":
            candidate.profile_json = json.dumps({
                "phone": f"1390000000{index}", "email": f"candidate{index}@example.invalid",
                "education": "本科", "major": "制造工程", "years": "3年"}, ensure_ascii=False)
        interview = db.scalar(select(Interview).where(Interview.candidate_id == candidate.id))
        if not interview:
            interview = Interview(candidate_id=candidate.id, batch_id=batch.id, job_id=job.id, question_version=1,
                                  status="consent_pending" if index == 0 else "completed", consented=index != 0,
                                  consent_version=notice_version if index else "CONSENT-1.0",
                                  mic_checked=index != 0, current_question=1 if index == 0 else 7)
            db.add(interview)
            db.flush()
        if index == 0:
            continue
        if not db.scalar(select(Answer.id).where(Answer.interview_id == interview.id).limit(1)):
            db.add_all([Answer(interview_id=interview.id, question_id=question.id, answer_code=f"A{question.sequence}",
                               transcript=transcript) for question, transcript in zip(questions, DEFAULT_TRANSCRIPTS)])
        if not db.scalar(select(Report.id).where(Report.interview_id == interview.id)):
            answers = [{"sequence": q.sequence, "answer_code": f"A{q.sequence}", "question": q.content,
                        "transcript": DEFAULT_TRANSCRIPTS[q.sequence - 1], "timed_out": False} for q in questions]
            content = build_report(name, answers, profile)
            report = Report(interview_id=interview.id, candidate_id=candidate.id,
                            status="confirmed" if index in (1, 2) else "pending_review", current_version=1,
                            match_score=content["match_analysis"]["score"])
            db.add(report)
            db.flush()
            db.add(ReportVersion(report_id=report.id, version=1, version_type="ai_original",
                                 content=json.dumps(content, ensure_ascii=False), editor="AI面试智能体", reason="AI 原始生成"))
        if not db.scalar(select(ListeningSession.id).where(ListeningSession.candidate_id == candidate.id).limit(1)):
            db.add(ListeningSession(candidate_id=candidate.id, batch_id=batch.id))
