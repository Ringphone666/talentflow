import json
import base64
import fitz
import pytest
from matching_core.services import ocr, parser

def scan(tmp_path):
    p = tmp_path / "scan.pdf"
    with fitz.open() as doc:
        doc.new_page().draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
        doc.save(p)
    return p

def test_no_consent_no_network(tmp_path, monkeypatch):
    monkeypatch.setattr(parser, "recognize_pdf", lambda *a, **k: pytest.fail("Unexpected network"))
    assert not parser.extract_pdf(scan(tmp_path)).text
    with pytest.raises(ocr.OCRError, match="未授权"):
        ocr.recognize_pdf(tmp_path / "not-read.pdf")

def test_text_pdf_stays_local(tmp_path, monkeypatch):
    p = tmp_path / "text.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 40), "Fictional resume")
        doc.new_page()
        doc.save(p)
    monkeypatch.setattr(parser, "recognize_pdf", lambda *a, **k: pytest.fail("Unexpected network"))
    assert parser.extract_pdf(p, allow_ocr=True).text


def mixed_pdf(tmp_path):
    path = tmp_path / "mixed.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 40), "Local first")
        doc.new_page()
        for _ in range(10):
            doc.new_page().draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
        doc.new_page().insert_text((40, 40), "Local last")
        doc.save(path)
    return path


def test_mixed_pdf_only_scans_selected_pages_and_retains_original_order(tmp_path, monkeypatch):
    path = mixed_pdf(tmp_path)
    def recognize(path, consent, page_numbers):
        assert consent is True and page_numbers == list(range(3, 13))
        return [f"## Scan {n}" for n in page_numbers], {"status": "调用成功", "page_numbers": page_numbers}
    monkeypatch.setattr(parser, "recognize_pdf", recognize)
    parsed = parser.extract_pdf(path, allow_ocr=True)
    assert parsed.text.splitlines() == ['Local first'] + [f'Scan {n}' for n in range(3, 13)] + ['Local last']
    assert parsed.evidence[0]['location'] == '第1页·第1行'
    assert parsed.evidence[1]['location'] == '第3页·OCR第1行'
    assert parsed.evidence[-1]['location'] == '第13页·第1行'
    assert parsed.ocr['blank_pages'] == [2]


def test_mixed_pdf_failure_preserves_all_local_pages(tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise ocr.OCRError('单页服务失败')
    monkeypatch.setattr(parser, 'recognize_pdf', fail)
    result = parser.extract_pdf(mixed_pdf(tmp_path), allow_ocr=True)
    assert result.text == 'Local first\nLocal last'
    assert [e['location'] for e in result.evidence] == ['第1页·第1行', '第13页·第1行']
    assert result.ocr['status'] == '未成功' and result.warning


def test_mixed_evidence_keeps_native_fields_and_redacts_each_page(tmp_path, monkeypatch):
    path = tmp_path / 'mixed-person.pdf'
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 40), '候选人编号：MIX-001\n姓名：测试\n教育经历：本科', fontname='china-s')
        doc.new_page()
        doc.new_page().draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
        doc.save(path)
    monkeypatch.setattr(parser, 'recognize_pdf', lambda *a, **k: (
        ['工作经历：招聘专员3年\n电话：13812345678'], {'status': '调用成功', 'page_numbers': [3]},
    ))
    parsed, info, text = parser.parse_material(path, allow_ocr=True)
    assert parsed['fields']['education']['location'] == '第1页·第3行'
    assert parsed['fields']['education']['status'] == '已识别'
    assert parsed['fields']['work_experience']['location'] == '第3页·OCR第1行'
    assert parsed['fields']['work_experience']['status'] == 'OCR提取，待人工确认'
    assert info['detected'] and '13812345678' not in text + json.dumps(parsed, ensure_ascii=False)


def test_blank_only_pdf_never_calls_ocr(tmp_path, monkeypatch):
    path = tmp_path / 'blank.pdf'
    with fitz.open() as doc:
        doc.new_page()
        doc.save(path)
    monkeypatch.setattr(parser, 'recognize_pdf', lambda *a, **k: pytest.fail('Blank page sent'))
    result = parser.extract_pdf(path, allow_ocr=True)
    assert not result.text and '空白页' in result.warning


def test_docx_and_txt_resumes_are_parsed_locally(tmp_path, monkeypatch):
    from docx import Document
    monkeypatch.setattr(parser, 'recognize_pdf', lambda *a, **k: pytest.fail('Unexpected network'))
    content = '候选人编号：LOCAL-001\n姓名：测试\n教育经历：本科'
    for suffix in ('.docx', '.txt'):
        path = tmp_path / ('resume' + suffix)
        if suffix == '.docx':
            doc = Document()
            doc.add_paragraph(content)
            doc.save(path)
        else:
            path.write_text(content, encoding='utf-8')
        parsed, _, text = parser.parse_material(path, allow_ocr=True)
        assert parsed['candidate_code'] == 'LOCAL-001'
        assert parsed['fields']['education']['value'] == '本科' and content == text


