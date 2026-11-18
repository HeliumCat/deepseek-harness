---
description: "Desktop pet worker profile: a resident DSH worker that serves a localhost MCP delegation endpoint and a transparent pet window over the dsh-web-app surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-pet-app

English | [中文](README.zh.md)

## Summary

`dsh-pet-app` composes the `pet` profile, a resident DSH worker with a transparent desktop pet and a local Streamable HTTP MCP endpoint. Agents call `subagent_delegate` to run one or more DSH subagents and receive the result. The pet shows an icon for each running subagent and groups delegation history by the caller’s conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Start the worker

`dsh --profile pet` creates the shipped `pet` profile on first use and starts the worker. The profile stacks `dsh-base`, `dsh-web-app`, and this bundle. The worker prints the pet page URL, the MCP endpoint, and an example Codex configuration entry.

The pet opens in an Electron window when this installation can resolve an Electron executable: an explicit `electronPath`/`DSH_PET_ELECTRON`, an `electron` dependency in the installation, or the checkout's Desktop application beside this package. Without one, the worker opens the same page in the default browser. The pet window is frameless, transparent, always on top, and skipped from the taskbar; drag the pet to move it and right-click it for the history and quit actions. Set `windowMode: none` to run the worker without a viewer.

The worker stays resident. To keep the client URL stable across restarts, set a fixed port with `--port` or patch the `webserver` row. The default `dsh web` port is 3080 for every profile.

### Connect an Agent

Add the token-bearing MCP URL from the startup output or pet settings to a local client that supports Streamable HTTP. Allow enough tool-call time for the subagents to finish. For Codex, use this entry in `~/.codex/config.toml`:

```toml
[mcp_servers.dsh_pet]
url = "http://127.0.0.1:3080/pet/mcp?token=<token>"
startup_timeout_sec = 120
tool_timeout_sec = 3600
enabled_tools = ["list_subagent_models", "read_subagent_guide", "subagent_delegate", "subagent_schedule", "subagent_schedule_manage"]
```

Call `list_subagent_models` to get the provider and model IDs available for new subagents. Pass `provider` to filter the list. Pass both `provider` and `model` to get one entry with `reasoning.efforts` and the adapter's `reasoning.defaultEffort`, when declared. `reasoning: null` means the model has no selectable efforts. The result lists provider IDs whose catalogs could not be read in `unavailableProviders`.

Read the [Subagent creation and management guide](assets/subagent-management.md) at `dsh-pet://guides/subagent-management`, or call `read_subagent_guide` in a tool-only client. The guide covers read-only monitoring of a running task. Call `subagent_delegate` once per independent assignment.

| Argument | Meaning |
|---|---|
| `agentSession` | Caller-supplied conversation name. Reuse it across calls within a conversation and choose a distinct name for each conversation. |
| `task` | The goal, scope, inputs, steps, and constraints for one execution subagent. |
| `acceptanceCriteria` | The calling Agent’s independent checks, methods, and expected results. |
| `expectedReturn` | The content, format, and scope of the execution subagent’s output. |
| `subagentModel` | Optional `{ "provider": "…", "model": "…" }` from `list_subagent_models`. Applies to new subagents at every depth. Omission uses the Pet profile default, DeepSeek-V4.1-Flash (`deepseek-official` / `deepseek-flash`). |
| `reasoningEffort` | Optional effort ID from the model details. Applies to new subagents at every depth. Omission uses `max` on models with selectable efforts and the provider's usual behavior on models with none. For a model with selectable efforts that lack `max`, supply one of its supported IDs. |
| `maxDepth` | Optional positive safe integer. The lead subagent is depth `0`, and its direct execution subagent is depth `1`. Omission uses the DSH depth setting. |
| `maxSubagents` | Optional positive safe integer. Limits cumulative new subagent creation at all depths for this call. Completed subagents still count. Omission leaves the cumulative count uncapped. |

The call waits for the execution subagent and its descendants to settle. The runtime checks both limits before creating a subagent, and each call has its own budget. The result includes the delegation ID, execution status, stop reason, and direct execution output. Failed and cancelled executions set `isError: true` and include any available output. The calling Agent verifies the result.

### Schedule an assignment

Call `subagent_schedule` with the same assignment fields and exactly one timing setting. For a one-time run, use `runAt` for a future RFC 3339 timestamp with an explicit UTC offset or `Z`, or `delaySeconds` for a positive whole number of seconds from submission. The tool returns the delegation ID and scheduled start without waiting for execution. Open the record in Pet history to see the planned start, status, and result.

At the requested time, Pet adds the assignment to its Agent conversation’s execution queue. Pet restores pending one-time schedules on restart and queues overdue assignments once after the profile is ready. If Pet stops during execution, a restart reports interrupted work as failed in history.

For recurring work, use `everySeconds` for a positive whole number of seconds between planned starts. For example, `300` starts the first run in five minutes and repeats every five minutes. Pet returns the schedule ID and next planned start after saving the plan. Each occurrence uses a fresh delegation and keeps its own result in Pet history. Filter history by the schedule ID to see retained runs.

Set `durationSeconds` to end a plan a fixed number of seconds after submission, or set `maxRuns` to end it after a fixed number of dispatches. With both fields, the first condition reached ends the plan. Starts scheduled on the deadline are eligible. A pause still counts toward the duration. A skipped start counts toward neither the dispatch total nor `maxRuns`. Already-dispatched runs can finish. Management reports `ended`, the end reason, and the dispatch count.

