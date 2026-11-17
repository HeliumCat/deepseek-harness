---
description: "桌宠 worker profile：一个常驻 DSH worker，在 dsh-web-app 表层之上提供本机 MCP 派发端点与透明桌宠窗口。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-pet-app

[English](README.md) | 中文

## 概述

`dsh-pet-app` 组合出 `pet` profile，提供带透明桌宠和本机 Streamable HTTP MCP 端点的常驻 DSH worker。Agent 调用 `subagent_delegate` 来运行一个或多个 DSH subagent 并接收结果。桌宠为每个运行中的 subagent 显示一个图标，并按调用方会话分组保存派发历史。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动 worker

`dsh --profile pet` 会在首次使用时创建随附的 `pet` profile 并启动 worker。该 profile 叠放 `dsh-base`、`dsh-web-app` 与本组合包。worker 会打印桌宠页面 URL、MCP 端点与 Codex 配置示例。

当本安装可以解析到 Electron 可执行文件时（显式的 `electronPath`/`DSH_PET_ELECTRON`、安装中的 `electron` 依赖，或本包旁的检出 Desktop 应用），桌宠会在 Electron 窗口中打开；否则 worker 会在默认浏览器中打开同一页面。桌宠窗口无边框、透明、置顶，且不在任务栏显示；拖动桌宠即可移动，右键可选择历史与退出操作。设置 `windowMode: none` 可以在没有查看器的情况下运行 worker。

worker 保持常驻。如需让客户端在重启后继续使用同一个 URL，可通过 `--port` 或 `webserver` 配置行指定固定端口。各 profile 的默认 `dsh web` 端口都是 3080。

### 连接 Agent

将启动输出或桌宠设置中带 token 的 MCP URL 添加到支持 Streamable HTTP 的本机客户端，并为工具调用预留足够的时间供 subagent 完成任务。使用 Codex 时，将以下条目添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.dsh_pet]
url = "http://127.0.0.1:3080/pet/mcp?token=<token>"
startup_timeout_sec = 120
tool_timeout_sec = 3600
enabled_tools = ["list_subagent_models", "subagent_delegate"]
```

调用 `list_subagent_models` 获取可用于新子代理的提供方和模型 ID。传入 `provider` 可筛选提供方。同时传入 `provider` 和 `model` 可查询单个模型的 `reasoning.efforts` 以及适配器声明的 `reasoning.defaultEffort`。`reasoning: null` 表示模型没有可选档位。目录读取失败的提供方 ID 会列在 `unavailableProviders` 中。已有的 Codex `enabled_tools` 列表需放行两个工具。

每个派发任务调用一次 `subagent_delegate`：

| 参数 | 含义 |
|---|---|
| `agentSession` | 调用方提供的会话名。同一会话内复用同一个值，不同会话使用不同的名称。 |
| `task` | 完整的任务，包含 subagent 所需的全部事实。 |
| `acceptanceCriteria` | worker 应如何判断任务是否成功。 |
| `expectedReturn` | worker 应返回的内容、格式与范围。 |
| `subagentModel` | 可选，从 `list_subagent_models` 选择 `{ "provider": "…", "model": "…" }`。作用于各层新建的子代理。worker 主 Agent 使用自己的模型。省略时按 DSH 常规规则为子代理选择模型。 |
| `reasoningEffort` | 可选，使用模型详情中的档位 ID。作用于各层新建的子代理。省略时，有可选档位的模型使用 `max`，没有可选档位的模型按提供方常规方式运行。有可选档位但缺少 `max` 的模型需要传入其支持的一个档位 ID。 |
| `maxDepth` | 可选，正安全整数。worker 的深度为 `0`，直属子代理的深度为 `1`。省略时使用 DSH 的深度设置。 |
| `maxSubagents` | 可选，正安全整数。限制本次调用在各层累计创建的子代理数量，已完成的子代理也计入。省略时不设累计上限。 |

该调用会等 worker 和子代理完成结算。运行时在创建子代理前检查两种限制。每次调用使用独立的额度。恢复已有子代理占用活跃容量。返回文本包含派发 ID、运行状态、验收结论和返回内容。派发失败、取消或验收被拒绝时，MCP 会设置 `isError: true`，同时保留结果文本。

### 桌宠显示的内容

- 每个运行中的 subagent 有一个图标，环绕桌宠排列。每个图标都带有该 subagent 的颜色与标签。
- 点击图标可查看调用 Agent 的会话名、任务、验收标准、期望返回、派发时间、worker 和 subagent 的转录、验收结论与返回文本。
- 已完成的 subagent 会从轨道上消失。历史按 Agent 会话分组，可按会话或任务过滤。历史只保留最新的 `historyLimit` 条记录（默认 1000），并删除逐出记录的详情文件。
- 齿轮按钮显示 MCP URL，并支持复制 URL 和 Codex TOML 示例。

页面每秒轮询 worker 一次。它是由 worker 提供服务的普通 HTML 页面，因此浏览器无需透明窗口即可显示相同内容。

-----

<a id="configuration"></a>
## 配置

在 profile 的 `cordis.patch.yml` 中配置 `pet-worker` 行。组合包的 patch 会把下表中的值映射到该行。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspace` | `process.cwd()` | 新 worker 会话运行所在的绝对目录。Subagent 继承它。请在 Agent 派发任务所针对的项目目录启动 worker。 |
| `historyRoot` | `$DSH_HOME/pet/history` | 绝对历史目录；保存 `index.json` 与每个保留记录的一个文件。 |
| `historyLimit` | `1000` | 保留的派发记录上限。运行中的记录绝不被逐出；其已完成的同辈会被逐出。 |
| `presetId` | `pet-worker` | worker 主 Agent 的 agent 预设。 |
| `mcpPath` | `/pet/mcp` | 绝对 MCP 端点路径。 |
| `pagePath` | `/pet` | 绝对桌宠页面路径；资产与 API 位于其下。 |
| `tokenFile` | `$DSH_HOME/pet/token` | 保存访问 token 的绝对文件。删除它会在下次启动时签发新 token。 |
| `windowMode` | `auto` | `auto`、`electron`、`browser` 或 `none`。没有可用可执行文件时，`electron` 会失败。 |
| `electronPath` | 未设置 | 显式 Electron 可执行文件或包目录。环境变量 `DSH_PET_ELECTRON` 是回退项。 |

