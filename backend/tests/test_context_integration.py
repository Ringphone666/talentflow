import io
import json
import zipfile
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from backend.app.interview import retrieval_models, standards, text_models
from backend.app.interview.interview_context import library_resume, resume_context, speaker_context


def test_resume_is_candidate_specific_and_failed_ocr_is_not_used():
    person = SimpleNamespace(name='测试甲', resume_ocr_status='completed', resume_ocr_text='测试甲\n邮箱：a@test.com\n电话：13812345678\n性别：男\n负责质量改进项目', resume_uploaded_at=None)
    context = resume_context(person)
    assert '负责质量改进项目' in context['text']
    assert all(value not in context['text'] for value in ['测试甲', 'a@test.com', '13812345678', '性别'])
    person.resume_ocr_status = 'failed'
    assert resume_context(person)['text'] == ''
    assert resume_context(SimpleNamespace())['text'] == ''


def test_unlinked_or_unknown_person_has_no_library_resume(client):
    # 未关联人员库，或人员库中已没有该人员时，不返回任何简历内容。
    assert library_resume(None) is None
    assert library_resume('') is None
    assert library_resume('TLE-NOT-EXISTING') is None
    person = SimpleNamespace(name='测试甲', library_person_id='TLE-NOT-EXISTING', resume_ocr_status='completed',
                             resume_ocr_text='负责质量改进项目', resume_uploaded_at=None)
    context = resume_context(person)
    assert context['source'] == '面试候选人简历' and '负责质量改进项目' in context['text']


def test_library_resume_replaces_candidate_upload_and_hides_identifiers(client, monkeypatch):
    from matching_core.services import talent_library
    entry = {'status': '已解析', 'material_version': 0, 'created_at': '2026-01-01T00:00:00+08:00',
             'source_filename': '人员库简历.txt', 'redacted_path': '', 'parsed': {}}
    monkeypatch.setattr(talent_library, 'get_entry', lambda person_id: dict(entry))
    assert library_resume('TLE-1') == {'status': 'completed', 'text': '', 'uploaded_at': entry['created_at'],
                                       'source': '人员库简历.txt', 'size': 0}
    entry.update(material_version=2, parsed={'fields': {}, 'raw_evidence': [
        {'text': '姓名：测试乙\n邮箱：b@test.com\n负责招聘计划编制', 'file': '人员库简历.txt', 'location': '第1行'}]})
    person = SimpleNamespace(name='测试乙', library_person_id='TLE-1', resume_ocr_status='completed',
                             resume_ocr_text='候选人自己上传的旧简历', resume_uploaded_at=None)
    context = resume_context(person)
    assert context['status'] == 'ready' and context['source'] == '人员库'
    assert '负责招聘计划编制' in context['text'] and '旧简历' not in context['text']
    assert all(value not in context['text'] for value in ['测试乙', 'b@test.com'])
    for status, expected in [('待解析', 'processing'), ('解析失败', 'failed')]:
        entry['status'] = status
        assert library_resume('TLE-1')['status'] == expected
        assert resume_context(person)['text'] == ''


def test_followup_receives_resume_and_rejects_fabrication(monkeypatch):
    monkeypatch.setattr(text_models, 'enabled', lambda: True)
    seen = []
    def reply(model, task, data, schema):
        seen.append(data)
        return text_models.Followup(content='质量项目中你承担什么职责？', basis='我检查记录', resume_excerpt='负责质量改进')
    monkeypatch.setattr(text_models, 'request_json', reply)
    result = text_models.generate_followup(1, '我检查记录', {'text': '负责质量改进', 'status': 'ready'})
    assert seen[0]['resume']['text'] == result['resume_excerpt']
    with pytest.raises(HTTPException):
        text_models.generate_followup(1, '我检查记录', {'text': '无相关项目'})


