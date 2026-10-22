import copy
from . import helpers
import json
from concurrent.futures import Future
from pathlib import Path

import pytest

from .fixture_data import init_db
from matching_core.db import connect, row
from matching_core.services import workflow as w, task_queue as q


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    database = tmp_path / "pipeline.sqlite"
    init_db(database)
    monkeypatch.setattr(w, "QUEUE_DIR", q.QUEUE_DIR)
    monkeypatch.setattr(w, "enrich_candidate", lambda value: value)

    def parse(path, *args, **kwargs):
        text = "开发系统并协调跨部门项目"
        parsed = dict(candidate_code="SAME", full_name=path.stem, masked_name="测*",
                      parse_status="解析成功", model_analysis={}, fields={
                          "skills": dict(label="专业技能", value=text, status="已识别", evidence=text,
                                         source_file=path.name, location="第1行")},
                      raw_evidence=[dict(text=text, file=path.name, location="第1行")])
        return parsed, dict(detected=False, types=[]), text

    monkeypatch.setattr(w, "parse_material", parse)

    def assess(score, parsed, job, *args):
        score.update(scoring_method="ai_semantic_v1", reasoning_analysis={"status": "调用成功", "reason": "已完成"},
                     dimensions=[dict(dimension=name, score=80, weight=weight, evidence_available=True)
                                 for name, weight in job["weights"].items()])
        return w.score_value(score)

    monkeypatch.setattr(w, "analyze_score", assess)
    resumes = []
    for name in ("甲.pdf", "乙.pdf"):
        source = tmp_path / name
        source.write_bytes(b"synthetic")
        resumes.append(source)
    return database, ["JOB-TECH-001", "JOB-SALES-001"], resumes, assess


def make_task(pipeline, fit=True, count=1):
    db, jobs, paths, _ = pipeline
    task = (w.create_fit_task(jobs, [p.name for p in paths[:count]], "招聘人员", db) if fit else
            w.create_task(jobs[0], [p.name for p in paths[:count]], "招聘人员", db))
    ids = (w.process_fit_task(task, paths[:count], "招聘人员", db_path=db) if fit else
           w.process_task(task, jobs[0], paths[:count], "招聘人员", db_path=db))
    return task, ids


def test_fit_waits_for_every_job_before_marking_candidate_complete(pipeline, monkeypatch):
    db, jobs, paths, _ = pipeline
    seen = []
    original = w.evaluate_candidate_jobs

    def observe(cid, selected, operator, db_path):
        candidate = w.get_candidate(cid, db_path)
        progress = row("SELECT * FROM tasks WHERE id=?", (candidate["task_id"],), db_path)
        seen.append((selected[0], progress["status"], progress["processed_count"]))
        return original(cid, selected, operator, db_path)

    monkeypatch.setattr(w, "evaluate_candidate_jobs", observe)
    task, ids = make_task(pipeline)
    # 首个岗位在解析简历时已评分，矩阵直接沿用该结果，只对其余岗位再做分析。
    assert seen == [(job, "处理中", 0) for job in jobs[1:]]
    saved = row("SELECT * FROM tasks WHERE id=?", (task,), db)
    assert (saved["status"], saved["success_count"], saved["processed_count"]) == ("已完成", 1, 1)
    assert len(w.get_candidate_job_matches(task_id=task, db_path=db)) == 2


def test_fit_failure_is_visible_and_retry_fills_missing_match(pipeline, monkeypatch):
    db, jobs, paths, _ = pipeline
    original = w.evaluate_candidate_jobs
    def fail_one(cid, selected, operator, db_path):
        if selected == [jobs[1]]:
            raise RuntimeError("服务暂时不可用")
        return original(cid, selected, operator, db_path)
    monkeypatch.setattr(w, "evaluate_candidate_jobs", fail_one)
    task, ids = make_task(pipeline)
    saved = row("SELECT * FROM tasks WHERE id=?", (task,), db)
    assert (saved["status"], saved["success_count"], saved["failure_count"]) == ("部分失败", 0, 1)
    assert json.loads(saved["failure_reasons_json"])[0]["candidate_id"] == ids[0]
    w.save_fit_decision(ids[0], jobs[0], "已确认", "作为备选岗位", "招聘人员", db)
    monkeypatch.setattr(w, "evaluate_candidate_jobs", original)
    assert w.retry_failed_task(task, "招聘人员", db) == 1
    assert len(w.get_candidates(task, db)) == 1
    matches = w.get_candidate_job_matches(task_id=task, db_path=db)
    assert len(matches) == 2
    assert next(m for m in matches if m["job_id"] == jobs[0])["decision"] == "作为备选岗位"
    assert row("SELECT status FROM tasks WHERE id=?", (task,), db)["status"] == "已完成"


