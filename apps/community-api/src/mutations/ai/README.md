# AI 变更草稿边界

复用当前已锁定的 AI SDK / OpenAI compatible provider，SDK 负责 JSON 输出解析，项目继续负责输入、权限、发送范围与候选校验，不增加另一套模型客户端或网络库。复用 `ai/public.ts` 的 ModelPlanner 授权结构、持久本机发送租约、工作区/模型配置观察器、发送截止以及 model-network 的地址检查、DNS 固定、大小上限和单次请求；SDK 禁止自动重试。现有库许可证与版本沿用第五阶段评估，不增加依赖。

先准备，再显式确认发送：准确显示问题（可能包含待写值）、模型地址和型号、写权限与非敏感模型结构交集、对应非敏感语义和操作范围。发送票据只保留在本进程内存、最长 45 秒，绑定原签名结构任务、作用域、API/Connector boot、模型版本与写策略/安装/目标世代；一次票据最多发一次，撤销/过期/变化则拒绝。模型永远收不到预览行、查询结果、账号密码、API 密钥正文或内部核验列。

候选只能是严格 MutationPlan 或澄清问题。名称和操作必须属于确认过的交集；模型不能执行、确认或扩权。生成后仍要用户选择载入草稿，再做完整 Connector 预览和独立人工确认。需求、值和回复不写入对话历史、保存查询或平台表。

变更 profile/policy 的本机管理命令必须尊重已有 datasource model disclosure lease：Connector 进程退出并不让正在发送的权限保护失效。API 写权限响应二次核对不能代替这个本机持久保护。

官方依据：[AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)、[OpenAI compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers)、[SDK 维护仓库](https://github.com/vercel/ai)。本轮核对官方 v7 文档，实际网络限制复用已验证代码，不将系统提示词当授权。
