from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32), index=True)
    password_hash: Mapped[str] = mapped_column(String(256), default="")
    # 旧版在此保存候选人明文初始密码。现在密码只在生成时展示一次，本列保留为空以兼容旧库。
    initial_password: Mapped[str] = mapped_column(String(128), default="")
    candidate_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Job(Base):
    """岗位的面试评价标准。岗位说明以岗位库为准，这里是面试用的补充材料。"""
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    # 岗位库（人岗匹配核心 jobs.id）中的岗位编号；旧数据迁移前可能为空。
    library_job_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    duties: Mapped[str] = mapped_column(Text)
    requirements: Mapped[str] = mapped_column(Text)
    professional_requirements: Mapped[str] = mapped_column(Text)
    competency_model: Mapped[str] = mapped_column(Text)
    material_version: Mapped[str] = mapped_column(String(32))
    audit_status: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class JobMaterial(Base):
    __tablename__ = "job_materials"
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), index=True)
    original_name: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(Integer, default=0)
    ocr_status: Mapped[str] = mapped_column(String(24), default="not_requested")
    ocr_text: Mapped[str] = mapped_column(Text, default="")
    ocr_error: Mapped[str] = mapped_column(Text, default="")
    ocr_provider: Mapped[str] = mapped_column(String(32), default="paddleocr")
    ocr_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EvaluationDimension(Base):
    __tablename__ = "evaluation_dimensions"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    definition: Mapped[str] = mapped_column(Text)
    weight: Mapped[int] = mapped_column(Integer)
    rubric: Mapped[str] = mapped_column(Text)


class Batch(Base):
    __tablename__ = "batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    recruitment_type: Mapped[str] = mapped_column(String(32))
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    status: Mapped[str] = mapped_column(String(32), default="draft")
    question_version: Mapped[int] = mapped_column(Integer, default=0)
    # ai_interview：先做第一阶段AI面试（旁听可选）；listening_only：不做AI面试，直接人工面试旁听。
    mode: Mapped[str] = mapped_column(String(24), default="ai_interview")
    # 本批次直接上传的候选人简历所归入的人员库批次。
    library_person_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    job: Mapped[Job] = relationship()


