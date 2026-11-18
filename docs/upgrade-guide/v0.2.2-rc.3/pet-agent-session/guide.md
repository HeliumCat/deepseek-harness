---
kind: upgrade-guide
description: "Pet delegation uses agentSession and returns execution output for caller verification."
---

# Pet delegation returns results for caller verification

English | [中文](guide.zh.md)

## Change

`subagent_delegate` requires `agentSession` for the calling Agent’s conversation name. Pet snapshot, history, and delegation detail responses and local history files use the same field. Calls and history records that only have `codexSession` fail input validation or are omitted from the pet history, respectively.

Each call now starts one direct execution subagent. The lead subagent owns the existing worker Session, and the result contains execution status and output for the caller to verify. New history records omit the worker verdict. The `pet_acceptance` tool and `@deepseek-ai/dsh-pet-app/acceptance` entry point are removed.

Delegations without `subagentModel` now use DeepSeek-V4.1-Flash (`deepseek-official` / `deepseek-flash`) with `max` reasoning when the caller also omits `reasoningEffort`. The Pet profile supplies the model route for both immediate calls and scheduled tasks.

## Migration

1. Restart the pet worker after upgrading and reconnect your MCP client to refresh the tool definition. Use the same endpoint and token.
2. Update `subagent_delegate` calls and custom readers of the pet API or history files to use `agentSession`.
3. If `enabled_tools` is set, add `read_subagent_guide` to read the full guide. Submit one scoped assignment per call and verify its result independently.
4. For custom Pet patches, remove any `@deepseek-ai/dsh-pet-app/acceptance` row from the lead preset. Set `childPresetId` on the `pet-worker` row if the execution subagent needs a custom preset.
5. Send a delegation and confirm it appears under the supplied conversation name in Pet history. Use a new conversation name to start a fresh lead subagent Session.
6. To keep using another model by default, set `defaultSubagentModel` with its `provider` and `model` on the `pet-worker` row. Individual calls can supply `subagentModel` and `reasoningEffort`.