def test_report_checks_quote_both_resume_and_answer_without_scoring_resume(monkeypatch):
    monkeypatch.setattr(text_models, 'enabled', lambda: True)
    monkeypatch.setattr(text_models, 'status', lambda: {})
    monkeypatch.setattr(retrieval_models, 'embed', lambda docs: {})
    monkeypatch.setattr(retrieval_models, 'rerank', lambda *args: {})
    calls = []
    def reply(model, task, data, schema, **kwargs):
        calls.append(data)
        if schema is text_models.Evaluations:
            assert 'resume' not in data
            return schema(evaluations=[text_models.Evaluation(dimension=d[0], score=3, reason='依据回答', answer_ids=['A1'], evidence_excerpt='我核对了记录', insufficient=False) for d in standards.DIMENSIONS])
        return schema(summary='纪要', matched=[], to_verify=[], risks=[], offline_questions=[], resume_checks=[{'resume_excerpt': '负责质量改进', 'answer_code': 'A1', 'answer_excerpt': '我核对了记录', 'finding': '需核实本人职责', 'status': '存在差异待核实'}])
    monkeypatch.setattr(text_models, 'request_json', reply)
    args = ('测试候选人', [{'answer_code': 'A1', 'transcript': '我核对了记录'}])
    report = text_models.build_report(*args, resume={'status': 'ready', 'text': '负责质量改进'})
    assert report['resume_checks'][0]['answer_code'] == 'A1'
    assert calls[1]['resume']['text'] == '负责质量改进'
    with pytest.raises(HTTPException):
        text_models.build_report(*args, resume={'text': '其他经历'})


def test_speaker_time_join_never_equates_cluster_with_identity():
    capture = SimpleNamespace(speaker_status='completed', speaker_result=json.dumps({'turns': [{'cluster_id': 'A', 'start_ms': 0, 'end_ms': 1000}, {'cluster_id': 'B', 'start_ms': 800, 'end_ms': 1800}]}), provider_result=json.dumps({'result': {'utterances': [{'text': '我核对记录', 'start_time': 500, 'end_time': 1500}, {'text': '编造文本', 'start_time': 0, 'end_time': 100}]}}), transcript='我核对记录')
    data = speaker_context(capture)
    assert len(data['segments']) == 1
    assert data['segments'][0]['clusters'] == ['A', 'B']
    assert data['segments'][0]['ambiguous'] and data['segments'][0]['role'] == '待人工核对'
    capture.provider_result = '{}'
    assert speaker_context(capture)['segments'] == []


def test_report_retries_bad_quote_once_and_uses_corrected_evidence(monkeypatch):
    monkeypatch.setattr(text_models, 'enabled', lambda: True)
    monkeypatch.setattr(text_models, 'status', lambda: {})
    monkeypatch.setattr(retrieval_models, 'embed', lambda docs: {})
    monkeypatch.setattr(retrieval_models, 'rerank', lambda *args: {})
    attempts = []
    def reply(model, task, data, schema, **kwargs):
        if schema is text_models.Evaluations:
            return schema(evaluations=[text_models.Evaluation(dimension=d[0], score=None, reason='证据不足', answer_ids=[], evidence_excerpt='', insufficient=True) for d in standards.DIMENSIONS])
        attempts.append(data)
        return schema(summary='待核实', matched=[], to_verify=[], risks=[], offline_questions=[], resume_checks=[{'resume_excerpt': '不存在的改写' if len(attempts) == 1 else '负责质量改进', 'finding': '请进一步说明本人职责', 'status': '尚未覆盖'}])
    monkeypatch.setattr(text_models, 'request_json', reply)
    report = text_models.build_report('虚构候选人', [], resume={'text': '负责质量改进'})
    assert len(attempts) == 2 and 'validation_error' in attempts[1]
    assert report['resume_checks'][0]['resume_excerpt'] == '负责质量改进'


def test_export_contains_resume_evidence():
    from backend.app.interview.docx_export import report_docx
    data = report_docx('测试报告', {'resume_context': {'status': 'ready'}, 'resume_checks': [{'resume_excerpt': '负责质量改进', 'answer_excerpt': '我核对记录', 'status': '回答支持', 'finding': '待人工复核'}]})
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        text = archive.read('word/document.xml').decode()
    assert '负责质量改进' in text and '我核对记录' in text
