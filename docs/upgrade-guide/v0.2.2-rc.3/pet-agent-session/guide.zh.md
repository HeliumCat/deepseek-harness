---
kind: upgrade-guide
description: "桌宠派发调用、桌宠 API 响应和本地历史使用 agentSession 取代 codexSession。"
---

# 桌宠派发使用 `agentSession`

[English](guide.md) | 中文

## 变更

`subagent_delegate` 要求通过 `agentSession` 传入调用 Agent 的会话名。桌宠的快照、历史与派发详情响应以及本地历史文件都使用该字段。只传 `codexSession` 的调用会被拒绝，只有该字段的记录不会出现在桌宠历史中。

## 迁移

1. 升级后重启桌宠 worker，让 MCP 客户端重新连接并刷新工具定义。继续使用原端点和 token。
2. 更新 `subagent_delegate` 调用以及自行读取桌宠 API 或历史文件的程序，改用 `agentSession`。
3. 派发一个任务，确认记录出现在桌宠历史中对应的会话名下。如需创建全新的 worker Session，使用新的会话名。
