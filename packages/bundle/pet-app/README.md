---
description: "Desktop pet worker profile: a resident DSH worker that serves a localhost MCP delegation endpoint and a transparent pet window over the dsh-web-app surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-pet-app

English | [中文](README.zh.md)

## Summary

`dsh-pet-app` composes the `pet` profile: a resident DSH worker with a transparent desktop pet and one Streamable HTTP MCP endpoint. Codex calls `subagent_delegate` with the current Codex conversation name, the task, the acceptance criteria, and the expected return. The worker's main Agent only analyzes that call and spawns DSH subagents; it has no file, shell, or web tools. The pet shows one icon per running subagent; clicking an icon opens the full delegation record. Completed subagents leave the pet but stay in history grouped by Codex conversation, keeping the newest 1000 records.

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

`dsh --profile pet` creates the shipped `pet` profile on first use and starts the worker. The profile stacks `dsh-base`, `dsh-web-app`, and this bundle. The worker prints the pet page URL, the MCP endpoint, and the Codex configuration entry.

The pet opens in an Electron window when this installation can resolve an Electron executable: an explicit `electronPath`/`DSH_PET_ELECTRON`, an `electron` dependency in the installation, or the checkout's Desktop application beside this package. Without one, the worker opens the same page in the default browser. The pet window is frameless, transparent, always on top, and skipped from the taskbar; drag the pet to move it and right-click it for the history and quit actions. Set `windowMode: none` to run the worker without a viewer.

The worker stays resident. Use a fixed web port when Codex's configuration must survive a restart, because the default `dsh web` port is 3080 for every profile; pass `--port` through the profile launcher or patch the `webserver` row.

### Connect Codex

The startup output prints the complete TOML entry. It looks like this:

```toml
[mcp_servers.dsh_pet]
url = "http://127.0.0.1:3080/pet/mcp?token=<token>"
startup_timeout_sec = 120
tool_timeout_sec = 3600
enabled_tools = ["subagent_delegate"]
```

Codex sends one `subagent_delegate` call per delegated task:

| Argument | Meaning |
|---|---|
| `codexSession` | Human-readable name of the calling Codex conversation. Every call in one conversation must pass the same value; history groups by it. |
| `task` | The complete task, with every fact the subagent needs. |
| `acceptanceCriteria` | How the worker must judge success. |
| `expectedReturn` | The content, format, and scope the worker should return. |

The call blocks until the worker main Agent finishes its turn. Its result text names the delegation, the acceptance verdict, and the returned content; a failed or rejected delegation sets the MCP error flag.

### What the pet shows

- One icon per running subagent, placed around the pet. Each icon carries the subagent's color and label.
- A click opens the delegation: the Codex session name, the delegated task, acceptance criteria, expected return, dispatch time, the running list of subagents, the worker transcript, every subagent transcript, the acceptance verdict, and the returned text.
- A finished subagent disappears from the orbit; its record stays in history. History is grouped by Codex session and can be filtered by conversation or task. It is capped at the newest `historyLimit` records (default 1000); evicting a record deletes its detail file.
- The gear button shows the MCP endpoint and a copy-ready Codex entry.

The page polls the worker every second. It is a normal HTML page served by the worker, so a browser shows the same content without the transparent window.

<a id="configuration"></a>
## Configuration

Configure the `pet-worker` row in the profile's `cordis.patch.yml`. The bundle's patch maps the values below onto that row.

| Field | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Absolute directory new worker sessions run in. Subagents inherit it. Start the worker from the project Codex works on. |
| `historyRoot` | `$DSH_HOME/pet/history` | Absolute history directory; holds `index.json` and one file per retained record. |
| `historyLimit` | `1000` | Maximum retained delegations. Running records are never evicted; their completed siblings are. |
| `presetId` | `pet-worker` | Agent preset for the worker main Agent. |
| `mcpPath` | `/pet/mcp` | Absolute MCP endpoint path. |
| `pagePath` | `/pet` | Absolute pet page path; assets and the API live below it. |
| `tokenFile` | `$DSH_HOME/pet/token` | Absolute file holding the access token. Deleting it issues a new token on the next start. |
| `windowMode` | `auto` | `auto`, `electron`, `browser`, or `none`. `electron` fails when no executable is available. |
| `electronPath` | unset | Explicit Electron executable or package directory. `DSH_PET_ELECTRON` is the environment fallback. |

Every pet route and the MCP endpoint require the access token in the URL (`?token=`) or an `Authorization: Bearer` header. The routes are registered as anonymous on the DSH web server because Codex is not a browser Peer; the token is the authorization, and the web server's loopback source fence still applies.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) inserts the `pet-worker` service row and one `@deepseek-ai/dsh-agent-preset` declaration. That preset contains a persona, a `tool-subagent` instance pinned to the `standard` coding preset, the `pet_acceptance` tool, and the standard compaction group. It contains no filesystem, shell, web, or user-question tools, so the worker main Agent cannot do the delegated work itself.

The service resolves one deterministic worker Session id per Codex conversation name (`pet-<sha256 prefix>`), resumes it when persistence has it, and creates it otherwise. Each delegation appends one user message (the delegate envelope), waits for the matching `turn/end`, drains the subagent tree, and flushes the Session. Worker sessions and child sessions are ordinary DSH sessions, so model requests, tool calls, and compaction remain auditable.

`subagent/start` and `subagent/end` associate children with the active delegation through their `parentSessionId`. `session/event` feeds a `TranscriptBuilder` that keeps user messages, assistant text and reasoning, tool results, and turn boundaries, and drops internal request, prompt, inbox, and model-selection events. The acceptance tool writes the worker's verdict onto the active record. At settlement the record and its transcripts are written atomically; the index and per-record files are pruned to the cap.

The MCP endpoint is one `createMcpHandler` handler mounted on the DSH web server through `@modelcontextprotocol/node`'s `toNodeHandler`. It serves the 2026-07-28 protocol and falls back to stateless 2025-era serving, so both Codex and DSH's own MCP client work. The pet window is a separate Electron process launched with `assets/pet-window.mjs`; the page talks to it through a narrow preload bridge for window resizing and quitting.

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

The worker main model receives the `pet-worker` persona, the `subagent` tool (with the standard preset as its child default), the `pet_acceptance` tool, and the delegate envelope as a user message; the persona forbids doing the work directly and requires one acceptance call and a final reply in the expected form, and each subagent runs the `standard` preset whose final assistant message becomes the output shown in the pet and returned to Codex.

#### Token effect

The MCP tool description and server instructions are stable for one installation; every delegation spends one worker model turn plus the subagent turns it spawns, and the worker's own prompt is constant apart from the delegate envelope and accumulated conversation, which compaction bounds.

#### KV Cache effect

The worker reuses one Session per Codex conversation, so its system prompt and accumulated history form a prefix providers can cache across delegations; each delegation appends the envelope and compaction can rewrite history, invalidating cached prefixes for later turns, and every subagent starts a fresh conversation with no shared prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The worker opens a true desktop pet only when Electron is resolvable. Published installations without Electron use the browser page; set `electronPath` or install Electron beside the installation to restore the window.
- The pet works for one workspace at a time. `codexSession` groups history but cannot select a different project directory; start another worker or reconfigure `workspace`.
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
