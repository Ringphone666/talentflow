"""外部系统对接的预留入口。

为岗位库和人员库提供可选的外部系统适配入口。当前未实现远程取数，
仅返回通用的配置状态；接入方需自行实现数据协议与鉴权。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..core.deps import actor_context, require_any

router = APIRouter(prefix="/api/library", tags=["外部系统对接"])

ENTRIES = {
    "recruitment_jobs": {
        "name": "从人资招聘系统导入岗位", "target": "岗位库", "system": "人力资源招聘系统",
        "pending": "人资招聘系统的岗位数据接口（地址、字段、鉴权方式）尚未提供",
        "alternative": "目前可上传岗位说明书（PDF、Word、TXT）由系统识别，或手工新增岗位",
    },
    "organization_persons": {
        "name": "从组织架构选择人员", "target": "人员库", "system": "组织架构 / 人员主数据",
        "pending": "组织人员数据适配器未配置，需实现数据协议与鉴权后启用",
        "alternative": "目前可按批次上传简历导入人员",
    },
}


def entry_view(key: str) -> dict:
    return {"key": key, **ENTRIES[key], "status": "pending_interface", "status_label": "待对接", "available": False}


@router.get("/integrations")
def list_integrations(ctx=Depends(actor_context)):
    require_any(ctx, "job:read", "person:read")
    return [entry_view(key) for key in ENTRIES]


@router.post("/integrations/{key}/import")
def import_from_external(key: str, ctx=Depends(actor_context)):
    require_any(ctx, "job:edit", "person:edit")
    if key not in ENTRIES:
        raise HTTPException(404, "没有这个对接入口")
    entry = ENTRIES[key]
    raise HTTPException(501, f"{entry['name']}尚未对接：{entry['pending']}。{entry['alternative']}。")
