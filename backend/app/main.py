"""TalentFlow人力资源智能体平台后端。

一个系统、两个业务模块：人岗匹配与AI面试各自独立成流程，共用岗位库、人员库、权限和审计。
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from matching_core.db import init_db as init_matching_db
from matching_core.services import task_queue

from .core.deps import actor_context, require
from .core.settings import PLATFORM_ROOT, allowed_web_origins
from .interview import seed
from .interview.routers import batches, candidates, jobs as interview_jobs, listening, onsite, questions, reports, sessions
from .interview.routers import settings as compliance
from .interview.speech_routes import install as install_speech_routes
from .library import integrations, jobs as library_jobs, persons
from .matching import router as matching
from .system import audits, auth, overview


@asynccontextmanager
async def lifespan(_app: FastAPI):
    seed.initialize()
    init_matching_db()
    # 上次停止服务时还没分析完的匹配任务继续处理。
    task_queue.recover_pending_tasks()
    yield


app = FastAPI(title="TalentFlow人力资源智能体平台 API", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_web_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # 下载文件的中文名称放在自定义响应头里，浏览器脚本需要显式允许才能读取。
    expose_headers=["Content-Disposition", "X-Download-Name"],
)

for module in (auth, overview, audits, library_jobs, persons, integrations, matching, interview_jobs, batches,
               questions, candidates, onsite, sessions, reports, listening, compliance):
    app.include_router(module.router)
install_speech_routes(app, actor_context, require)

WEB_DIST = PLATFORM_ROOT / "frontend" / "dist"


def install_web(target: FastAPI) -> None:
    """前端已构建时由后端一并提供页面，单机部署只需启动这一个服务。开发时前端由 Vite 单独提供。"""
    if os.getenv("TALENTFLOW_SERVE_WEB", "1") == "0" or not (WEB_DIST / "index.html").is_file():
        return
    root = WEB_DIST.resolve()
    if (root / "assets").is_dir():
        target.mount("/assets", StaticFiles(directory=root / "assets"), name="web-assets")

    @target.get("/{path:path}", include_in_schema=False)
    def web(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "接口不存在")
        file = (root / path).resolve()
        if path and file.is_file() and file.is_relative_to(root):
            return FileResponse(file)
        # 页面路径（如 /library/jobs）由前端路由处理。
        return FileResponse(root / "index.html")


install_web(app)
