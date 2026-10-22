from pathlib import Path
from . import helpers
from .helpers import create_job_from_description

import fitz
import pytest

pytestmark = pytest.mark.usefixtures("offline_job_extraction")

from matching_core.db import init_db, rows
from matching_core.services.workflow import (
    create_job,
    get_job,
    prepare_job_import,
)


@pytest.fixture
def import_db(tmp_path: Path) -> Path:
    path = tmp_path / "imports.db"
    init_db(path, seed=False)
    return path


@pytest.fixture
def reference_job(import_db: Path) -> dict:
    job_id = create_job(
        "招聘参考岗", "人力资源序列", "P5", "HR-1.0",
        ["负责招聘计划"], ["具备招聘经验"], ["必须持有人力资源资格证书"],
        [{"name": "招聘管理", "keywords": ["招聘", "面试"]},
         {"name": "人才发展", "keywords": ["培训", "发展"]}],
        {"招聘管理": 75.0, "人才发展": 25.0}, "参考岗位", "招聘人员", import_db,
    )
    return get_job(job_id, import_db)


def write_jd(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "岗位说明书.txt"
    path.write_text(text, encoding="utf-8")
    return path


def test_complete_pdf_import_needs_no_reference(import_db: Path, tmp_path: Path):
    path = tmp_path / "销售说明书.pdf"
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text(
            (40, 40),
            "岗位名称：销售专员\n岗位序列：销售序列\n职级：P3\nJD版本：SALE-1.0\n"
            "岗位职责\n负责客户开发\n任职要求\n具备销售经验\n"
            "硬性条件\n持有驾驶证\n能力维度\n客户开发\n销售谈判\n回款管理",
            fontname="china-s",
        )
        document.save(path)

    prepared = prepare_job_import(path, db_path=import_db)
    assert prepared["model_source"] == "文件明确维度及已有权重，AI补充缺失权重（待人工确认）"
    assert prepared["weights"] == {"客户开发": 33.33, "销售谈判": 33.33, "回款管理": 33.34}
    assert prepared["status"]
    assert prepared["warning"] == ""
    assert rows("SELECT * FROM jobs", db_path=import_db) == []
    assert rows("SELECT * FROM audits", db_path=import_db) == []

    job_id = create_job_from_description(path, None, "招聘人员", db_path=import_db)
    job = get_job(job_id, import_db)
    assert job["name"] == "销售专员"
    assert job["sequence"] == "销售序列"
    assert job["level"] == "P3"
    assert job["jd_version"] == "SALE-1.0"
    assert job["responsibilities"] == ["负责客户开发"]
    assert job["requirements"] == ["具备销售经验"]
    assert [item["name"] for item in job["hard_conditions"]] == ["持有驾驶证"]
    assert job["weights"] == prepared["weights"]
    assert job["extra_sections"] == {"资料来源": path.name, "评分标准来源": "文件明确维度及已有权重，AI补充缺失权重（待人工确认）", "信息提取模型": "chat-primary"}


def test_missing_dimensions_are_reviewable_but_cannot_be_saved(import_db: Path, tmp_path: Path):
    path = write_jd(
        tmp_path, "岗位名称：销售专员\n岗位序列：销售序列\n职级：P3\n"
        "岗位职责\n负责客户开发\n任职要求\n具备销售经验",
    )
    prepared = prepare_job_import(path, db_path=import_db)
    assert prepared["dimensions"] == []
    assert prepared["weights"] == {}
    assert prepared["model_source"] == "AI评分建议待生成"
    with pytest.raises(ValueError, match="至少需要一个胜任力维度"):
        create_job_from_description(path, None, "招聘人员", db_path=import_db)
    assert rows("SELECT * FROM jobs", db_path=import_db) == []
    assert rows("SELECT * FROM audits", db_path=import_db) == []


def test_explicit_reference_only_supplies_dimensions_and_weights(
    import_db: Path, tmp_path: Path, reference_job: dict,
):
    path = write_jd(tmp_path, "岗位名称：销售专员\n岗位职责\n负责客户开发\n任职要求\n具备销售经验")
    before_audits = rows("SELECT * FROM audits", db_path=import_db)
    prepared = prepare_job_import(path, reference_job["id"], import_db)
    assert prepared["sequence"] == prepared["level"] == prepared["jd_version"] == ""
    assert prepared["responsibilities"] == ["负责客户开发"]
    assert prepared["requirements"] == ["具备销售经验"]
    assert prepared["hard_conditions"] == []
    assert prepared["dimensions"] == reference_job["dimensions"]
    assert prepared["weights"] == reference_job["weights"]
    assert prepared["model_source"] == "借用招聘参考岗"
    assert len(rows("SELECT * FROM jobs", db_path=import_db)) == 1
    assert rows("SELECT * FROM audits", db_path=import_db) == before_audits

    with pytest.raises(ValueError, match="岗位名称、岗位类别和职级不能为空"):
        create_job_from_description(path, reference_job["id"], "招聘人员", db_path=import_db)
    job_id = create_job_from_description(
        path, reference_job["id"], "招聘人员", "销售主管", "销售序列", "P4", import_db,
    )
    job = get_job(job_id, import_db)
    assert job["name"] == "销售主管"
    assert job["sequence"] == "销售序列"
    assert job["level"] == "P4"
    assert job["responsibilities"] == ["负责客户开发"]
    assert job["requirements"] == ["具备销售经验"]
    assert job["hard_conditions"] == []
    assert job["weights"] == reference_job["weights"]


def test_file_dimensions_take_precedence_and_receive_equal_weights(
    import_db: Path, tmp_path: Path, reference_job: dict,
):
    path = write_jd(tmp_path, "能力维度\n招聘管理\n人才发展")
    prepared = prepare_job_import(path, reference_job["id"], import_db)
    assert prepared["model_source"] == "文件明确维度及已有权重，AI补充缺失权重（待人工确认）"
    assert prepared["dimensions"] == [
        {"name": "招聘管理", "keywords": ["招聘管理"]},
        {"name": "人才发展", "keywords": ["人才发展"]},
    ]
    assert prepared["weights"] == {"招聘管理": 50.0, "人才发展": 50.0}


def test_reference_does_not_fill_missing_job_requirements(
    import_db: Path, tmp_path: Path, reference_job: dict,
):
    path = write_jd(tmp_path, "岗位名称：销售专员\n岗位序列：销售序列\n职级：P3")
    prepared = prepare_job_import(path, reference_job["id"], import_db)
    assert prepared["responsibilities"] == []
    assert prepared["requirements"] == []
    assert prepared["hard_conditions"] == []
    with pytest.raises(ValueError, match="岗位职责和任职要求均至少填写一项"):
        create_job_from_description(path, reference_job["id"], "招聘人员", db_path=import_db)
    assert len(rows("SELECT * FROM jobs", db_path=import_db)) == 1