def test_layout_sends_only_selected_pages_in_bounded_requests(tmp_path, monkeypatch):
    path = mixed_pdf(tmp_path)
    calls = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size):
            return json.dumps({'errorCode': 0, 'result': {'layoutParsingResults': [{'markdown': {'text': f'Scan {len(calls)}'}}]}}).encode()
    class Opener:
        def open(self, request, timeout):
            payload = json.loads(request.data)
            with fitz.open(stream=base64.b64decode(payload['file']), filetype='pdf') as sent:
                assert len(sent) == 1 and not sent[0].get_text().strip()
                assert sent[0].get_drawings()
            assert timeout == 300
            calls.append(payload)
            return Response()
    monkeypatch.setattr(ocr, 'ocr_settings', lambda: {'provider': 'layout', 'enabled': True, 'url': 'https://example.test', 'allow_http': False})
    monkeypatch.setattr(ocr, 'build_opener', lambda *a: Opener())
    result = parser.extract_pdf(path, allow_ocr=True)
    assert result.ocr['status'] == '调用成功'
    assert len(calls) == 10 and result.ocr['page_numbers'] == list(range(3, 13))
    assert result.text.startswith('Local first') and result.text.endswith('Local last')


def test_layout_long_file_over_10mb_and_10_pages_is_processed_completely(tmp_path, monkeypatch):
    path = tmp_path / 'long.pdf'
    with fitz.open() as doc:
        for _ in range(12):
            doc.new_page().draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
        doc.save(path)
    with path.open('ab') as stream:
        stream.write(b'\0' * (11 * 1024 * 1024))
    calls = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size):
            return json.dumps({'errorCode': 0, 'result': {'layoutParsingResults': [{'markdown': {'text': f'Page {len(calls)}'}}]}}).encode()
    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            return Response()
    monkeypatch.setattr(ocr, 'ocr_settings', lambda: {'provider': 'layout', 'enabled': True, 'url': 'https://example.test', 'allow_http': False})
    monkeypatch.setattr(ocr, 'build_opener', lambda *a: Opener())
    texts, state = ocr.recognize_pdf(path, consent=True)
    assert len(calls) == len(texts) == 12 and state['page_numbers'] == list(range(1, 13))

def test_ocr_redaction_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(parser, "recognize_pdf", lambda *a, **k: (["姓名：测试\n教育经历：本科\n电话：13812345678\n证件：11010119900101123X"], {"status":"调用成功"}))
    parsed, info, text = parser.parse_material(scan(tmp_path), allow_ocr=True)
    assert info["detected"]
    assert "13812345678" not in json.dumps(parsed, ensure_ascii=False) + text
    assert "11010119900101123X" not in json.dumps(parsed, ensure_ascii=False) + text
    assert parsed["fields"]["education"]["location"] == "第1页·OCR第2行"
    assert "待人工确认" in parsed["fields"]["education"]["status"]

@pytest.mark.parametrize("reply", [[], ["one", "two"]])
def test_page_mismatch_safe(tmp_path, monkeypatch, reply):
    monkeypatch.setattr(parser, "recognize_pdf", lambda *a, **k: (reply, {"status":"调用成功"}))
    result = parser.extract_pdf(scan(tmp_path), allow_ocr=True)
    assert "页数" in result.warning

@pytest.mark.parametrize("payload", [{"errorCode":1,"errorMsg":"secret"}, {}, {"errorCode":0,"result":{"layoutParsingResults":[]}}])
def test_response_errors_safe(tmp_path, monkeypatch, payload):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size): return json.dumps(payload).encode()
    class Opener:
        def open(self, request, timeout):
            assert not request.has_header("Authorization")
            assert json.loads(request.data)["fileType"] == 0
            return Response()
    monkeypatch.setattr(ocr, "ocr_settings", lambda: {"enabled":True,"url":"http://example.test","allow_http":True})
    monkeypatch.setattr(ocr, "build_opener", lambda *a: Opener())
    with pytest.raises(ocr.OCRError) as exc:
        ocr.recognize_pdf(scan(tmp_path), consent=True)
    assert "secret" not in str(exc.value)

@pytest.mark.parametrize("fit_flow", [False, True])
def test_both_workflows_ocr(tmp_path, monkeypatch, fit_flow):
    from .fixture_data import init_db
    from matching_core.services import workflow as w
    db = tmp_path / "test.db"
    init_db(db)
    for name in ("ORIGINAL_DIR", "REDACTED_DIR", "STRUCTURED_DIR"):
        monkeypatch.setattr(w, name, tmp_path / name)
    monkeypatch.setattr(parser, "recognize_pdf", lambda *a, **k: (["候选人编号：OCR-001\n姓名：测试\n教育经历：本科\n工作经历：3年招聘"], {"status":"调用成功"}))
    path = scan(tmp_path)
    jobs = [j["id"] for j in w.get_jobs(db)]
    if fit_flow:
        task = w.create_fit_task(jobs, [path.name], "招聘人员", db)
        ids = w.process_fit_task(task, [path], "招聘人员", db_path=db, allow_ocr=True)
    else:
        task = w.create_task(jobs[0], [path.name], "招聘人员", db)
        ids = w.process_task(task, jobs[0], [path], "招聘人员", db_path=db, allow_ocr=True)
    candidates = w.get_sorted_candidates(task, db)
    assert len(candidates) == 1
    assert candidates[0]["parsed"]["ocr_analysis"]["status"] == "调用成功"
    assert not candidates[0]["decision"]
