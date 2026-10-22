# 验证记录

验证日期：2026-10-21。对象为本仓库的去标识化作品集版本，使用本地隔离数据目录、模拟模型与合成测试文档。

| 检查 | 结果 | 说明 |
|---|---|---|
| 后端完整回归 | 617 passed | pytest；6条依赖弃用警告；32.36秒 |
| 最终清理后的相关后端回归 | 30 passed | 文本模型与报告生成；1.77秒 |
| TypeScript检查与前端生产构建 | 通过 | `tsc -b`、Vite；主JS包约2.39MB（gzip约743KB），存在分包优化空间 |
| 前端页面回归 | 320 passed / 26 files | Vitest；846.73秒 |
| 本机演示 | 通过 | 启动隔离演示，检查候选人、报告列表与引用报告；预览截图来自实际页面 |
| 测试PDF抽样渲染 | 通过 | 从合成文本重新生成，抽样检查一页无截断 |
| 发布文件检查 | 通过 | 发布脚本检查常见凭据格式、非示例IP及不应提交的数据类型；私有规则另查源客户标识 |

前端测试日志包含jsdom样式模拟、React Router未来配置和Ant Design兼容性提示；这些提示未导致测试失败。构建存在大包告警，尚未做路由分包优化。

## 验证范围

后端测试覆盖权限与会话、材料库、解析与证据校验、人岗匹配、面试、旁听、报告和导出等路径。前端测试通过请求模拟验证页面行为；演示不连接真实模型、真实ASR、外部HR系统或客户环境。

尚未执行生产压测、渗透测试、外部模型端到端效果评测、ASR真实音频准确率评测或招聘结果有效性评估。回归通过不等于已验证生产容量、准确率、公平性或服务等级。

## 复现

```bash
python -m pip install -r backend/requirements.txt
python -m pytest backend/tests -o addopts='' -q
cd frontend
npm ci
npm test
npm run build
cd ..
python scripts/check_release.py
```

合成PDF与DOCX由测试启动脚本按需生成，不作为原始附件提交。CI定义见 `.github/workflows/ci.yml`；本表记录本地结果，未把尚未运行的GitHub Actions标记为成功。
