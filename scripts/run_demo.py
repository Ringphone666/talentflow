"""Run an isolated, loopback-only fictional demo. Never use for real hiring data."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'backend')]
DEMO_ROOT = ROOT / 'data' / 'synthetic-demo'

def main():
    os.environ.update({
        'TALENTFLOW_HR_ENV_FILE': str(DEMO_ROOT / 'no-env-file'),
        'TALENTFLOW_HR_DATA_DIR': str(DEMO_ROOT),
        'TALENTFLOW_HR_SECRETS_DIR': str(DEMO_ROOT / '.secrets'),
        'TALENTFLOW_RUNTIME_PROFILE': 'test',
        'TALENTFLOW_TEXT_MODE': 'mock',
        'TALENTFLOW_ASR_MODE': 'mock',
        'TALENTFLOW_OCR_MODE': 'disabled',
        'TALENTFLOW_SPEAKER_MODE': 'disabled',
        'TALENTFLOW_ADMIN_ENTRY_MODE': 'local',
        'MODEL_PROVIDER': 'local_rules',
        'TALENTFLOW_API_HOST': '127.0.0.1',
        'TALENTFLOW_API_PORT': '8000',
    })
    for key in ('TALENTFLOW_DATABASE_PATH', 'TALENTFLOW_DATA_DIR', 'TALENTFLOW_MATCHING_DATA_DIR',
                'TALENTFLOW_LLM_API_KEY', 'TALENTFLOW_MATCH_LLM_API_KEY', 'TALENTFLOW_MODEL_API_KEY',
                'DOUBAO_ASR_API_KEY', 'GPUSTACK_API_KEY'):
        os.environ.pop(key, None)
    print('TalentFlow synthetic demo: http://127.0.0.1:8000/ (fictional data only)')
    import uvicorn
    uvicorn.run('backend.app.main:app', host='127.0.0.1', port=8000)

if __name__ == '__main__':
    main()
