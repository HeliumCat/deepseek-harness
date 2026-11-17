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
enabled_tools = ["list_subagent_models", "subagent_delegate"]
```

Call `list_subagent_models` to get the provider and model IDs available for new subagents. Pass `provider` to filter the list. Pass both `provider` and `model` to get one entry with `reasoning.efforts` and the adapter's `reasoning.defaultEffort`, when declared. `reasoning: null` means the model has no selectable efforts. The result lists provider IDs whose catalogs could not be read in `unavailableProviders`. Include both tools in any existing Codex `enabled_tools` list.

Call `subagent_delegate` once per delegated task:

| Argument | Meaning |
|---|---|
| `agentSession` | Caller-supplied conversation name. Reuse it across calls within a conversation and choose a distinct name for each conversation. |
| `task` | The complete task, with every fact the subagent needs. |
| `acceptanceCriteria` | How the worker must judge success. |
| `expectedReturn` | The content, format, and scope the worker should return. |
| `subagentModel` | Optional `{ "provider": "…", "model": "…" }` from `list_subagent_models`. Applies to new subagents at every depth. The worker main Agent keeps its own model. Omission uses the normal DSH child model selection. |
| `reasoningEffort` | Optional effort ID from the model details. Applies to new subagents at every depth. Omission uses `max` on models with selectable efforts and the provider's usual behavior on models with none. For a model with selectable efforts that lack `max`, supply one of its supported IDs. |
| `maxDepth` | Optional positive safe integer. The worker is depth `0`, and its direct children are depth `1`. Omission uses the DSH depth setting. |
| `maxSubagents` | Optional positive safe integer. Limits cumulative new subagent creation at all depths for this call. Completed subagents still count. Omission leaves the cumulative count uncapped. |

The call blocks until the worker and its subagent work settle. The runtime checks both limits before starting a subagent. Each call has its own budget. Resuming an existing subagent uses the live activation capacity. The result text includes the delegation ID, execution status, acceptance verdict, and returned content. A failed, cancelled, or rejected delegation sets `isError: true` and still includes the result text.

### What the pet shows

- One icon per running subagent, placed around the pet. Each icon carries the subagent's color and label.
- A click opens the delegation with the calling Agent’s conversation name, task, acceptance criteria, expected return, dispatch time, worker and subagent transcripts, acceptance verdict, and returned text.
- A finished subagent disappears from the orbit. History groups records by Agent conversation and filters by conversation or task. It retains the newest `historyLimit` records (default 1000) and deletes the detail files of evicted records.
- The gear button shows the MCP URL and offers clipboard actions for the URL and the Codex TOML example.

The page polls the worker every second. It is a normal HTML page served by the worker, so a browser shows the same content without the transparent window.

<a id="configuration"></a>
## Configuration

Configure the `pet-worker` row in the profile's `cordis.patch.yml`. The bundle's patch maps the values below onto that row.

| Field | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Absolute directory new worker sessions run in. Subagents inherit it. Start the worker from the project the Agent delegates work for. |
| `historyRoot` | `$DSH_HOME/pet/history` | Absolute history directory; holds `index.json` and one file per retained record. |
| `historyLimit` | `1000` | Maximum retained delegations. Running records are never evicted; their completed siblings are. |
| `presetId` | `pet-worker` | Agent preset for the worker main Agent. |
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

The [patch](cordis.patch.yml) inserts the `pet-worker` service row and one `@deepseek-ai/dsh-agent-preset` declaration. That preset contains a persona, a `tool-subagent` instance pinned to the `standard` coding preset, the `pet_acceptance` tool, and the standard compaction group. It contains no filesystem, shell, web, or user-question tools, so the worker main Agent cannot do the delegated work itself.

The service resolves a deterministic worker Session ID from `agentSession` (`pet-<sha256 prefix>`). It resumes an existing Session or creates one when needed. Each delegation appends a user message with the task, waits for the matching `turn/end`, drains the subagent tree, and flushes the Session.

`subagent/start` and `subagent/end` associate children with the active delegation through their `parentSessionId`. `session/event` feeds a `TranscriptBuilder` that keeps user messages, assistant text and reasoning, tool results, and turn boundaries, and drops internal request, prompt, inbox, and model-selection events. The acceptance tool writes the worker's verdict onto the active record. At settlement the record and its transcripts are written atomically; the index and per-record files are pruned to the cap.

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

The worker main model receives the `pet-worker` persona, the `subagent` and `pet_acceptance` tools, and the `Agent delegation` envelope as a user message. The persona requires subagent delegation, one acceptance call, and a final reply in the requested form. Each child uses the `standard` preset. The worker’s final reply appears in the pet and goes back to the calling Agent.

#### Token effect

The MCP tool description and server instructions are stable for one installation; every delegation spends one worker model turn plus the subagent turns it spawns, and the worker's own prompt is constant apart from the delegate envelope and accumulated conversation, which compaction bounds.

#### KV Cache effect

The worker reuses one Session per Agent conversation, so providers can cache the system prompt and history across delegations. Compaction can rewrite the history and invalidate a cached prefix. Each subagent starts a fresh conversation with no shared prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The worker opens a true desktop pet only when Electron is resolvable. Published installations without Electron use the browser page; set `electronPath` or install Electron beside the installation to restore the window.
- Each pet worker serves one workspace. To delegate work in another project directory, start another worker or reconfigure `workspace`.
- History stores normalized transcripts, not raw Session events. Internal request, prompt, inbox, and model-selection events are intentionally absent; the worker and child Sessions remain the authoritative raw logs.
- The worker main Agent has no human channel. A task that needs a human decision fails or returns an explanation instead of asking.
- The pet window is a second Electron process. Closing it does not stop the worker; the worker's process owns the MCP endpoint until `dsh` exits.
- The access token is a local credential, not an account authorization. Anyone who can read the token file can call the worker; the server binds loopback only.
- Windows transparency varies with GPU drivers; the viewer disables hardware acceleration for the window and falls back to the browser if Electron cannot start.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `pet` template lives in `@deepseek-ai/dsh-official-bundles`; the CLI depends on this bundle so the installation carries the patch. The bundle owns its pet page assets under `assets/`, which the published package includes; the page is not a client plugin and is therefore outside the client UI i18n gate. The acceptance preset row is a separate tsdown entry (`lib/acceptance.js`) so the preset can mount it without starting the worker frontend.

</details>
