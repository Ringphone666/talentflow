from backend.app.interview import forced_aligner as aligner


def test_confirmed_model_mapping_and_pooling_payload():
    payload = aligner.build_payload(b'RIFFtest', '你好')
    assert aligner.MODEL == 'qwen3-forcedaligner-small'
    assert aligner.ROUTE_ID == 'configure-route'
    assert payload['model'] == 'qwen3-forcedaligner-small'
    assert payload['task'] == 'token_classify'
    assert payload['messages'][0]['content'][0]['text'].count('<timestamp>') == 4
    assert payload['messages'][0]['content'][1]['audio_url']['url'].startswith('data:audio/wav;base64,')


def test_aligner_is_safe_off_without_key(monkeypatch, tmp_path):
    monkeypatch.delenv('TALENTFLOW_ALIGNER_MODE', raising=False)
    monkeypatch.setattr(aligner, 'KEY_FILE', tmp_path / 'missing-key')
    assert aligner.enabled() is False
