import json
import fitz
import pytest
from matching_core.services import paddle_ocr as p
from matching_core.services import ocr

def pdf(tmp_path, pages=1):
    path=tmp_path/"scan.pdf"
    with fitz.open() as doc:
        for _ in range(pages): doc.new_page()
        doc.save(path)
    return path

def config():
    return {"provider":"external","key":"fictional-test-key","confirmed":True,"url":"https://example.test/v1","http_allowed":False}

def mock_response(monkeypatch, payload):
    calls=[]
    class Response:
        def __enter__(self): return self
        def __exit__(self,*a): pass
        def read(self,n): return json.dumps(payload).encode()
    class Opener:
        def open(self,req,timeout):
            calls.append(json.loads(req.data))
            assert req.full_url=="https://example.test/v1/chat/completions"
            assert 0<timeout<=300
            return Response()
    monkeypatch.setattr(p,"build_opener",lambda *a:Opener())
    return calls

def result(model="chat-ocr", finish="stop", text="教育经历：本科"):
    return {"model":model,"choices":[{"finish_reason":finish,"message":{"content":text}}]}

def test_explicit_model_and_order(tmp_path,monkeypatch):
    calls=mock_response(monkeypatch,result())
    texts,state=p.recognize_paddle_pdf(pdf(tmp_path,2),config())
    assert len(texts)==2 and state["model"]=="chat-ocr"
    assert all(x["model"]=="chat-ocr" for x in calls)
    assert all(x["messages"][0]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,") for x in calls)


def test_long_pdf_uses_all_requested_original_pages(tmp_path, monkeypatch):
    calls = mock_response(monkeypatch, result())
    texts, state = p.recognize_paddle_pdf(pdf(tmp_path, 13), config(), page_numbers=[2, 7, 13])
    assert len(texts) == len(calls) == 3
    assert state['page_numbers'] == [2, 7, 13]


def test_long_pdf_not_cut_off_by_whole_file_timeout(tmp_path, monkeypatch):
    calls = mock_response(monkeypatch, result())
    # Simulate a completed long OCR run. Only per-page network time is bounded.
    moments = iter([0, 900])
    monkeypatch.setattr(p.time, 'monotonic', lambda: next(moments))
    texts, state = p.recognize_paddle_pdf(pdf(tmp_path, 12), config())
    assert len(texts) == len(calls) == 12
    assert state['elapsed_seconds'] == 900


@pytest.mark.parametrize('pages', [[], [0], [2], [1, 1], [True]])
def test_invalid_selected_pages_never_call_network(tmp_path, monkeypatch, pages):
    monkeypatch.setattr(p, 'build_opener', lambda *a: pytest.fail('Invalid selection sent'))
    with pytest.raises(ocr.OCRError, match='页码'):
        p.recognize_paddle_pdf(pdf(tmp_path), config(), page_numbers=pages)

@pytest.mark.parametrize("payload",[result(model="doc-ocr"),result(finish="length"),result(text=""),{}])
def test_invalid_output_not_adopted(tmp_path,monkeypatch,payload):
    mock_response(monkeypatch,payload)
    with pytest.raises(ocr.OCRError): p.recognize_paddle_pdf(pdf(tmp_path),config())

def test_consent_blocks_paddle(tmp_path,monkeypatch):
    monkeypatch.setattr(p,"recognize_paddle_pdf",lambda *a:pytest.fail("must not send"))
    with pytest.raises(ocr.OCRError,match="未授权"): ocr.recognize_pdf(pdf(tmp_path))

def test_local_mode_blocks_key_use(tmp_path):
    cfg=config(); cfg["provider"]="local_rules"
    with pytest.raises(ocr.OCRError,match="外部服务"): p.recognize_paddle_pdf(pdf(tmp_path),cfg)

def test_unknown_provider_rejected(tmp_path,monkeypatch):
    monkeypatch.setattr(ocr,"ocr_settings",lambda:{"enabled":True,"provider":"unknown"})
    with pytest.raises(ocr.OCRError,match="不支持"): ocr.recognize_pdf(pdf(tmp_path),consent=True)
