from io import BytesIO
import fitz
from matching_core.services import upload_detection as detection
from matching_core.services.upload_detection import detect_uploaded_pdfs, preflight_uploaded_pdfs

def upload(name, text_pages):
    with fitz.open() as doc:
        for text in text_pages:
            page=doc.new_page()
            if text == "SCAN":
                page.draw_rect(fitz.Rect(40, 40, 100, 100), fill=(0, 0, 0))
            elif text: page.insert_text((40,40),text)
        data=doc.tobytes()
    file=BytesIO(data); file.name=name
    return file

def test_text_does_not_need_consent():
    assert detect_uploaded_pdfs([upload('text.pdf',['resume'])])==([],[])

def test_mixed_and_scan_minutes_detected():
    scans,errors=detect_uploaded_pdfs([upload('mixed.pdf',['resume','','SCAN']),upload('minutes.pdf',['SCAN'])])
    assert not errors
    assert scans==[
        {'文件':'mixed.pdf','需识别的页码':'3','总页数':3,'本地文字页数':1,'跳过空白页数':1},
        {'文件':'minutes.pdf','需识别的页码':'1','总页数':1,'本地文字页数':0,'跳过空白页数':0},
    ]

def test_corrupt_blocks():
    file=BytesIO(b'broken'); file.name='bad.pdf'
    scans,errors=detect_uploaded_pdfs([file])
    assert not scans and len(errors)==1

def test_long_pdf_has_no_whole_document_page_limit():
    source = upload('long.pdf', ['resume', ''] + ['SCAN'] * 11)
    ready, scans, errors = preflight_uploaded_pdfs([source])
    assert ready == [source] and not errors
    assert scans[0]['需识别的页码'] == '、'.join(str(n) for n in range(3, 14))
    assert scans[0]['总页数'] == 13


def test_blank_pages_and_white_images_stay_local():
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 40), 'resume')
        doc.new_page()
        white = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, 100, 100), False)
        white.clear_with(255)
        doc.new_page().insert_image(fitz.Rect(0, 0, 300, 300), stream=white.tobytes('png'))
        source = BytesIO(doc.tobytes())
        source.name = 'blank-separator.pdf'
    ready, scans, errors = preflight_uploaded_pdfs([source])
    assert ready == [source] and not scans and not errors


def test_one_bad_or_blank_file_does_not_remove_valid_uploads():
    valid = upload('same.pdf', ['resume'])
    invalid = BytesIO(b'broken'); invalid.name = 'same.pdf'
    ready, scans, errors = preflight_uploaded_pdfs([invalid, valid, upload('blank.pdf', [''])])
    assert ready == [valid] and not scans and len(errors) == 2
    assert '空白' in errors[1]


def test_capacity_is_local_50mb_limit_not_10mb(monkeypatch):
    source = upload('large.pdf', ['SCAN'])
    source = BytesIO(source.getvalue() + b'\0' * (11 * 1024 * 1024)); source.name = 'large.pdf'
    ready, scans, errors = preflight_uploaded_pdfs([source])
    assert ready == [source] and scans and not errors
    monkeypatch.setattr(detection, 'MAX_PDF_BYTES', 100)
    ready, scans, errors = preflight_uploaded_pdfs([source])
    assert not ready and not scans and '50MB' in errors[0]

def test_replacement_rechecks_no_saved_consent():
    assert detect_uploaded_pdfs([upload('same.pdf',['SCAN'])])[0]
    assert detect_uploaded_pdfs([upload('same.pdf',['text'])])==([],[])
