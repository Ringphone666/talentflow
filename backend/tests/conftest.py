"""测试使用隔离的数据目录和模拟模型，不读写业务数据，也不调用外部服务。"""
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
# Binary documents are disposable and recreated from synthetic text for each checkout.
import runpy
runpy.run_path(str(BACKEND_DIR.parent / "scripts/build_test_fixtures.py"))["build"]()
# 每次运行使用各自的临时目录，多个测试进程同时运行时互不影响；结束后清理。
TEST_DATA_ROOT = Path(__file__).resolve().parent / "test-data"
TEST_DATA_ROOT.mkdir(exist_ok=True)
TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="run-", dir=TEST_DATA_ROOT))


def _remove_test_data():
    # 面试库的连接还开着时，Windows 不允许删除库文件；先释放连接，本次运行的目录才能清理干净。
    database = sys.modules.get("backend.app.core.database")
    if database is not None:
        database.engine.dispose()
    shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)


atexit.register(_remove_test_data)
os.environ["TALENTFLOW_HR_ENV_FILE"] = str(TEST_DATA_DIR / "no-env-file")
os.environ["TALENTFLOW_HR_DATA_DIR"] = str(TEST_DATA_DIR)
os.environ["TALENTFLOW_HR_SECRETS_DIR"] = str(TEST_DATA_DIR / ".secrets")
os.environ["TALENTFLOW_DATA_DIR"] = str(TEST_DATA_DIR / "interview")
os.environ["TALENTFLOW_MATCHING_DATA_DIR"] = str(TEST_DATA_DIR / "matching")
os.environ.pop("TALENTFLOW_DATABASE_PATH", None)
os.environ["TALENTFLOW_RUNTIME_PROFILE"] = "test"
os.environ["TALENTFLOW_TEXT_MODE"] = "mock"
os.environ["TALENTFLOW_ASR_MODE"] = "mock"
os.environ["MODEL_PROVIDER"] = "local_rules"
# 接口测试不依赖前端是否已构建。
os.environ["TALENTFLOW_SERVE_WEB"] = "0"
# 说话人分离服务默认会探测本机 9200/9201 端口；测试中关闭，既不访问本机服务，也不因等待超时拖慢接口。
os.environ["TALENTFLOW_SPEAKER_MODE"] = "disabled"
# 文字识别服务的开关在模块第一次被导入时确定。个别用例会临时把文本模型设为真实方式，
# 如果模块恰好在那时第一次被导入，后面的用例就会真的访问文字识别服务；这里明确关闭，与用例的先后顺序无关。
os.environ["TALENTFLOW_OCR_MODE"] = "disabled"
for name in ("TALENTFLOW_LLM_API_KEY", "TALENTFLOW_MATCH_LLM_API_KEY", "TALENTFLOW_MODEL_API_KEY", "DOUBAO_ASR_API_KEY"):
    os.environ.pop(name, None)

# matching_core 是与 app 并列的顶层包。
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client():
    from backend.app.main import app
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def headers():
    def make(role="system_admin", user="admin"):
        return {"X-User-Role": role, "X-User-Name": user}
    return make


@pytest.fixture()
def created(client):
    """登记测试中建立的批次、候选人、岗位、人员和匹配任务，测试结束后清理，避免影响其他测试。"""
    from .support import Created
    registry = Created(client)
    yield registry
    registry.cleanup()
