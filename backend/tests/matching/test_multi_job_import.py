import json
from functools import partial
from io import BytesIO

import pytest
from .fixture_data import init_db
from matching_core.services import job_extraction as ai, workflow


def test_document_roles_are_extracted_in_separate_contexts(tmp_path, monkeypatch):
    path = tmp_path / 'multi.txt'
    path.write_text('销售专员\n负责客户开发\n财务专员\n负责账务核对', encoding='utf-8')
    monkeypatch.setattr(ai, 'model_settings', lambda: dict(provider='external', confirmed=True, key='test-secret', url='https://example.invalid', http_allowed=False))
    def analyze(self, text, job):
        if self.task == 'job_hard_conditions':
            return {'hard_conditions': []}
        if self.task == 'job_detection':
            return {'jobs': [{'name': '销售专员', 'start': 0, 'end': 1}, {'name': '财务专员', 'start': 2, 'end': 3}]}
        assert ('销售专员' in text) != ('财务专员' in text)
        name, duty = [item['text'] for item in json.loads(text)]
        return dict(metadata=dict(name=name, sequence='', level='', jd_version=''), responsibilities=[duty], requirements=[], hard_conditions=[], dimensions=[])
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', analyze)
    results = ai.extract_jobs_with_ai(path)
    assert [r['parsed']['metadata']['name'] for r in results] == ['销售专员', '财务专员']
    assert all(not r['error'] for r in results)


def test_explicit_title_rows_cover_all_roles_without_model_boundary_guessing(tmp_path, monkeypatch):
    path = tmp_path / 'tables.txt'
    path.write_text('\n'.join(f'岗位名称 | 岗位{i}\n负责事项{i}\n要求{i}' for i in range(8)), encoding='utf-8')
    monkeypatch.setattr(ai, 'model_settings', lambda: dict(provider='external', confirmed=True, key='test-secret', url='https://example.invalid', http_allowed=False))
    def analyze(self, text, job):
        if self.task == 'job_hard_conditions':
            return {'hard_conditions': []}
        assert self.task == 'job_evidence'
        lines = json.loads(text)
        assert len(lines) == 3
        return dict(metadata=dict(name=lines[0]['text'].split('|')[1].strip(), sequence='', level='', jd_version=''),
                    responsibilities=[1], requirements=[2], hard_conditions=[], dimensions=[])
    monkeypatch.setattr(ai.ExternalModelAdapter, 'analyze', analyze)
    results = ai.extract_jobs_with_ai(path)
    assert len(results) == 8
    for i, result in enumerate(results):
        assert result['parsed']['metadata']['name'] == f'岗位{i}'
        assert result['parsed']['responsibilities'] == [f'负责事项{i}']
        assert result['parsed']['requirements'] == [f'要求{i}']