桌宠 API 与 MCP 端点验证 URL（`?token=`）或 `Authorization: Bearer` 头中的访问 token。Web 服务器也会将请求限制在本机回环接口。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[patch](cordis.patch.yml) 插入 `pet-worker` 服务行与一个 `@deepseek-ai/dsh-agent-preset` 声明。该预设包含一个 persona、一个固定到 `standard` 编码预设的 `tool-subagent` 实例、`pet_acceptance` 工具与标准 compaction 组。它不包含任何文件系统、shell、web 或用户提问工具，因此 worker 主 Agent 无法亲自完成被派发的工作。

该服务根据 `agentSession` 解析确定的 worker Session ID（`pet-<sha256 prefix>`），有现存 Session 时恢复，需要时创建。每次派发追加一条携带任务的用户消息，等待对应的 `turn/end`，排空 subagent 树并 flush Session。

`subagent/start` 与 `subagent/end` 通过 `parentSessionId` 把子运行关联到进行中的派发。`session/event` 送入一个 `TranscriptBuilder`，它保留用户消息、assistant 文本与推理、工具结果和轮次边界，并丢弃内部请求、prompt、inbox 与模型选择事件。验收工具把 worker 的结论写入进行中的记录。结算时，记录与其转录被原子写入；索引与逐记录文件按上限裁剪。

MCP 端点是一个 `createMcpHandler` handler，通过 `@modelcontextprotocol/node` 的 `toNodeHandler` 挂载在 DSH web 服务器上。它支持 2026-07-28 协议，并兼容无状态的 2025 版服务。桌宠窗口是由 `assets/pet-window.mjs` 启动的独立 Electron 进程，页面通过 preload bridge 与它通信以调整窗口大小或退出。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Profile 组合](../../boot/app-boot/README.zh.md) — 组合包层、profile patch 层与 profile 初始化。
- [Web 应用](../web-app/README.zh.md) — 本组合包所扩展的表层。
- [Subagent](../../subagent/subagent/README.zh.md) — 激活、生命周期事件与子预设。
- [MCP](../../../docs/subsystems/mcp.zh.md) — MCP 传输与 DSH 的客户端/服务器角色。

-----

<a id="model-experience"></a>
## 模型体验

### 一次 delegate 的运行

#### 模型看到的内容

worker 主模型收到 `pet-worker` persona、`subagent` 和 `pet_acceptance` 工具，以及作为用户消息的 `Agent delegation` 信封。persona 要求将工作派发给 subagent、调用一次验收工具，并按要求的形式回复。每个 subagent 使用 `standard` 预设。worker 的最终回复会显示在桌宠中，并返回给调用 Agent。

#### Token 影响

MCP 工具描述与服务器指令在同一个安装中是稳定的；每次派发消耗一轮 worker 模型加其派生的 subagent 轮次，worker 自身的 prompt 除 delegate 信封与累积会话（由 compaction 约束）外保持不变。

#### KV Cache 影响

worker 为每个 Agent 会话复用同一个 Session，提供方可以跨派发缓存系统提示词和历史。Compaction 可能改写历史并使缓存前缀失效。每个 subagent 都以全新会话开始，无共享前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只有能解析到 Electron 时，worker 才会打开真正的桌面桌宠。没有 Electron 的发布安装使用浏览器页面；设置 `electronPath` 或在安装旁安装 Electron 即可恢复窗口。
- 每个桌宠 worker 服务一个 workspace。如需向其他项目目录派发任务，可启动另一个 worker 或重新配置 `workspace`。
- 历史保存规范化后的转录，而不是原始 Session 事件。内部请求、prompt、inbox 与模型选择事件有意缺席；worker 与子 Session 仍是权威的原始日志。
- worker 主 Agent 没有人类通道。需要人类决策的任务会失败或返回解释，而不是提问。
- 桌宠窗口是第二个 Electron 进程。关闭它不会停止 worker；worker 进程持有 MCP 端点，直到 `dsh` 退出。
- 访问 token 是本地凭据，不是账户授权。任何能读取 token 文件的人都能调用 worker；服务器只绑定 loopback。
- Windows 的透明度随 GPU 驱动而异；查看器会为窗口禁用硬件加速，并在 Electron 无法启动时回退到浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`pet` 模板位于 `@deepseek-ai/dsh-official-bundles`；CLI 依赖本组合包，因此安装包携带该 patch。组合包在 `assets/` 下拥有自己的桌宠页面资产，发布包会包含它们；该页面不是客户端插件，因此不受客户端 UI i18n 门禁约束。验收预设行是独立的 tsdown 入口（`lib/acceptance.js`），这样预设可以挂载它而无需启动 worker 前端。

</details>
