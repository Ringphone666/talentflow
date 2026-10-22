"""平台与AI面试接口测试共用的辅助函数：构造数据、等待后台处理、清理测试数据。

全部使用虚构数据，只操作测试库，不读取业务数据，也不调用外部服务。
"""
from __future__ import annotations

import io
import json
import time
from datetime import datetime, timezone

from sqlalchemy import delete, select

PROFILE = {"phone": "13800000000", "email": "flow@example.invalid", "education": "本科", "major": "食品科学", "years": "应届生"}
MIC = {"passed": True, "peak_rms": 0.08, "speech_frames": 12, "duration_ms": 3200, "speech_text": "麦克风测试一二三"}
SEED_BATCH = "2026-D01"
TEST_PASSWORD = "ChangeMe123!"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def staff(role="system_admin", user="admin"):
    return {"X-User-Role": role, "X-User-Name": user}


def candidate(username):
    return {"X-User-Role": "candidate", "X-User-Name": username}


def bearer(token):
    return {"Authorization": "Bearer " + token}


def answer_text(sequence):
    return f"第{sequence}题回答：我先核对事实和操作记录，再说明判断依据、采取的行动和结果。"


def audit_mark(client, source="platform"):
    """当前最新一条审计记录的序号。测试清理后编号会被重新使用，核对审计时只看本次操作新增的记录。"""
    rows = client.get(f"/api/audits?source={source}&limit=1", headers=staff()).json()
    return int(rows[0]["id"].split("-", 1)[1]) if rows else 0


def audits_since(client, mark, source="platform", **filters):
    response = client.get("/api/audits", headers=staff(), params={"source": source, "limit": 500, **filters})
    assert response.status_code == 200, response.text
    return [row for row in response.json() if int(row["id"].split("-", 1)[1]) > mark]


def forget_service_status():
    """外部服务状态会缓存片刻；需要核对当前配置时先清掉缓存（没有缓存时不做任何事）。"""
    from backend.app.system import overview
    cache = getattr(overview, "_status_cache", None)
    if isinstance(cache, dict):
        cache.clear()


# ---- 等待后台处理 ---------------------------------------------------------------

