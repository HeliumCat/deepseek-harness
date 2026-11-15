---
description: "桌宠 worker profile：一个常驻 DSH worker，在 dsh-web-app 表层之上提供本机 MCP 派发端点与透明桌宠窗口。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-pet-app

[English](README.md) | 中文

## 概述

`dsh-pet-app` 组合出 `pet` profile：一个带透明桌宠与一个 Streamable HTTP MCP 端点的常驻 DSH worker。Codex 以当前 Codex 会话名、任务、验收标准与期望返回调用 `subagent_delegate`。worker 主 Agent 只分析该调用并派生 DSH subagent；它没有任何文件、shell 或 web 工具。桌宠为每个运行中的 subagent 显示一个图标；点击图标即打开完整的派发记录。已完成的 subagent 会离开桌宠，但仍保留在按 Codex 会话分组的历史中，保存最新的 1000 条记录。

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

`dsh --profile pet` 会在首次使用时创建随附的 `pet` profile 并启动 worker。该 profile 叠放 `dsh-base`、`dsh-web-app` 与本组合包。worker 会打印桌宠页面 URL、MCP 端点与 Codex 配置条目。

当本安装可以解析到 Electron 可执行文件时（显式的 `electronPath`/`DSH_PET_ELECTRON`、安装中的 `electron` 依赖，或本包旁的检出 Desktop 应用），桌宠会在 Electron 窗口中打开；否则 worker 会在默认浏览器中打开同一页面。桌宠窗口无边框、透明、置顶，且不在任务栏显示；拖动桌宠即可移动，右键可选择历史与退出操作。设置 `windowMode: none` 可以在没有查看器的情况下运行 worker。

worker 保持常驻。若 Codex 的配置需要在重启后仍然有效，请使用固定 web 端口，因为每个 profile 的默认 `dsh web` 端口都是 3080；通过 profile 启动器传入 `--port`，或 patch `webserver` 配置行。

### 连接 Codex

启动输出会打印完整的 TOML 条目。它看起来像这样：

```toml
[mcp_servers.dsh_pet]
url = "http://127.0.0.1:3080/pet/mcp?token=<token>"
startup_timeout_sec = 120
tool_timeout_sec = 3600
enabled_tools = ["subagent_delegate"]
```

Codex 为每个被派发的任务发送一次 `subagent_delegate` 调用：

| 参数 | 含义 |
|---|---|
| `codexSession` | 调用方 Codex 会话的可读名称。同一会话中的每次调用都必须传相同的值；历史按它分组。 |
| `task` | 完整的任务，包含 subagent 所需的全部事实。 |
| `acceptanceCriteria` | worker 应如何判断任务是否成功。 |
| `expectedReturn` | worker 应返回的内容、格式与范围。 |

该调用会阻塞，直到 worker 主 Agent 完成本轮。其返回文本会注明本次派发、验收结论与返回内容；失败或被拒绝的派发会设置 MCP 错误标记。

### 桌宠显示的内容

- 每个运行中的 subagent 有一个图标，环绕桌宠排列。每个图标都带有该 subagent 的颜色与标签。
- 点击即打开该次派发：Codex 会话名、被派发的任务、验收标准、期望返回、派发时间、运行中的 subagent 列表、worker 转录、每个 subagent 的转录、验收结论与返回文本。
- 已完成的 subagent 会从轨道上消失；其记录保留在历史中。历史按 Codex 会话分组，可按会话或任务过滤，且只保留最新的 `historyLimit` 条记录（默认 1000）；逐出一条记录会删除其详情文件。
- 齿轮按钮显示 MCP 端点与可直接复制的 Codex 配置条目。

页面每秒轮询 worker 一次。它是由 worker 提供服务的普通 HTML 页面，因此浏览器无需透明窗口即可显示相同内容。

-----

<a id="configuration"></a>
## 配置

