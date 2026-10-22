import pytest


@pytest.fixture(autouse=True)
def offline_models(monkeypatch, tmp_path):
    """测试不得使用开发者 .env 中的真实凭据，也不得写入业务数据目录。"""
    monkeypatch.setenv("MODEL_PROVIDER", "local_rules")
    from matching_core.services import workflow, report, task_queue
    for name in ("ORIGINAL_DIR", "REDACTED_DIR", "STRUCTURED_DIR"):
        target = tmp_path / name.lower()
        target.mkdir()
        monkeypatch.setattr(workflow, name, target)
    monkeypatch.setattr(report, "REPORT_DIR", tmp_path / "reports")
    queue = tmp_path / "queue"
    queue.mkdir()
    monkeypatch.setattr(task_queue, "QUEUE_DIR", queue)


@pytest.fixture
def offline_job_extraction(monkeypatch):
    """下游导入测试使用的确定性抽取结果。"""
    from matching_core.services import job_extraction, parser
    monkeypatch.setattr(job_extraction, "extract_job_with_ai", lambda path: parser.parse_job_description(path, existing_job=None, allow_ocr=True))

    monkeypatch.setattr(job_extraction, "extract_jobs_with_ai", lambda path: [{"index": 1, "parsed": parser.parse_job_description(path, existing_job=None, allow_ocr=True), "error": ""}])

    from matching_core.services import job_scorecard, workflow
    def suggest(job):
        if not job.get('dimensions'):
            raise ValueError('测试模型未提供建议')
        return dict(dimensions=job['dimensions'], weights=workflow._equal_weights(job['dimensions']), basis=[])
    monkeypatch.setattr(job_scorecard, 'generate_job_scorecard', suggest)
