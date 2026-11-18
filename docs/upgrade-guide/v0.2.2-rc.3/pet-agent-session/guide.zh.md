---
kind: upgrade-guide
description: "桌宠派发使用 agentSession，并将执行输出交给调用方验收。"
---

# 桌宠派发结果由调用方验收

[English](guide.md) | 中文

## 变更

`subagent_delegate` 要求通过 `agentSession` 传入调用 Agent 的会话名。桌宠的快照、历史与派发详情响应以及本地历史文件都使用该字段。只传 `codexSession` 的调用会被拒绝，只有该字段的记录不会出现在桌宠历史中。

每次调用创建一个直属执行子代理。Lead subagent 持有原先的 worker Session，返回运行状态和执行输出供调用方验收。新的历史记录不再写入 worker 验收结论。`pet_acceptance` 工具和 `@deepseek-ai/dsh-pet-app/acceptance` 入口已移除。

派发省略 `subagentModel` 时使用 DeepSeek-V4.1-Flash（`deepseek-official` / `deepseek-flash`），同时省略 `reasoningEffort` 时使用 `max` 推理强度。模型路由由 Pet profile 决定。立即派发和定时任务都遵循这个默认值。

## 迁移

1. 升级后重启桌宠 worker，让 MCP 客户端重新连接并刷新工具定义。继续使用原端点和 token。
2. 更新 `subagent_delegate` 调用以及自行读取桌宠 API 或历史文件的程序，改用 `agentSession`。
3. 如果配置了 `enabled_tools`，加入 `read_subagent_guide` 以便读取规范全文。每次提交一个边界明确的任务，并独立验收结果。
4. 对于 Pet 自定义 patch，从 lead subagent 的预设移除 `@deepseek-ai/dsh-pet-app/acceptance` 行。如果执行子代理需要自定义预设，在 `pet-worker` 行设置 `childPresetId`。
5. 派发一个任务，确认记录出现在 Pet 历史中对应的会话名下。使用新会话名可以创建新的 lead subagent Session。
6. 如果要继续默认使用其他模型，在 `pet-worker` 行的 `defaultSubagentModel` 中设置对应的 `provider` 和 `model`。单次调用可以传入 `subagentModel` 和 `reasoningEffort`。