class OnsiteEntry(Base):
    """线下集中面试的现场入口：由工作人员为一个批次开启，候选人免登录。"""
    __tablename__ = "onsite_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"), index=True)
    token_id: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str] = mapped_column(String(64))
    # 工作人员确认已在现场向候选人告知采集事项并取得同意。
    consent_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    notice_version: Mapped[str] = mapped_column(String(64), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (UniqueConstraint("batch_id", "job_id", "version", "sequence", name="uq_question_snapshot"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"), index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    dimension: Mapped[str] = mapped_column(String(64))
    content: Mapped[str] = mapped_column(Text)
    time_limit: Mapped[int] = mapped_column(Integer, default=90)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    review_comment: Mapped[str] = mapped_column(Text, default="")
    change_log: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Candidate(Base):
    __tablename__ = "candidates"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    is_fictional: Mapped[bool] = mapped_column(Boolean, default=False)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"))
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    # 人员库（人岗匹配核心 talent_entries.id）中的人员编号，用于复用简历解析结果和硬指标。
    library_person_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    profile_json: Mapped[str] = mapped_column(Text, default="{}")
    # 当前候选人简历文件。文件本体保存在 data/resumes，数据库只保存可追溯的元数据。
    resume_path: Mapped[str] = mapped_column(String(512), default="")
    resume_original_name: Mapped[str] = mapped_column(String(255), default="")
    resume_size: Mapped[int] = mapped_column(Integer, default=0)
    resume_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resume_ocr_status: Mapped[str] = mapped_column(String(24), default="not_requested")
    resume_ocr_text: Mapped[str] = mapped_column(Text, default="")
    resume_ocr_error: Mapped[str] = mapped_column(Text, default="")
    resume_ocr_provider: Mapped[str] = mapped_column(String(32), default="paddleocr")
    resume_ocr_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Interview(Base):
    __tablename__ = "interviews"
    id: Mapped[int] = mapped_column(primary_key=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"), unique=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"))
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    question_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="consent_pending")
    consented: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_version: Mapped[str] = mapped_column(String(32), default="CONSENT-1.0")
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_question: Mapped[int] = mapped_column(Integer, default=1)
    mic_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # account：候选人用账号密码登录；onsite：线下集中面试现场入口。
    entry_mode: Mapped[str] = mapped_column(String(16), default="account")
    # online：候选人在系统内阅读并同意；offline_attested：工作人员确认已线下告知并取得同意。
    consent_method: Mapped[str] = mapped_column(String(24), default="online")
    consent_recorded_by: Mapped[str] = mapped_column(String(64), default="")
    candidate: Mapped[Candidate] = relationship()


class Answer(Base):
    __tablename__ = "answers"
    __table_args__ = (UniqueConstraint("interview_id", "question_id", name="uq_interview_question_answer"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    interview_id: Mapped[int] = mapped_column(ForeignKey("interviews.id"), index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id"))
    answer_code: Mapped[str] = mapped_column(String(32))
    transcript: Mapped[str] = mapped_column(Text)
    recording_path: Mapped[str] = mapped_column(Text, default="")
    timed_out: Mapped[bool] = mapped_column(Boolean, default=False)
    followup_text: Mapped[str] = mapped_column(Text, default="")
    followup_answer: Mapped[str] = mapped_column(Text, default="")
    followup_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SensitiveBlock(Base):
    __tablename__ = "sensitive_blocks"
    id: Mapped[int] = mapped_column(primary_key=True)
    interview_id: Mapped[int | None] = mapped_column(ForeignKey("interviews.id"), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(String(120))
    source_type: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    interview_id: Mapped[int] = mapped_column(ForeignKey("interviews.id"), unique=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"), index=True)
    # generating / generation_failed / pending_review / returned / confirmed
    status: Mapped[str] = mapped_column(String(32), default="pending_review")
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    match_score: Mapped[float] = mapped_column(Float, default=0)
    generation_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ReportVersion(Base):
    __tablename__ = "report_versions"
    __table_args__ = (UniqueConstraint("report_id", "version", name="uq_report_version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    version_type: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    editor: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(Text, default="AI 原始生成")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ListeningSession(Base):
    __tablename__ = "listening_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    candidate_id: Mapped[int] = mapped_column(ForeignKey("candidates.id"))
    batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    source_mode: Mapped[str] = mapped_column(String(16), default='unconfigured')
    # linked：关联第一阶段报告；standalone：不依赖第一阶段，仅依据简历和岗位。
    mode: Mapped[str] = mapped_column(String(16), default='linked')
    # 旁听开始前依据简历和岗位生成的提问建议。
    prepared_questions: Mapped[str] = mapped_column(Text, default='[]')
    status: Mapped[str] = mapped_column(String(32), default="ready")
    transcript_index: Mapped[int] = mapped_column(Integer, default=0)
    transcript: Mapped[str] = mapped_column(Text, default="[]")
    suggestions: Mapped[str] = mapped_column(Text, default="[]")
    comprehensive_report: Mapped[str] = mapped_column(Text, default="")
    comprehensive_status: Mapped[str] = mapped_column(String(24), default="not_generated")
    comprehensive_version: Mapped[int] = mapped_column(Integer, default=0)
    comprehensive_versions: Mapped[str] = mapped_column(Text, default="[]")
    # 综合报告在后台生成；没有生成出来时记录原因，页面据此提示重新生成。
    comprehensive_error: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ListeningContext(Base):
    __tablename__ = 'listening_contexts'
    session_id: Mapped[int] = mapped_column(ForeignKey('listening_sessions.id'), primary_key=True)
    consent: Mapped[str] = mapped_column(Text, default='{}')
    stage_one: Mapped[str] = mapped_column(Text, default='{}')
    speakers: Mapped[str] = mapped_column(Text, default='{}')
    last_evidence_hash: Mapped[str] = mapped_column(String(64), default='')


class SpeechCapture(Base):
    __tablename__ = 'speech_captures'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[int] = mapped_column(Integer)
    question_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    phase: Mapped[str] = mapped_column(String(16), default='main')
    status: Mapped[str] = mapped_column(String(24), default='created')
    transcript: Mapped[str] = mapped_column(Text, default='')
    provider_result: Mapped[str] = mapped_column(Text, default='{}')
    alignment_status: Mapped[str] = mapped_column(String(24), default='not_requested')
    alignment_result: Mapped[str] = mapped_column(Text, default='{}')
    speaker_status: Mapped[str] = mapped_column(String(24), default='not_requested')
    speaker_result: Mapped[str] = mapped_column(Text, default='{}')
    audio_path: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