在 profile 的 `cordis.patch.yml` 中配置 `pet-worker` 行。组合包的 patch 会把下表中的值映射到该行。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspace` | `process.cwd()` | 新 worker 会话运行所在的绝对目录。Subagent 继承它。请在 Codex 所工作的项目目录启动 worker。 |
| `historyRoot` | `$DSH_HOME/pet/history` | 绝对历史目录；保存 `index.json` 与每个保留记录的一个文件。 |
| `historyLimit` | `1000` | 保留的派发记录上限。运行中的记录绝不被逐出；其已完成的同辈会被逐出。 |
| `presetId` | `pet-worker` | worker 主 Agent 的 agent 预设。 |
| `mcpPath` | `/pet/mcp` | 绝对 MCP 端点路径。 |
| `pagePath` | `/pet` | 绝对桌宠页面路径；资产与 API 位于其下。 |
| `tokenFile` | `$DSH_HOME/pet/token` | 保存访问 token 的绝对文件。删除它会在下次启动时签发新 token。 |
| `windowMode` | `auto` | `auto`、`electron`、`browser` 或 `none`。没有可用可执行文件时，`electron` 会失败。 |
| `electronPath` | 未设置 | 显式 Electron 可执行文件或包目录。环境变量 `DSH_PET_ELECTRON` 是回退项。 |

每条桌宠路由与 MCP 端点都要求在 URL（`?token=`）或 `Authorization: Bearer` 头中携带访问 token。这些路由在 DSH web 服务器上注册为匿名路由，因为 Codex 不是浏览器 Peer；token 就是授权凭证，而 web 服务器的 loopback 来源防护仍然生效。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[patch](cordis.patch.yml) 插入 `pet-worker` 服务行与一个 `@deepseek-ai/dsh-agent-preset` 声明。该预设包含一个 persona、一个固定到 `standard` 编码预设的 `tool-subagent` 实例、`pet_acceptance` 工具与标准 compaction 组。它不包含任何文件系统、shell、web 或用户提问工具，因此 worker 主 Agent 无法亲自完成被派发的工作。

该服务为每个 Codex 会话名解析一个确定性的 worker Session id（`pet-<sha256 prefix>`）；持久化中已有它时就恢复，否则创建它。每次派发追加一条用户消息（delegate 信封），等待对应的 `turn/end`，排空 subagent 树并 flush Session。worker 会话与子会话都是普通 DSH 会话，因此模型请求、工具调用与 compaction 都可审计。

`subagent/start` 与 `subagent/end` 通过 `parentSessionId` 把子运行关联到进行中的派发。`session/event` 送入一个 `TranscriptBuilder`，它保留用户消息、assistant 文本与推理、工具结果和轮次边界，并丢弃内部请求、prompt、inbox 与模型选择事件。验收工具把 worker 的结论写入进行中的记录。结算时，记录与其转录被原子写入；索引与逐记录文件按上限裁剪。

MCP 端点是一个 `createMcpHandler` handler，通过 `@modelcontextprotocol/node` 的 `toNodeHandler` 挂载在 DSH web 服务器上。它服务 2026-07-28 协议，并回退到无状态的 2025 时代服务，因此 Codex 与 DSH 自己的 MCP 客户端都能使用。桌宠窗口是一个由 `assets/pet-window.mjs` 启动的独立 Electron 进程；页面通过一个窄 preload bridge 与它通信，用于调整窗口大小与退出。

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

worker 主模型收到 `pet-worker` persona、`subagent` 工具（子默认预设为 standard）、`pet_acceptance` 工具，以及作为用户消息的 delegate 信封；persona 禁止直接完成工作，并要求一次验收调用与符合期望形式的最终回复，每个 subagent 运行 `standard` 预设，其最终 assistant 消息成为桌宠展示并返回给 Codex 的输出。

#### Token 影响

MCP 工具描述与服务器指令在同一个安装中是稳定的；每次派发消耗一轮 worker 模型加其派生的 subagent 轮次，worker 自身的 prompt 除 delegate 信封与累积会话（由 compaction 约束）外保持不变。

#### KV Cache 影响

worker 为每个 Codex 会话复用同一个 Session，因此其系统提示词与累积历史构成可供提供商缓存的稳定前缀；每次派发追加信封，compaction 可能改写历史从而使后续轮次的缓存失效，而每个 subagent 都以全新会话开始，不共享前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只有能解析到 Electron 时，worker 才会打开真正的桌面桌宠。没有 Electron 的发布安装使用浏览器页面；设置 `electronPath` 或在安装旁安装 Electron 即可恢复窗口。
- 桌宠一次只服务一个 workspace。`codexSession` 分组历史，但不能选择不同的项目目录；启动另一个 worker 或重新配置 `workspace`。
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
