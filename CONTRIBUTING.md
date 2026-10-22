# 开发与贡献

## 本地环境

使用 Python 3.12、Node.js 22 与 npm。依赖安装和演示启动步骤见 [README](README.md#快速开始)。后端启动前先构建前端；修改前端时可运行 `npm run dev` 使用开发服务器。

## 代码组织

- HTTP、WebSocket 路由和权限检查放在 `backend/app/` 对应业务模块。
- 材料解析、人岗匹配、证据与评分逻辑放在 `backend/matching_core/services/`。
- 页面位于 `frontend/src/pages/`，跨页面共享组件位于 `frontend/src/components/`。
- 模型调用通过适配层接入；结构化输出需验证 Schema 与引用来源。

业务修改应保留人工复核、材料版本和权限检查。新增外部服务时同时更新 `.env.example` 与 `docs/operations.md`，默认配置应能在没有真实凭据时给出明确状态。

## 提交前检查

```bash
python -m pytest backend/tests -o addopts='' -q
cd frontend
npm test
npm run build
cd ..
python scripts/check_release.py
```

针对行为变更补充或调整对应回归。文档修改检查链接、命令和截图是否与当前实现一致。提交说明先描述解决的问题，再说明行为变化与验证方式。

## 测试资料

使用合成候选人、示例岗位和模拟服务。测试用 PDF / DOCX 由 `scripts/build_test_fixtures.py` 在测试初始化时生成，不提交生成文件。

不要提交 `.env`、密钥、业务数据库、录音、真实候选材料或客户附件。涉及缺陷复现时，以最小合成样例替代原始业务资料。
