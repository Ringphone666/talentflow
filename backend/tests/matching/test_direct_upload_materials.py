from pathlib import Path

import fitz
import pytest
from docx import Document

from .fixture_data import init_db
from matching_core.services import workflow as workflow


def material(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".pdf":
        document = fitz.open()
        document.new_page().insert_text((60, 60), content)
        document.save(path)
        document.close()
    elif path.suffix == ".docx":
        document = Document()
        for line in content.splitlines():
            document.add_paragraph(line)
        document.save(path)
    else:
        path.write_text(content, encoding="utf-8")
    return path


@pytest.mark.parametrize("fit", [False, True])
@pytest.mark.parametrize("extension", [".pdf", ".docx", ".txt"])
def test_same_named_resume_and_minutes_remain_separate_and_retain_both_evidence_sources(tmp_path, fit, extension):
    database = tmp_path / "upload.sqlite"
    init_db(database)
    jobs = [job["id"] for job in workflow.get_jobs(database)[:2]]
    resume = material(tmp_path / "resume" / ("candidate" + extension), "resume_unique_evidence project delivery\neducation university")
    minutes = material(tmp_path / "minutes" / ("candidate" + extension), "minutes_unique_evidence interview result\nteamwork cooperation")
    original_resume_bytes, original_minutes_bytes = resume.read_bytes(), minutes.read_bytes()
    task = (workflow.create_fit_task(jobs, [resume.name], "招聘人员", database) if fit else
            workflow.create_task(jobs[0], [resume.name], "招聘人员", database))
    mapping = {resume.stem: minutes}
    ids = (workflow.process_fit_task(task, [resume], "招聘人员", mapping, database) if fit else
           workflow.process_task(task, jobs[0], [resume], "招聘人员", mapping, database))
    assert len(ids) == 1
    candidate = workflow.get_candidate(ids[0], database)
    saved_resume = Path(candidate["original_path"])
    saved_minutes = saved_resume.parent / "minutes" / resume.name / ("面试纪要_" + minutes.name)
    assert saved_resume.read_bytes() == original_resume_bytes
    assert saved_minutes.read_bytes() == original_minutes_bytes
    evidence = candidate["parsed"]["raw_evidence"]
    assert any("resume_unique_evidence" in item["text"] and item["file"] == resume.name for item in evidence)
    assert any("minutes_unique_evidence" in item["text"] and item["file"] == "面试纪要_" + minutes.name for item in evidence)
    combined = Path(candidate["redacted_path"]).read_text(encoding="utf-8")
    assert "resume_unique_evidence" in combined and "minutes_unique_evidence" in combined
    if fit:
        assert len(workflow.get_candidate_job_matches(task_id=task, db_path=database)) == 2


def test_distinct_companion_filename_keeps_its_original_evidence_label(tmp_path):
    database = tmp_path / "upload.sqlite"
    init_db(database)
    job = workflow.get_jobs(database)[0]["id"]
    resume = material(tmp_path / "简历.txt", "姓名：测试人员\n教育背景：本科")
    minutes = material(tmp_path / "会议纪要.txt", "面试评价：表达清晰，项目职责可核实")
    task = workflow.create_task(job, [resume.name], "招聘人员", database)
    cid = workflow.process_resume(task, job, resume, "招聘人员", minutes, database)
    candidate = workflow.get_candidate(cid, database)
    assert (Path(candidate["original_path"]).parent / "minutes" / resume.name / minutes.name).read_bytes() == minutes.read_bytes()
    assert any(item["file"] == minutes.name and "项目职责可核实" in item["text"] for item in candidate["parsed"]["raw_evidence"])


def test_minutes_with_another_candidates_resume_name_cannot_overwrite_that_resume(tmp_path):
    database = tmp_path / "upload.sqlite"
    init_db(database)
    job = workflow.get_jobs(database)[0]["id"]
    first = material(tmp_path / "resumes" / "甲.txt", "姓名：甲\n教育背景：本科甲")
    second = material(tmp_path / "resumes" / "乙.txt", "姓名：乙\n教育背景：本科乙")
    companion = material(tmp_path / "minutes" / "甲.txt", "面试评价：乙的面试补充材料")
    task = workflow.create_task(job, [first.name, second.name], "招聘人员", database)
    ids = workflow.process_task(task, job, [first, second], "招聘人员", {second.stem: companion}, database)
    assert len(ids) == 2
    candidates = {item["source_filename"]: item for item in workflow.get_candidates(task, database)}
    assert Path(candidates[first.name]["original_path"]).read_bytes() == first.read_bytes()
    assert "乙的面试补充材料" in Path(candidates[second.name]["redacted_path"]).read_text(encoding="utf-8")


def test_generated_minutes_prefix_cannot_overwrite_another_candidates_companion(tmp_path):
    database = tmp_path / "upload.sqlite"
    init_db(database)
    job = workflow.get_jobs(database)[0]["id"]
    first = material(tmp_path / "resumes" / "甲.txt", "姓名：甲\n教育背景：本科甲")
    second = material(tmp_path / "resumes" / "乙.txt", "姓名：乙\n教育背景：本科乙")
    first_minutes = material(tmp_path / "minutes" / "甲.txt", "面试评价：甲的补充材料")
    second_minutes = material(tmp_path / "minutes" / "面试纪要_甲.txt", "面试评价：乙的补充材料")
    task = workflow.create_task(job, [first.name, second.name], "招聘人员", database)
    ids = workflow.process_task(task, job, [first, second], "招聘人员", {first.stem: first_minutes, second.stem: second_minutes}, database)
    assert len(ids) == 2
    root = Path(workflow.get_candidate(ids[0], database)["original_path"]).parent / "minutes"
    assert (root / first.name / "面试纪要_甲.txt").read_bytes() == first_minutes.read_bytes()
    assert (root / second.name / "面试纪要_甲.txt").read_bytes() == second_minutes.read_bytes()