def test_model_failure_without_exception_is_a_task_failure(pipeline, monkeypatch):
    db, jobs, paths, _ = pipeline
    def unavailable(score, parsed, job, *args):
        score.update(scoring_method="ai_semantic_v1", reasoning_analysis={"status": "未成功", "reason": "超时"},
                     dimensions=[dict(dimension=name, score=None, weight=weight) for name, weight in job["weights"].items()])
    monkeypatch.setattr(w, "analyze_score", unavailable)
    task, ids = make_task(pipeline)
    assert len(ids) == 1
    saved = row("SELECT * FROM tasks WHERE id=?", (task,), db)
    assert saved["success_count"] == 0 and saved["failure_count"] == 1
    assert "超时" in saved["failure_reasons_json"]
    assert len(w.get_candidate_job_matches(task_id=task, db_path=db)) == 2


def test_duplicate_candidate_codes_do_not_overwrite_people_or_files(pipeline):
    db, *_ = pipeline
    task, ids = make_task(pipeline, count=2)
    assert len(set(ids)) == 2
    candidates = w.get_candidates(task, db)
    assert {c["full_name"] for c in candidates} == {"甲", "乙"}
    assert len({c["structured_path"] for c in candidates}) == 2
    assert len({c["redacted_path"] for c in candidates}) == 2


def test_reanalysis_preserves_decisions_and_old_score_if_retry_fails(pipeline, monkeypatch):
    db, jobs, _, assess = pipeline
    task, ids = make_task(pipeline)
    cid = ids[0]
    w.save_review(cid, "人工意见", "保留", "招聘人员", db)
    w.save_fit_decision(cid, jobs[1], "人工建议", "推荐至该岗位", "招聘人员", db)
    original = w.get_candidate(cid, db)["score"]
    def failed(score, parsed, job, *args):
        score.update(scoring_method="ai_semantic_v1", reasoning_analysis={"status": "未成功", "reason": "超时"},
                     dimensions=[dict(dimension=name, score=None, weight=weight) for name, weight in job["weights"].items()])
    monkeypatch.setattr(w, "analyze_score", failed)
    assert w.reanalyze_task(task, "招聘人员", db) == []
    candidate = w.get_candidate(cid, db)
    assert w.score_value(candidate["score"]) == w.score_value(original)
    assert candidate["decision"] == "保留"
    assert candidate["score"]["reasoning_analysis"]["last_attempt"]["status"] == "未成功"
    assert next(m for m in w.get_ranked_job_matches(cid, db) if m["job_id"] == jobs[1])["decision"] == "推荐至该岗位"
    monkeypatch.setattr(w, "analyze_score", assess)
    assert w.reanalyze_task(task, "招聘人员", db) == [cid]
    assert "last_attempt" not in w.get_candidate(cid, db)["score"]["reasoning_analysis"]


def test_manual_correction_has_distinct_provenance_and_invalidates_scores(pipeline):
    db, jobs, *_ = pipeline
    task, ids = make_task(pipeline)
    cid = ids[0]
    before = copy.deepcopy(w.get_candidate(cid, db)["parsed"]["raw_evidence"])
    helpers.update_candidate_fields(cid, {"skills": "已核实：负责Python系统开发与性能改进"}, "招聘人员", db)
    candidate = w.get_candidate(cid, db)
    assert candidate["parsed"]["raw_evidence"][:len(before)] == before
    manual = candidate["parsed"]["raw_evidence"][-1]
    assert manual["origin"] == "human_review" and manual["file"] == "人工核实记录"
    assert "不视为原文" in manual["text"]
    assert candidate["score"]["requires_reassessment"]
    assert all(m["score"]["requires_reassessment"] for m in w.get_ranked_job_matches(cid, db))
    w.reanalyze_task(task, "招聘人员", db)
    assert not w.get_candidate(cid, db)["score"].get("requires_reassessment")


def test_confirming_unchanged_fields_does_not_invalidate_score(pipeline):
    db, *_ = pipeline
    _, ids = make_task(pipeline, fit=False)
    cid = ids[0]
    value = w.get_candidate(cid, db)["parsed"]["fields"]["skills"]["value"]
    helpers.update_candidate_fields(cid, {"skills": value}, "招聘人员", db)
    candidate = w.get_candidate(cid, db)
    assert candidate["parse_status"] == "人工已复核"
    assert not candidate["score"].get("requires_reassessment")
    assert not any(e.get("origin") == "human_review" for e in candidate["parsed"]["raw_evidence"])


def test_valid_missing_evidence_is_completed_assessment_not_service_failure(pipeline, monkeypatch):
    db, *_ = pipeline
    task, ids = make_task(pipeline, fit=False)
    def no_evidence(score, parsed, job, *args):
        score.update(scoring_method="ai_semantic_v1", reasoning_analysis={"status": "调用成功", "reason": "无相关证据"},
                     dimensions=[dict(dimension=name, score=None, weight=weight) for name, weight in job["weights"].items()])
    monkeypatch.setattr(w, "analyze_score", no_evidence)
    assert w.reanalyze_task(task, "招聘人员", db) == ids
    assert w.score_value(w.get_candidate(ids[0], db)["score"]) is None
    saved = row("SELECT * FROM tasks WHERE id=?", (task,), db)
    assert saved["status"] == "已完成" and saved["success_count"] == 1
    assert saved['failure_count'] == 0


