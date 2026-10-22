"""启动平台后端。

    .venv/Scripts/python.exe scripts/serve_api.py [端口]

监听地址和端口也可用 TALENTFLOW_API_HOST、TALENTFLOW_API_PORT 指定（环境变量或 .env，默认 127.0.0.1:8000）；命令行给出的端口优先。
匹配任务队列和后台处理保存在进程内，只能以单进程运行，不要加 --workers。
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# backend.app 从平台根目录导入；matching_core 是 backend 目录下的顶层包。
sys.path[:0] = [str(ROOT), str(ROOT / "backend")]
os.chdir(ROOT)


def main() -> None:
    import uvicorn

    # 导入配置模块时读取 .env，之后才能取到其中的监听地址和端口。
    from backend.app.core import settings  # noqa: F401

    if len(sys.argv) > 1:
        # 页面与接口同源时，服务要知道自己的端口，才能接受来自本服务页面的语音连接。
        os.environ["TALENTFLOW_API_PORT"] = sys.argv[1]
    host = os.getenv("TALENTFLOW_API_HOST", "127.0.0.1")
    port = int(os.getenv("TALENTFLOW_API_PORT", "8000"))
    uvicorn.run("backend.app.main:app", host=host, port=port)


if __name__ == "__main__":
    main()