def wait_operation(client, operation, headers, timeout=60):
    """轮询 /api/library/operations，直到后台处理结束。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/library/operations/{operation['id']}", headers=headers)
        assert response.status_code == 200, response.text
        if response.json()["status"] != "running":
            return response.json()
        time.sleep(0.05)
    raise AssertionError(f"后台处理 {operation['id']} 在 {timeout} 秒内没有结束")


def wait_task(client, task_id, headers=None, timeout=120):
    """轮询匹配任务，直到不再处于待处理或处理中。"""
    headers = headers or staff("hr_admin", "hr")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/matching/tasks/{task_id}", headers=headers)
        assert response.status_code == 200, response.text
        if not response.json()["running"]:
            return response.json()
        time.sleep(0.05)
    raise AssertionError(f"匹配任务 {task_id} 在 {timeout} 秒内没有结束")


# ---- 岗位库、人员库 --------------------------------------------------------------

def job_payload(name, **changes):
    payload = {
        "name": name, "sequence": "职能序列", "level": "P3", "jd_version": "JD-TEST-1",
        "responsibilities": ["负责招聘计划编制与执行", "负责人员调配和入职手续办理"],
        "requirements": ["本科及以上学历", "三年以上人力资源工作经验"],
        "hard_conditions": ["本科及以上学历"],
        "dimensions": [{"name": "专业能力", "keywords": ["招聘", "人力资源"]},
                       {"name": "沟通协调", "keywords": ["沟通", "协调"]}],
        "weights": {"专业能力": 60, "沟通协调": 40},
        "scope": "自动化测试岗位", "extra_sections": {"工作地点": "测试地点"},
    }
    payload.update(changes)
    return payload


def resume_text(name, code="", phone="13812345678"):
    lines = [f"姓名：{name}"]
    if code:
        lines.append(f"候选人编号：{code}")
    lines += ["教育经历：本科，人力资源管理专业", "工作经历：三年招聘与人员调配工作", "项目经历：校园招聘项目",
              "专业技能：招聘、沟通协调、人力资源规划", "任职时间：2021年至今"]
    if phone:
        lines.append(f"联系电话：{phone}")
    return "\n".join(lines) + "\n"


def docx_bytes(text):
    from docx import Document
    document = Document()
    for line in text.splitlines():
        document.add_paragraph(line)
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def create_library_job(client, created, name, headers=None, **changes):
    response = client.post("/api/library/jobs", headers=headers or staff("hr_admin", "hr"), json=job_payload(name, **changes))
    assert response.status_code == 200, response.text
    created.library_jobs.append(response.json()["id"])
    return response.json()


def create_person_batch(client, created, name, category="社招", headers=None):
    response = client.post("/api/library/person-batches", headers=headers or staff("hr_admin", "hr"),
                           json={"name": name, "category": category})
    assert response.status_code == 200, response.text
    created.person_batches.append(response.json()["id"])
    return response.json()


def import_persons(client, batch_id, files, headers=None, **form):
    """files：[(文件名, 内容字节)]。返回后台处理结束后的结果。"""
    headers = headers or staff("hr_admin", "hr")
    response = client.post(f"/api/library/person-batches/{batch_id}/import", headers=headers, data=form,
                           files=[("files", (name, data, "application/octet-stream")) for name, data in files])
    assert response.status_code == 200, response.text
    # 导入在后台进行，接口先返回可轮询的处理记录。
    assert response.json()["kind"] == "person_import" and response.json()["status"] in ("running", "completed")
    operation = wait_operation(client, response.json(), headers)
    assert operation["status"] == "completed", operation
    return operation["result"]


# ---- AI面试 ---------------------------------------------------------------------

def seed_batch(code=SEED_BATCH):
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import Batch
    with SessionLocal() as db:
        batch = db.scalar(select(Batch).where(Batch.code == code))
        return {"id": batch.id, "job_id": batch.job_id, "code": batch.code, "name": batch.name,
                "question_version": batch.question_version}


def seed_candidate_id(code):
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import Candidate
    with SessionLocal() as db:
        return db.scalar(select(Candidate.id).where(Candidate.code == code))


def create_batch(client, created, code, name="自动化测试批次", *, mode="ai_interview", recruitment_type="社会招聘",
                 job_id=None, library_job_id=None, headers=None):
    body = {"code": code, "name": name, "recruitment_type": recruitment_type, "mode": mode}
    if library_job_id:
        body["library_job_id"] = library_job_id
    else:
        body["job_id"] = job_id or seed_batch()["job_id"]
    response = client.post("/api/batches", headers=headers or staff("hr_admin", "hr"), json=body)
    assert response.status_code == 200, response.text
    created.batches.append(response.json()["id"])
    return response.json()


def publish_questions(client, batch_id, count=6):
    """生成、提交、审核并发布一版题目，使批次可以建立AI面试记录。"""
    hr, reviewer = staff("hr_admin", "hr"), staff("question_reviewer", "question_reviewer")
    generated = client.post(f"/api/batches/{batch_id}/questions/generate", headers=hr, json={"count": count})
    assert generated.status_code == 200, generated.text
    path = f"/api/batches/{batch_id}/questions/{generated.json()['version']}"
    assert client.post(path + "/submit-review", headers=hr).status_code == 200
    assert client.post(path + "/review-all", headers=reviewer,
                       json={"approved": True, "comment": "整套题目已核对"}).status_code == 200
    assert client.post(path + "/publish", headers=reviewer).status_code == 200
    return generated.json()["version"]


def create_candidate(client, created, batch_id, name, headers=None, **body):
    response = client.post("/api/candidates", headers=headers or staff("hr_admin", "hr"),
                           json={"name": name, "batch_id": batch_id, **body})
    assert response.status_code == 200, response.text
    created.candidates.append(response.json()["id"])
    return response.json()


def my_interview(client, headers):
    response = client.get("/api/interviews/me", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def prepare_interview(client, headers, *, profile=True):
    """候选人完成面试前准备并开始面试，返回面试记录。"""
    interview = my_interview(client, headers)
    if profile:
        assert client.put("/api/interviews/me/profile", headers=headers, json=PROFILE).status_code == 200
    consent = client.post(f"/api/interviews/{interview['id']}/consent", headers=headers,
                          json={"consented": True, "notice_version": interview["available_consent_version"]})
    assert consent.status_code == 200, consent.text
    start_after_consent(client, headers, interview["id"])
    return my_interview(client, headers)


def start_after_consent(client, headers, interview_id):
    assert client.post(f"/api/interviews/{interview_id}/mic-check", headers=headers, json=MIC).status_code == 200
    started = client.post(f"/api/interviews/{interview_id}/start", headers=headers)
    assert started.status_code == 200, started.text


def answer_all(client, headers, interview):
    for question in interview["questions"]:
        response = client.post(f"/api/interviews/{interview['id']}/answers", headers=headers, json={
            "question_id": question["id"], "transcript": answer_text(question["sequence"]), "generate_followup": False})
        assert response.status_code == 200, response.text


def stored_answers(interview_id):
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import Answer
    with SessionLocal() as db:
        rows = db.scalars(select(Answer).where(Answer.interview_id == interview_id).order_by(Answer.id)).all()
        return [(a.id, a.question_id, a.answer_code, a.transcript, a.followup_text, a.followup_answer, a.timed_out)
                for a in rows]


def create_completed_candidate(created, code, name="虚构候选人", *, report_status="pending_review", scores=None,
                               consented=True, batch_code=SEED_BATCH):
    """直接写入一名已完成第一阶段面试的虚构候选人（含回答和AI原始报告），写法与测试数据初始化一致。"""
    from backend.app.core.database import SessionLocal
    from backend.app.interview import listening_intelligence, mock_engine
    from backend.app.interview.models import Answer, Batch, Candidate, Interview, Question, Report, ReportVersion
    stamp = datetime.now(timezone.utc)
    with SessionLocal() as db:
        batch = db.scalar(select(Batch).where(Batch.code == batch_code))
        questions = db.scalars(select(Question).where(
            Question.batch_id == batch.id, Question.version == batch.question_version).order_by(Question.sequence)).all()
        person = Candidate(code=code, name=name, is_fictional=True, batch_id=batch.id, job_id=batch.job_id,
                           profile_json=json.dumps(PROFILE, ensure_ascii=False))
        db.add(person)
        db.flush()
        interview = Interview(candidate_id=person.id, batch_id=batch.id, job_id=batch.job_id,
                              question_version=batch.question_version, status="completed", consented=consented,
                              consent_version=listening_intelligence.current_notice()[0],
                              consented_at=stamp if consented else None, mic_checked=True,
                              current_question=len(questions) + 1, started_at=stamp, completed_at=stamp)
        db.add(interview)
        db.flush()
        answers = []
        for question, transcript in zip(questions, mock_engine.DEFAULT_TRANSCRIPTS):
            db.add(Answer(interview_id=interview.id, question_id=question.id, answer_code=f"A{question.sequence}",
                          transcript=transcript))
            answers.append({"sequence": question.sequence, "answer_code": f"A{question.sequence}",
                            "question": question.content, "transcript": transcript, "timed_out": False})
        content = mock_engine.build_report(name, answers, scores)
        report = Report(interview_id=interview.id, candidate_id=person.id, status=report_status, current_version=1,
                        match_score=content["match_analysis"]["score"])
        db.add(report)
        db.flush()
        db.add(ReportVersion(report_id=report.id, version=1, version_type="ai_original",
                             content=json.dumps(content, ensure_ascii=False), editor="AI面试智能体", reason="AI 原始生成"))
        db.commit()
        record = {"candidate_id": person.id, "interview_id": interview.id, "report_id": report.id, "code": code,
                  "name": name, "batch_id": batch.id, "job_id": batch.job_id, "content": content}
    created.candidates.append(record["candidate_id"])
    return record


def add_capture(capture_id, candidate_id, transcript, *, owner="interviewer", role="interviewer", status="completed",
                **fields):
    """写入一段旁听录音的转写结果，代替真实的语音采集。"""
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import SpeechCapture
    with SessionLocal() as db:
        db.add(SpeechCapture(id=capture_id, owner=owner, role=role, kind="listening", target_id=candidate_id,
                             status=status, transcript=transcript, **fields))
        db.commit()
    return capture_id


def document_xml(content):
    """读取接口返回的 Word 文档正文。"""
    from zipfile import ZipFile
    with ZipFile(io.BytesIO(content)) as archive:
        assert "word/document.xml" in archive.namelist()
        return archive.read("word/document.xml").decode("utf-8")


# ---- 清理 -----------------------------------------------------------------------

def purge_candidates(candidate_ids):
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import (Answer, Candidate, Interview, ListeningContext, ListeningSession, Report,
                                              ReportVersion, SensitiveBlock, SpeechCapture, User)
    with SessionLocal() as db:
        for candidate_id in dict.fromkeys(candidate_ids):
            for interview_id in db.scalars(select(Interview.id).where(Interview.candidate_id == candidate_id)).all():
                db.execute(delete(Answer).where(Answer.interview_id == interview_id))
                db.execute(delete(SensitiveBlock).where(SensitiveBlock.interview_id == interview_id))
                db.execute(delete(SpeechCapture).where(SpeechCapture.kind.in_(("interview", "mic_check")),
                                                       SpeechCapture.target_id == interview_id))
            for report_id in db.scalars(select(Report.id).where(Report.candidate_id == candidate_id)).all():
                db.execute(delete(ReportVersion).where(ReportVersion.report_id == report_id))
            db.execute(delete(Report).where(Report.candidate_id == candidate_id))
            db.execute(delete(Interview).where(Interview.candidate_id == candidate_id))
            for session_id in db.scalars(select(ListeningSession.id).where(ListeningSession.candidate_id == candidate_id)).all():
                db.execute(delete(ListeningContext).where(ListeningContext.session_id == session_id))
            db.execute(delete(ListeningSession).where(ListeningSession.candidate_id == candidate_id))
            db.execute(delete(SpeechCapture).where(SpeechCapture.kind == "listening", SpeechCapture.target_id == candidate_id))
            db.execute(delete(User).where(User.candidate_id == candidate_id, User.role == "candidate"))
            db.execute(delete(Candidate).where(Candidate.id == candidate_id))
        db.commit()


def purge_batches(batch_ids):
    """删除测试建立的面试批次及其题目、候选人、现场入口；返回这些批次在人员库中自动建立的批次编号。"""
    from backend.app.core.database import SessionLocal
    from backend.app.interview.models import Batch, Candidate, OnsiteEntry, Question
    person_batches = []
    for batch_id in dict.fromkeys(batch_ids):
        with SessionLocal() as db:
            members = db.scalars(select(Candidate.id).where(Candidate.batch_id == batch_id)).all()
        purge_candidates(members)
        with SessionLocal() as db:
            batch = db.get(Batch, batch_id)
            if batch and batch.library_person_batch_id:
                person_batches.append(batch.library_person_batch_id)
            db.execute(delete(Question).where(Question.batch_id == batch_id))
            db.execute(delete(OnsiteEntry).where(OnsiteEntry.batch_id == batch_id))
            db.execute(delete(Batch).where(Batch.id == batch_id))
            db.commit()
    return person_batches


class Created:
    """登记一个测试建立的数据，测试结束后按依赖顺序清理。"""

    def __init__(self, client):
        self.client = client
        self.tasks: list[str] = []
        self.candidates: list[int] = []
        self.batches: list[int] = []
        self.person_batches: list[str] = []
        self.library_jobs: list[str] = []
        self.callbacks: list = []

    def cleanup(self):
        admin = staff()
        for callback in reversed(self.callbacks):
            callback()
        for task_id in dict.fromkeys(self.tasks):
            if self.client.get(f"/api/matching/tasks/{task_id}", headers=admin).status_code == 404:
                continue
            wait_task(self.client, task_id, admin)
            response = self.client.delete(f"/api/matching/tasks/{task_id}", headers=admin)
            assert response.status_code == 200, response.text
        purge_candidates(self.candidates)
        self.person_batches += purge_batches(self.batches)
        existing = {item["id"] for item in self.client.get("/api/library/person-batches", headers=admin).json()}
        batch_ids = [batch_id for batch_id in dict.fromkeys(self.person_batches) if batch_id in existing]
        if batch_ids:
            response = self.client.post("/api/library/person-batches/delete", headers=admin, json={"batch_ids": batch_ids})
            assert response.status_code == 200, response.text
        for job_id in dict.fromkeys(self.library_jobs):
            if self.client.get(f"/api/library/jobs/{job_id}", headers=admin).status_code == 404:
                continue
            assert self.client.post(f"/api/library/jobs/{job_id}/archive", headers=admin).status_code == 200
            response = self.client.delete(f"/api/library/jobs/{job_id}", headers=admin)
            assert response.status_code == 200, response.text