def test_background_analysis_authorization_dedup_and_recovery(pipeline, monkeypatch):
    db, *_ = pipeline
    task, ids = make_task(pipeline)
    submitted = []
    class Executor:
        def submit(self, function, *args):
            future = Future()
            submitted.append((function, args, future))
            return future
    monkeypatch.setattr(q, "_executor", Executor())
    monkeypatch.setattr(q, "_futures", {})
    with pytest.raises(PermissionError):
        q.enqueue_task_analysis(task, "未授权角色", db)
    with pytest.raises(PermissionError):
        q.enqueue_failed_retry(task, "面试官", db)
    q.enqueue_task_analysis(task, "招聘人员", db)
    with pytest.raises(ValueError, match="正在处理中"):
        q.enqueue_task_analysis(task, "招聘人员", db)
    payload = json.loads((q.QUEUE_DIR / f"{task}.json").read_text(encoding="utf-8"))
    assert payload["kind"] == "重新分析"
    assert row("SELECT status FROM tasks WHERE id=?", (task,), db)["status"] == "待处理"
    q._futures.clear()
    assert q.recover_pending_tasks(db) == [task]
    function, args, _ = submitted[-1]
    assert function(*args) == ids
    assert row("SELECT status FROM tasks WHERE id=?", (task,), db)["status"] == "已完成"


def test_background_retry_accepts_claimed_pending_state(pipeline, monkeypatch):
    db, jobs, _, _ = pipeline
    original = w.evaluate_candidate_jobs
    monkeypatch.setattr(w, "evaluate_candidate_jobs", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("失败")))
    task, ids = make_task(pipeline)
    monkeypatch.setattr(w, "evaluate_candidate_jobs", original)
    future = q.enqueue_failed_retry(task, "招聘人员", db)
    assert future.result(timeout=10) == 1
    assert len(w.get_candidate_job_matches(task_id=task, db_path=db)) == len(jobs)
    assert row("SELECT status FROM tasks WHERE id=?", (task,), db)["status"] == "已完成"


@pytest.mark.parametrize("delete_whole_task", [False, True])
def test_deleting_reused_candidate_preserves_source_material(pipeline, delete_whole_task):
    db, jobs, *_ = pipeline
    source_task, ids = make_task(pipeline, fit=False)
    source = w.get_candidate(ids[0], db)
    copied_task, copies = helpers.create_task_from_talent_pool(jobs[1], ids, "招聘人员", db)
    copied = w.get_candidate(copies[0], db)
    if delete_whole_task:
        w.delete_task(copied_task, "招聘人员", db)
    else:
        w.delete_candidate(copies[0], "招聘人员", db)
    assert Path(source["original_path"]).is_file()
    assert Path(source["redacted_path"]).is_file()
    assert not Path(copied["structured_path"]).exists()
    assert w.reanalyze_task(source_task, "招聘人员", db) == ids


def test_deleting_source_task_preserves_live_copies_until_last_reference(pipeline):
    db, jobs, *_ = pipeline
    source_task, ids = make_task(pipeline, fit=False)
    source = w.get_candidate(ids[0], db)
    copied_task, copies = helpers.create_task_from_talent_pool(jobs[1], ids, "招聘人员", db)
    w.delete_task(source_task, "招聘人员", db)
    assert w.get_candidate(copies[0], db)["source_candidate_id"] is None
    assert Path(source["original_path"]).is_file()
    assert Path(source["redacted_path"]).is_file()
    assert w.reanalyze_task(copied_task, "招聘人员", db) == copies
    w.delete_task(copied_task, "招聘人员", db)
    assert not Path(source["original_path"]).exists()
    assert not Path(source["redacted_path"]).exists()


def test_job_profile_changes_mark_primary_and_cross_job_results_stale(pipeline, monkeypatch):
    db, jobs, _, assess = pipeline
    task, ids = make_task(pipeline)
    job = w.get_job(jobs[1], db)
    w.update_job_profile(job["id"], job["name"], job["sequence"], job["level"], job["jd_version"],
                         ["新的岗位职责"], job["requirements"], [h["name"] for h in job["hard_conditions"]],
                         job["scope"], "招聘人员", db)
    matches = w.get_ranked_job_matches(ids[0], db)
    assert next(m for m in matches if m["job_id"] == jobs[1])["score"]["requires_reassessment"]
    assert not next(m for m in matches if m["job_id"] == jobs[0])["score"].get("requires_reassessment")
    assert not w.get_candidate(ids[0], db)["score"].get("requires_reassessment")
    w.update_job_weights(job["id"], job["weights"], "招聘人员", db)
    assert next(m for m in w.get_ranked_job_matches(ids[0], db) if m["job_id"] == jobs[1])["score"]["requires_reassessment"]
    calls = []
    def counted(score, parsed, job, *args):
        calls.append(job["id"])
        return assess(score, parsed, job, *args)
    monkeypatch.setattr(w, "analyze_score", counted)
    assert w.rescore_job_candidates(jobs[0], "招聘人员", db) == 1
    assert calls == [jobs[0]]
    w.reanalyze_task(task, "招聘人员", db)
    assert not any(m["score"].get("requires_reassessment") for m in w.get_ranked_job_matches(ids[0], db))