Call `subagent_schedule_manage` with the schedule ID and `view`, `pause`, `resume`, or `stop`. Viewing returns the plan and its latest retained result. Pause and stop apply to future starts, and accepted runs finish independently. Resume keeps the original interval alignment. After restart, recurring plans continue at the next future start. Pet skips and counts occurrences when the previous run is still queued or running, or when the scheduler has missed a full interval. Keep Pet running for on-time starts.

### What the pet shows

- One icon per running subagent, placed around the pet. Each icon carries the subagent's color and label.
- A click opens the delegation with the calling Agent’s conversation name, task, acceptance criteria, expected return, dispatch time, the lead subagent forwarding record, execution transcripts, and returned text.
- A finished subagent disappears from the orbit. History groups records by Agent conversation and filters by conversation, task, or delegation ID.
- The gear button shows the MCP URL and offers clipboard actions for the URL and the Codex TOML example.

The page polls the worker every second. The Result tab keeps its scroll position while the result is unchanged. The worker serves the same page to the transparent window and to regular browsers.

<a id="configuration"></a>
## Configuration

Configure the `pet-worker` row in the profile's `cordis.patch.yml`. The bundle's patch maps the values below onto that row.

| Field | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Absolute directory new worker sessions run in. Subagents inherit it. Start the worker from the project the Agent delegates work for. |
| `historyRoot` | `$DSH_HOME/pet/history` | Absolute directory for delegation history and recurring plans. One Pet worker may open this directory at a time. |
| `historyLimit` | `1000` | Retention target for delegation records. Pet evicts settled records first and retains scheduled, queued, and running records. |
| `presetId` | `pet-worker` | Agent preset for the lead subagent. |
| `childPresetId` | `standard` | Agent preset for the direct execution subagent. |
| `defaultSubagentModel` | `{ provider: deepseek-official, model: deepseek-flash }` | Route for every execution subagent when the caller omits `subagentModel`. |
| `mcpPath` | `/pet/mcp` | Absolute MCP endpoint path. |
| `pagePath` | `/pet` | Absolute pet page path; assets and the API live below it. |
| `tokenFile` | `$DSH_HOME/pet/token` | Absolute file holding the access token. Deleting it issues a new token on the next start. |
| `windowMode` | `auto` | `auto`, `electron`, `browser`, or `none`. `electron` fails when no executable is available. |
| `electronPath` | unset | Explicit Electron executable or package directory. `DSH_PET_ELECTRON` is the environment fallback. |

The pet API and MCP endpoint authenticate the access token in the URL (`?token=`) or the `Authorization: Bearer` header. The web server also restricts requests to loopback.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) registers the `pet-worker` service and lead subagent preset. The service creates the direct execution subagent with the configured child preset and passes the task, acceptance criteria, and expected return as one input.

The lead subagent reuses the deterministic Session ID derived from `agentSession` (`pet-<sha256 prefix>`). It owns the delegation tree. Pet starts the execution subagent through the runtime, awaits its result, and releases the live tree before returning.

`subagent/start` and `subagent/end` associate children with the active delegation through their `parentSessionId`. `session/event` feeds a `TranscriptBuilder` that keeps user messages, assistant text and reasoning, tool results, and turn boundaries, and drops internal request, prompt, inbox, and model-selection events. At settlement the record and its transcripts are written atomically; the index and per-record files are pruned to the cap.

The MCP endpoint is one `createMcpHandler` handler mounted on the DSH web server through `@modelcontextprotocol/node`'s `toNodeHandler`. It serves the 2026-07-28 protocol and falls back to stateless 2025-era serving. The pet window is a separate Electron process launched with `assets/pet-window.mjs`; the page talks to it through a narrow preload bridge for window resizing and quitting.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Profile composition](../../boot/app-boot/README.md) — bundle layers, the profile patch layer, and profile initialization.
- [Web application](../web-app/README.md) — the surface this bundle extends.
- [Subagents](../../subagent/subagent/README.md) — activation, lifecycle events, and child presets.
- [MCP](../../../docs/subsystems/mcp.md) — MCP transports and DSH's client/server roles.

<a id="model-experience"></a>
## Model Experience

### Delegated work

#### What the model sees

The execution subagent receives the `subagent_delegate` task, criteria, and expected return in a user message. Its output appears in the pet and goes back to the calling Agent for verification.

#### Token effect

The calling Agent sees a short guide summary and can retrieve the full text on demand. Each delegation spends model tokens on the execution subtree. The lead subagent forwards by code.

#### KV Cache effect

Each execution subagent starts a fresh conversation. The lead subagent’s Session supplies lineage and stays outside execution model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The worker opens a true desktop pet only when Electron is resolvable. Published installations without Electron use the browser page; set `electronPath` or install Electron beside the installation to restore the window.
- Each pet worker serves one workspace. To delegate work in another project directory, start another worker or reconfigure `workspace`.
- History stores normalized transcripts, not raw Session events. Internal request, prompt, inbox, and model-selection events are intentionally absent; the worker and child Sessions remain the authoritative raw logs.
- The execution subagent uses the deployed DSH preset and its permissions. Pet has no per-dispatch permissions or temporary-workspace API.
- The pet window is a second Electron process. Closing it does not stop the worker; the worker's process owns the MCP endpoint until `dsh` exits.
- The access token is a local credential, not an account authorization. Anyone who can read the token file can call the worker; the server binds loopback only.
- Windows transparency varies with GPU drivers; the viewer disables hardware acceleration for the window and falls back to the browser if Electron cannot start.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `pet` template lives in `@deepseek-ai/dsh-official-bundles`. The CLI depends on this bundle so the installation carries the patch. The published package includes the pet page assets under `assets/`. The page’s dictionary supplies English and Chinese copy.

</details>
