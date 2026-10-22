# 运行与配置

## 模式

- 正常模式：`TALENTFLOW_RUNTIME_PROFILE=production`，启动空业务库。测试用固定用户与报告不进入正常模式。
- 本地演示：运行 `scripts/run_demo.py`，使用独立目录、虚构候选人与模拟文本模型，只监听 `127.0.0.1`。
- 测试：pytest 在独立临时目录运行，不读取用户的 `.env`；二进制测试文档从可审查的虚构文本重建。

## 模型网关

`TALENTFLOW_MODEL_BASE_URL` 与 `TALENTFLOW_LLM_API_KEY` 是共享配置。匹配模块可用 `TALENTFLOW_MATCH_LLM_BASE_URL` / `TALENTFLOW_MATCH_LLM_API_KEY` 覆盖。

默认逻辑路由为 `chat-primary`、`chat-evaluation`、`chat-reasoner`、`embedding-primary`、`rerank-primary`，需要自己的网关将它们映射到兼容模型。它们只是公开版示例别名，不代表已附带模型权重。面试与匹配子模块的协议、Schema 与别名使用有差异；接入时分别验证文本生成、评估、向量和重排端点。

匹配模块要求 `MODEL_PROVIDER=external` 和 `TALENTFLOW_MATCH_KEY_ROTATED_CONFIRMED=true` 才采用外部分析。默认示例使用 `local_rules`，用于材料维护，不将规则结果伪装成真实模型评分。

## 可选服务

豆包语音识别使用 `DOUBAO_ASR_API_KEY`。OCR、强制对齐与说话人服务的地址见 `.env.example`。`example.invalid` 是故意不可用的示例域名；必须替换成自己可访问的服务。密钥仅从环境变量读取；公开版不提供旧部署密钥迁移脚本。

## 访问

本机管理入口不是面向公网的登录方案。多用户接入需配置 `TALENTFLOW_ADMIN_ENTRY_MODE=host`、`TALENTFLOW_HOST_ENTRY_SECRET`，由可信主系统后端创建会话；按实际来源限制 `TALENTFLOW_WEB_ORIGINS`。远程采集麦克风需要 HTTPS。

后端只能运行一个 worker。SQLite 与磁盘资料应纳入你自己的备份策略。数据目录、密钥目录、录音、业务附件和模型响应不属于代码发布内容。

## 已知限制

部分后台任务状态仅在内存中；重启后需重新发起。说话人身份默认根据语境推断，可能误判，须人工核对。默认 ASR 依赖外部服务；离线测试不验证麦克风、网络波动或真实服务性能。前端未按路由拆包。
