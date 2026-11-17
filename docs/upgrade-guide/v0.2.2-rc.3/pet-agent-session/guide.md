---
kind: upgrade-guide
description: "Pet delegation calls, desktop API responses, and local history use agentSession in place of codexSession."
---

# Pet delegation uses `agentSession`

English | [中文](guide.zh.md)

## Change

`subagent_delegate` requires `agentSession` for the calling Agent’s conversation name. Pet snapshot, history, and delegation detail responses and local history files use the same field. Calls and history records that only have `codexSession` fail input validation or are omitted from the pet history, respectively.

## Migration

1. Restart the pet worker after upgrading and reconnect your MCP client to refresh the tool definition. Use the same endpoint and token.
2. Update `subagent_delegate` calls and custom readers of the pet API or history files to use `agentSession`.
3. Send a delegation and confirm it appears under the supplied conversation name in pet history. Use a new conversation name to start a fresh worker Session.
