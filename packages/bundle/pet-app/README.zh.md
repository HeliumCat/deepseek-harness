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
enabled_tools = ["list_subagent_models", "read_subagent_guide", "subagent_delegate", "subagent_schedule", "subagent_schedule_manage"]
```

调用 `list_subagent_models` 获取可用于新子代理的提供方和模型 ID。传入 `provider` 可筛选提供方。同时传入 `provider` 和 `model` 可查询单个模型的 `reasoning.efforts` 以及适配器声明的 `reasoning.defaultEffort`。`reasoning: null` 表示模型没有可选档位。目录读取失败的提供方 ID 会列在 `unavailableProviders` 中。

通过 `dsh-pet://guides/subagent-management` 读取[子代理创建与管理规范](assets/subagent-management.md)。仅支持工具的客户端可调用 `read_subagent_guide`。指南说明如何委派对运行中任务的只读观察。每个独立任务调用一次 `subagent_delegate`。

| 参数 | 含义 |
|---|---|
| `agentSession` | 调用方提供的会话名。同一会话内复用同一个值，不同会话使用不同的名称。 |
| `task` | 一个执行子代理所需的目标、范围、输入、步骤和约束。 |
| `acceptanceCriteria` | 调用方 Agent 将独立执行的检查、检查方法和预期结果。 |
| `expectedReturn` | 执行子代理应返回的内容、格式与范围。 |
| `subagentModel` | 可选，从 `list_subagent_models` 选择 `{ "provider": "…", "model": "…" }`。作用于各层新建的子代理。省略时使用 Pet profile 的默认模型 DeepSeek-V4.1-Flash（`deepseek-official` / `deepseek-flash`）。 |
| `reasoningEffort` | 可选，使用模型详情中的档位 ID。作用于各层新建的子代理。省略时，有可选档位的模型使用 `max`，没有可选档位的模型按提供方常规方式运行。有可选档位但缺少 `max` 的模型需要传入其支持的一个档位 ID。 |
| `maxDepth` | 可选，正安全整数。Lead subagent 的深度为 `0`，直属执行子代理的深度为 `1`。省略时使用 DSH 的深度设置。 |
| `maxSubagents` | 可选，正安全整数。限制本次调用在各层累计创建的子代理数量，已完成的子代理也计入。省略时不设累计上限。 |

该调用等待执行子代理及其后代结束。运行时在创建子代理前检查两种限制，每次调用使用独立额度。返回结果包含派发 ID、运行状态、停止原因和直属执行子代理的输出。失败或取消时，MCP 设置 `isError: true` 并保留已有输出。调用方 Agent 独立验收。

### 安排定时派发

调用 `subagent_schedule`，提供相同的任务字段，并选择一种定时方式。单次执行可通过 `runAt` 指定带明确 UTC 偏移或 `Z` 的未来 RFC 3339 时间，或者用 `delaySeconds` 指定提交后延迟的正整数秒数。工具立即返回派发 ID 和计划开始时间。打开 Pet 历史中的记录即可查看计划时间、状态和结果。

到达计划时间后，Pet 将任务放入所属 Agent 会话的执行队列。重启时恢复待执行的单次计划，并在 profile 就绪后将已到期的任务入队一次。如果 Pet 在执行期间停止，重启后历史会把中断的任务记为失败。

周期任务使用 `everySeconds` 指定相邻计划时间之间的正整数秒数。例如，传入 `300` 会在五分钟后启动第一次，此后每五分钟触发一次。Pet 保存计划后返回计划 ID 和下次运行时间。每次触发都会生成独立的派发，结果保存在 Pet 历史中。可按计划 ID 筛选已保留的运行记录。

传 `durationSeconds` 可在提交后经过指定秒数时自动结束计划，传 `maxRuns` 可在达到指定派发次数时自动结束。两个字段同时传入时，以先达到的条件为准。计划时间恰好等于截止时间的一轮仍可派发。暂停期间持续时间照常计算。跳过的轮次不计入派发次数或 `maxRuns`，已派发的任务可以继续完成。管理工具会返回 `ended` 状态、结束原因和派发次数。

用计划 ID 调用 `subagent_schedule_manage`，并传入 `view`、`pause`、`resume` 或 `stop`。查询返回计划和最近一次保留的结果。暂停和停止作用于后续触发，已经入队的执行可以继续完成。恢复时沿用原有的触发节奏。重启后，周期计划从下一个未来时间继续。上一轮仍在排队或执行，或调度已错过一个完整周期时，Pet 会跳过并记下次数。要按时触发，需要保持 Pet 运行。

### 桌宠显示的内容

- 每个运行中的 subagent 有一个图标，环绕桌宠排列。每个图标都带有该 subagent 的颜色与标签。
- 点击图标可查看调用 Agent 的会话名、任务、验收标准、期望返回、派发时间、lead subagent 的转发记录、执行子代理转录和返回文本。
- 已完成的子代理会从轨道上消失。历史按 Agent 会话分组，可按会话、任务或派发 ID 过滤。
- 齿轮按钮显示 MCP URL，并支持复制 URL 和 Codex TOML 示例。

页面每秒轮询 worker 一次。结果内容未变化时，结果页签会保留滚动位置。透明窗口和普通浏览器使用 worker 提供的同一个页面。

-----

<a id="configuration"></a>
## 配置

在 profile 的 `cordis.patch.yml` 中配置 `pet-worker` 行。组合包的 patch 会把下表中的值映射到该行。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspace` | `process.cwd()` | 新 worker 会话运行所在的绝对目录。Subagent 继承它。请在 Agent 派发任务所针对的项目目录启动 worker。 |
| `historyRoot` | `$DSH_HOME/pet/history` | 保存派发历史和周期计划的绝对目录。同一目录同时只允许一个 Pet worker 打开。 |
| `historyLimit` | `1000` | 派发记录的保留目标。Pet 优先清理已结束的记录，保留已定时、排队中和运行中的记录。 |
| `presetId` | `pet-worker` | Lead subagent 的 Agent 预设。 |
| `childPresetId` | `standard` | 直属执行子代理的 Agent 预设。 |
| `defaultSubagentModel` | `{ provider: deepseek-official, model: deepseek-flash }` | 调用方省略 `subagentModel` 时各层执行子代理使用的模型路由。 |
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

[Patch](cordis.patch.yml) 注册 `pet-worker` 服务和 lead subagent 预设。服务使用配置的子预设创建直属执行子代理，将任务、验收标准和预期输出作为一次输入传递。

Lead subagent 复用由 `agentSession` 确定的 Session ID（`pet-<sha256 prefix>`），作为派发树的根节点。Pet 通过运行时启动执行子代理，等待结果后释放运行中的子代理树。

`subagent/start` 与 `subagent/end` 通过 `parentSessionId` 把子运行关联到进行中的派发。`session/event` 送入一个 `TranscriptBuilder`，它保留用户消息、assistant 文本与推理、工具结果和轮次边界，并丢弃内部请求、prompt、inbox 与模型选择事件。结算时，记录与其转录被原子写入；索引与逐记录文件按上限裁剪。

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

执行子代理在一条用户消息中收到 `subagent_delegate` 的任务、验收标准和预期输出。执行输出显示在桌宠中，并返回给调用方 Agent 验收。

#### Token 影响

调用方 Agent 收到简短的规范摘要，按需读取全文。每次派发的模型 token 消耗来自执行子代理树。Lead subagent 通过代码转发。

#### KV Cache 影响

每个执行子代理都以全新会话开始。Lead subagent 的会话记录派发归属，无需进入执行模型的请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只有能解析到 Electron 时，worker 才会打开真正的桌面桌宠。没有 Electron 的发布安装使用浏览器页面；设置 `electronPath` 或在安装旁安装 Electron 即可恢复窗口。
- 每个桌宠 worker 服务一个 workspace。如需向其他项目目录派发任务，可启动另一个 worker 或重新配置 `workspace`。
- 历史保存规范化后的转录，而不是原始 Session 事件。内部请求、prompt、inbox 与模型选择事件有意缺席；worker 与子 Session 仍是权威的原始日志。
- 执行子代理使用部署的 DSH 预设及其权限。Pet 暂未提供按次授权或临时工作区接口。
- 桌宠窗口是第二个 Electron 进程。关闭它不会停止 worker；worker 进程持有 MCP 端点，直到 `dsh` 退出。
- 访问 token 是本地凭据，不是账户授权。任何能读取 token 文件的人都能调用 worker；服务器只绑定 loopback。
- Windows 的透明度随 GPU 驱动而异；查看器会为窗口禁用硬件加速，并在 Electron 无法启动时回退到浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`pet` 模板位于 `@deepseek-ai/dsh-official-bundles`，CLI 依赖本组合包，因此安装包携带该 patch。发布包包含 `assets/` 下的桌宠页面资源。该页面使用本地词典提供中英文文案。

</details>
