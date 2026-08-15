# DSH × Herdr 集成插件 — 设计文档

> 状态：**Draft（评审 v0.2）** · 版本：0.2 · 日期：2026-02（会话内）
>
> v0.2 变更（自审修订）：修正 JobOutcome 形状、CLI 传输下 agent 列表实现路径、pane_run schema
> 缺 timed_out、agent_wait 缺 not_found 分支、session/HERDR_BIN_PATH 解析顺序、Windows socket 路径
> 断言、事件轮询间隔措辞；补充内容持久化边界、构建工具链、后台结果获取、集成测试凭据标注。
>
> 前置分析见会话记录：DSH 插件能力（[develop/basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)）与
> Herdr 控制面（[agent-guide](https://herdr.dev/agent-guide.md)、[socket-api](https://herdr.dev/docs/socket-api/)、[cli-reference](https://herdr.dev/docs/cli-reference/)）。
> 本文档是 M0 原型开始前的完整设计基线；评审通过后按 [里程碑](#15-里程碑) 实施。

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [集成方向与边界](#2-集成方向与边界)
3. [总体架构](#3-总体架构)
4. [关键设计决策（ADR）](#4-关键设计决策adr)
5. [包结构与代码组织](#5-包结构与代码组织)
6. [配置设计](#6-配置设计)
7. [HerdrClient 服务（传输层）](#7-herdrclient-服务传输层)
8. [工具设计](#8-工具设计)
9. [后台任务设计](#9-后台任务设计)
10. [事件集成设计（双向）](#10-事件集成设计双向)
11. [错误处理与诊断](#11-错误处理与诊断)
12. [安全与权限](#12-安全与权限)
13. [UI 呈现设计](#13-ui-呈现设计)
14. [测试与验证](#14-测试与验证)
15. [里程碑](#15-里程碑)
16. [风险与开放问题](#16-风险与开放问题)
17. [参考资料](#17-参考资料)

---

## 1. 背景与目标

### 1.1 背景

- **DSH（DeepSeek Harness）** 是一个基于 Cordis 的 agent harness，提供 Web UI、类型化工具注册
  （`defineTool`）、事件系统、服务注入（`tools` / `shell` / `agents` / `jobs`）与 bundle 分发机制。
  DSH agent 运行在浏览器/Web UI 中，其 shell 工具在宿主机执行命令，但**不拥有持久的终端会话**。
- **Herdr** 是一个面向 AI coding agent 的终端多路复用器（tmux 类），核心资产是**持久化 pane**
  （detach 后继续运行）与 **agent 感知**（检测 pane 内的 coding agent，状态机
  `working / blocked / done / idle / unknown`，侧边栏展示）。Herdr 提供 CLI 与本地 socket API
  两层编程控制面，专门为"agent/脚本驱动 Herdr"设计（`herdr api schema --json` 可导出完整协议 Schema）。

### 1.2 目标

构建一个 DSH 插件（下称 **`dsh-plugin-herdr`**），使 DSH agent 具备：

1. **观察**：查看 Herdr 会话快照（workspace / tab / pane / agent 状态）；
2. **控制**：创建 workspace、开 pane、在 pane 中运行命令/发送按键、读取输出、重组布局；
3. **等待**：阻塞式等待 agent 达到目标状态（`done` / `blocked` …），支持后台化；
4. **双向事件**：
   - Herdr → DSH：订阅 Herdr 事件并转译为 Cordis 事件，供其他插件联动；
   - DSH → Herdr：当 DSH 自身运行在 Herdr pane 内（`HERDR_ENV=1`）时，把 DSH agent
     的实时状态上报到 Herdr 侧边栏（与官方 integration 行为一致）；
5. **工程化交付**：以 bundle 形式发布，`dsh plugin add` 即可安装，配置经过 schema 校验，支持 HMR。

### 1.3 非目标（明确不做）

- 不重写 Herdr 的渲染层；pane 内容以文本/卡片呈现，不做终端模拟器。
- 不实现 Herdr 侧的 `herdr-plugin.toml` 插件编写（那是另一个生态）；但保留
  `integration.install` / `plugin.action.invoke` 的**驱动能力**作为扩展工具（见 §8.3）。
- 不做 socket 协议的完整重实现：优先 CLI 包装，raw socket 仅用于需要长连接订阅/流式读取的场景。
- 不把 DSH 改造成终端复用器。

### 1.4 术语

| 术语 | 含义 |
|---|---|
| pane | Herdr 中的一个真实终端进程（如 `w1:p1`） |
| agent | Herdr 在 pane 内检测到的 coding agent，有语义状态 |
| transport | 插件与 Herdr 的通信方式：CLI 适配器或 raw socket 适配器 |
| job | DSH `ctx.jobs` 后台任务（`<kind>-N` id，会话围栏） |
| 规范值 | `defineTool` 的 `output.schema` 声明的 lossless-JSON 返回值 |
| HERDR_ENV | Herdr 注入 pane 进程的环境变量 `HERDR_ENV=1` |

---

## 2. 集成方向与边界

```
                     ┌───────────────────────────────────────────────┐
                     │            DSH Harness（Web UI）              │
                     │                                               │
                     │  ┌─────────────────────────────────────────┐  │
                     │  │        dsh-plugin-herdr (bundle)        │  │
                     │  │                                         │  │
                     │  │  tools: herdr_*        (defineTool)     │  │
                     │  │  service: ctx.herdr    (HerdrClient)    │  │
                     │  │  jobs:   ctx.jobs      (后台等待)        │  │
                     │  │  events: herdr/* → Cordis 事件           │  │
                     │  │          DSH 状态 → pane.report_agent    │  │
                     │  └──────────────────┬──────────────────────┘  │
                     └─────────────────────┼─────────────────────────┘
                                           │ 传输层
                        ┌──────────────────┴──────────────────┐
                        │  ① CLI: herdr <cmd>（默认，跨平台）   │
                        │  ② Socket: JSONL over Unix socket    │
                        │     / Windows named pipe（可选）       │
                        └──────────────────┬──────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │        Herdr server（后台常驻会话）            │
                    │  workspace / tab / pane / agent / events      │
                    │  侧边栏：working / blocked / done / idle       │
                    └──────────────────────────────────────────────┘
```

- **DSH 是控制器，Herdr 是被控端**：DSH agent 通过工具驱动 Herdr 的持久终端与其中运行的 agent。
- **反向通道（可选，M3）**：DSH server 自身若启动在 Herdr pane 内，插件读取
  `HERDR_PANE_ID` 等注入变量，把 DSH agent 生命周期映射为 `pane.report_agent` 上报。
- **边界**：插件运行在 harness 进程内（Node），与 harness 同权限；socket/CLI 调用不受
  模型 bash 工具的沙箱约束（详见 §12）。

---

## 3. 总体架构

### 3.1 模块职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `index.ts` | 插件入口：注册 Config、加载 HerdrClient 服务、注册工具、接线事件 | cordis |
| `config.ts` | `Config` 接口 + Schemastery schema（唯一事实源） | schemastery |
| `client/` | HerdrClient 服务（抽象 `Service` 子类）：传输层适配器 + 方法封装 | cordis, node:child_process / node:net |
| `client/cli.ts` | CLI 适配器：`herdr ...` → 结构化 JSON（`--json`/`api snapshot`） | child_process |
| `client/socket.ts` | Socket 适配器：JSONL 请求/响应/订阅（M2） | node:net |
| `client/types.ts` | 协议类型（由 `herdr api schema --json` 生成，版本锁定） | — |
| `tools/*.ts` | 每个 `herdr_*` 工具一个文件：`defineTool` 定义 | dsh-tools |
| `jobs.ts` | `ctx.jobs.start` producer 封装（等待类工具的 `run_in_background` 分支） | dsh-jobs |
| `events/forward.ts` | Herdr 事件订阅 → Cordis 事件转发（M2） | cordis |
| `events/state-report.ts` | DSH agent 状态 → `pane.report_agent` 上报（M3） | dsh-agent, dsh-session |

### 3.2 服务图（Cordis 注入关系）

```
ctx.shell ──► dsh-plugin-herdr ──► ctx.herdr (HerdrClient)
ctx.tools ──► 注册 herdr_* 工具（inject: ['tools', 'herdr']）
ctx.jobs  ──► 后台等待 producer（inject: ['jobs', 'herdr']）
ctx.agents──► 状态上报（M3，可选 inject）
```

- `HerdrClient extends Service`，注册名 `herdr`；用 `declare module '@deepseek-ai/cordis'`
  为 `ctx.herdr` 提供类型。
- 服务实例在插件加载时创建，`ctx.effect()` 注册清理（断开 socket、杀掉在途 CLI 进程）。

---

## 4. 关键设计决策（ADR）

### ADR-1：默认走 CLI 适配器，raw socket 为可选进阶

- **决定**：M1 只实现 CLI 适配器（`herdr ...` 子进程）；M2 增加 socket 适配器。
- **理由**：Herdr 文档明确推荐插件用 `HERDR_BIN_PATH` + CLI 包装以获得可移植性
  （Windows named pipe 对 raw 客户端不友好）；CLI 有 `--json` / `api snapshot` 等结构化输出，
  且天然获得 Herdr 内置的校验与错误信息。
- **回退**：需要长连接事件订阅、`pane.wait_for_output` 流式读取、低延迟轮询时切 socket 适配器；
  两种适配器实现同一接口，可配置切换（`transport: 'cli' | 'socket'`）。

### ADR-2：协议类型以 `herdr api schema --json` 为唯一事实源

- **决定**：`client/types.ts` 由生成脚本从 Herdr 安装的 schema 产出（`scripts/gen-types.mjs`），
  并在 README 记录生成时的 `herdr --version`。
- **理由**：Herdr 是 preview 版本，协议在演进；手工维护类型必然漂移。
- **校验**：插件加载时可选做 `herdr api schema` 摘要比对，版本不兼容打警告（不阻断）。

### ADR-3：工具的规范值表达"领域结果"，异常才抛错

- **决定**：超时、agent 未找到、pane 不存在等**业务性失败**用规范值表达
  （如 `{ status: 'timeout', ... }`），只有传输/协议/配置错误抛 `Error`（进入 `isError`）。
- **理由**：符合 DSH 工具契约（"Represent a successful domain outcome in the canonical value"），
  让模型能读到结构化结果并自行决策，而不是只看到错误文本。

### ADR-4：等待类工具必须支持后台化，且后台化是配置闸门

- **决定**：`herdr_agent_wait` / `herdr_pane_run` 提供 `run_in_background` 参数；
  但参数是否可见由配置 `allowBackground` 控制（默认 `false`，M1 阶段前台）。
- **理由**：`agent.wait --until done` 可能耗时数分钟，前台调用会占满一轮工具调用；
  DSH 的 `ctx.jobs` 为此提供了 id、会话围栏、通用控制工具与通知。配置闸门防止模型
  在部署方未批准时随意开后台任务。

### ADR-5：事件转发是显式配置项，默认关闭

- **决定**：`events.enabled` 默认 `false`；开启后插件建立长连接订阅并转发为
  `herdr/*` Cordis 事件，断线按指数退避重连。
- **理由**：长连接有资源与隐私成本；Herdr 事件默认不消费是合理默认。

### ADR-6：状态上报只在 `HERDR_ENV=1` 时激活

- **决定**：M3 的反向上报模块在插件加载时探测 `process.env.HERDR_ENV`，不满足则整体禁用
  （注册一个空实现并打印一行日志）。
- **理由**：上报目标 pane 依赖 Herdr 注入的 `HERDR_PANE_ID`；在非 Herdr 环境猜测 pane id 只会产生脏数据。

---

## 5. 包结构与代码组织

### 5.1 Bundle 布局（遵循 [publish.md](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）

```
dsh-plugin-herdr/
├── package.json              # dsh.bundle manifest + prepare 脚本
├── cordis.patch.yml          # 插件行：name: dsh-plugin-herdr
├── tsconfig.json
├── scripts/
│   └── gen-types.mjs         # herdr api schema --json → src/client/types.ts
├── src/
│   ├── index.ts              # apply(ctx)：装配 Config / 服务 / 工具 / 事件
│   ├── config.ts             # Config 接口 + Schema
│   ├── client/
│   │   ├── index.ts          # HerdrClient 服务（抽象接口 + 工厂）
│   │   ├── cli.ts            # CliAdapter
│   │   ├── socket.ts         # SocketAdapter（M2）
│   │   └── types.ts          # 生成：协议请求/响应/事件类型
│   ├── tools/
│   │   ├── shared.ts         # 公共渲染、错误归类、参数校验助手
│   │   ├── snapshot.ts       # herdr_snapshot
│   │   ├── agent-list.ts     # herdr_agent_list
│   │   ├── agent-wait.ts     # herdr_agent_wait
│   │   ├── pane-run.ts       # herdr_pane_run
│   │   ├── pane-read.ts      # herdr_pane_read（M2）
│   │   └── ...               # 扩展工具（§8.3）
│   ├── jobs.ts               # 等待类工具的后台 producer
│   └── events/
│       ├── forward.ts        # Herdr → Cordis 事件转发（M2）
│       └── state-report.ts   # DSH → Herdr 状态上报（M3）
└── test/
    ├── unit/                 # client 适配器（fixture JSONL）、参数校验
    ├── integration/          # 真实 herdr 的端到端（CI 可选）
    └── fixtures/
        └── herdr-api.schema.json   # 生成时快照，用于离线测试
```

### 5.2 关键文件示例

`package.json`（核心字段）：

```jsonc
{
  "name": "dsh-plugin-herdr",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "scripts": {
    "prepare": "tsdown",          // git 安装时自构建（turtle-ui 模式）
    "gen:types": "node scripts/gen-types.mjs"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "devDependencies": { "typescript": "^5", "tsdown": "^0.x" },
  "dependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-jobs": "*",
    "@deepseek-ai/schemastery": "*"
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-plugin-herdr
      name: dsh-plugin-herdr
```

### 5.3 服务注册（`client/index.ts` 骨架）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    herdr: HerdrClient
  }
}

export abstract class HerdrClient extends Service {
  constructor(ctx: Context) {
    super(ctx, 'herdr')
  }

  /** 会话快照（session.snapshot 等价物）。 */
  abstract snapshot(): Promise<HerdrSnapshot>
  /** 列出 agent。 */
  abstract listAgents(filter?: AgentFilter): Promise<HerdrAgentInfo[]>
  /** 在 pane 运行命令并（可选）等待输出。 */
  abstract runCommand(req: RunCommandRequest): Promise<RunCommandResult>
  /** 等待 pane 的 agent 达到目标状态。 */
  abstract waitAgent(req: WaitAgentRequest, signal: AbortSignal): Promise<WaitAgentResult>
  // ... 扩展方法（M2+）
}
```

---

## 6. 配置设计

### 6.1 Config 接口与 Schema

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** herdr CLI 可执行文件（默认 PATH 查找；可给绝对路径）。 */
  cliPath: string
  /** 显式 socket 路径；缺省按 HERDR_SOCKET_PATH → 默认配置目录解析。 */
  socketPath?: string
  /** 目标会话名；缺省为默认会话。 */
  session?: string
  /** 传输层：cli（默认）| socket。 */
  transport: 'cli' | 'socket'
  /** 单次同步请求的默认超时（ms）。 */
  timeoutMs: number
  /** 是否允许工具暴露 run_in_background 参数（后台任务闸门）。 */
  allowBackground: boolean
  /** 事件订阅转发（Herdr → DSH）。 */
  events: {
    enabled: boolean
    /** 断线重连最大退避（ms），默认 30000。 */
    maxReconnectMs: number
  }
  /** M3：是否启用 DSH → Herdr 状态上报（仅 HERDR_ENV=1 时生效）。 */
  reportState: boolean
}

export const Config: Schema<Config> = Schema.object({
  cliPath: Schema.string().default('herdr'),
  socketPath: Schema.string().optional(),
  session: Schema.string().optional(),
  transport: Schema.union(['cli', 'socket']).default('cli'),
  timeoutMs: Schema.number().min(1000).max(600000).default(30000),
  allowBackground: Schema.boolean().default(false),
  events: Schema.object({
    enabled: Schema.boolean().default(false),
    maxReconnectMs: Schema.number().default(30000),
  }),
  reportState: Schema.boolean().default(true),
})
```

### 6.2 设计原则（对齐 [config.md](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)）

- **无硬编码可调参数**：socket 路径、会话、超时、CLI 路径全部可配置。
- **配置错误要响亮**：非法枚举（transport）、越界超时在加载期失败。
- **环境探测顺序**（socketPath）：显式配置 > `HERDR_SOCKET_PATH` > `~/.config/herdr/herdr.sock`
  （POSIX；Windows 为 named pipe，不做路径猜测，走 CLI 适配器），会话名同理（`HERDR_SESSION`）。
- **CLI 解析顺序**（cliPath）：显式配置 > `HERDR_BIN_PATH`（Herdr 注入 pane/插件进程的变量，官方推荐）> PATH 中的 `herdr`。
- **HMR**：配置变更触发插件热替换，所有注册均为 effect，自动清理（长连接随之断开重连）。

### 6.3 用户配置示例

```yaml
- insert:
    - id: dsh-plugin-herdr
      name: dsh-plugin-herdr
      config:
        transport: cli
        timeoutMs: 60000
        allowBackground: true
        events:
          enabled: true
```

---

## 7. HerdrClient 服务（传输层）

### 7.1 CLI 适配器（`client/cli.ts`）

- 执行 `ctx.shell` 之外的**进程内** `node:child_process.spawn`（插件代码，不受模型沙箱约束），
  或复用 `ctx.shell.run`（进程内调用，可带 `stdoutMaxBytes`/`signal`）。
- 命令模板（M1 用到的子集）：

  | 用途 | 命令 |
  |---|---|
  | 快照 | `herdr api snapshot`（JSON） |
  | agent 列表 | `herdr agent list`（实测输出即 JSON envelope；备选：`herdr api snapshot` 派生） |
  | pane 运行 | `herdr pane split <id> --direction right` + `herdr pane run <id> "<cmd>"` |
  | 读输出 | `herdr pane read <id> --source recent --lines <n>` |
  | 等待 | `herdr agent wait <id> --until <state>`（`--until` 可重复、`--timeout <MS>`，默认无限） |
  | pane 输出等待 | `herdr pane wait-output --match <text> --timeout <MS> <id>` |
  | 协议 schema | `herdr api schema --json`（仅生成/校验时） |

- **结构化解析**：所有命令优先请求 JSON 输出；文本输出用稳定标记切分。
- **会话透传**：配置了 `session` 时，所有命令追加 `--session <name>`（Herdr 解析顺序：CLI flag > `HERDR_SESSION` > 默认会话）。
- **超时**：spawn 级 `timeoutMs`（默认来自 Config）；超时 kill 进程组并把超时作为规范值返回。
- ✅ **M0-01 已实测**（herdr 0.8.0 / protocol 19，详见 `docs/env-findings.md`）：`agent list` 无 `--json` 但输出即 JSON envelope；`agent wait` 支持 `--until`（可重复）与 `--timeout <MS>`；pane 输出等待为 `herdr pane wait-output`（`--match`/`--regex` + `--timeout <MS>`）。

### 7.2 Socket 适配器（`client/socket.ts`，M2）

- 传输：Unix domain socket / Windows named pipe；每行一个 JSON（JSONL）。
- 请求：`{ "id": "req_<n>", "method": "...", "params": {...} }`；
  响应按 `id` 匹配 Promise；`events.subscribe` 后同连接收到订阅事件（按 `type` 分发）。
- 连接生命周期：惰性连接（首次调用建立）；`ctx.effect` 关闭；断线重连退避。
- 方法名与参数直接由生成类型驱动（`client/types.ts`），不重复维护清单。

### 7.3 方法封装（服务层 API）

| 方法 | 底层 | 说明 |
|---|---|---|
| `ping()` | `ping` / `herdr status` | 健康检查，失败时给出诊断（见 §11） |
| `snapshot()` | `session.snapshot` | 一次性引导快照（含焦点、workspace/tab/pane/agent 记录） |
| `listAgents(f?)` | `agent.list`（CLI 传输下由 `snapshot()` 派生） | 按 workspace/status 过滤 |
| `runCommand(req)` | split + send_text + `wait_for_output` | 支持复用已有 pane |
| `waitAgent(req, signal)` | `agent.wait` | 事件驱动；`signal` 取消 |
| `readPane(id, n)` | `pane.read` | 增量读取 |
| `sendKeys(id, keys)` | `pane.send_keys` | M2 |
| `layoutExport/Apply` | `layout.export/apply` | M2 |
| `showNotification(...)` | `notification.show` | M2 |
| `subscribeEvents(handler)` | `events.subscribe` | M2，事件转发用 |

---

## 8. 工具设计

### 8.1 设计原则

1. **规范 JSON 输出**：每个工具返回结构化值（句柄、字段、状态），人类可读文本只进 `render`；
   Code Mode 下 `tools.herdr_*(args)` 直接拿到规范值。
2. **参数类型化**：`parameters` 用 DSL 表达（枚举、嵌套对象、必填）；拒绝非空字符串、跨字段约束
   在 `execute` 内手检（DSL 不表达的部分）。
3. **信号合规**：`execute` 内所有等待观察/转发 `exec.signal`；后台分支改用 task-owned signal（§9）。
4. **卡片分离**：`presentCall`/`presentResult` 纯函数；pane 类工具用 `terminal` 卡片，
   查询类用 `generic` 卡片（§13）。
5. **工具粒度**：一个 Herdr 方法族一个工具，不合并成巨型工具；描述里写清 pane id 语法（`w1:p1`）。

### 8.2 MVP 工具明细（M1 交付）

#### 8.2.1 `herdr_snapshot`

| 项 | 内容 |
|---|---|
| description | 获取 Herdr 会话快照：workspace/tab/pane/agent 记录、焦点、协议版本。 |
| parameters | `{}`（可选：`session?: string` 覆盖配置中的会话名） |
| output.schema | `{ type: 'json' }`（协议结构由 Herdr 拥有，不做重复建模） |
| render | 文本摘要：焦点 pane、各 workspace 的 pane 数与 agent 状态计数、连接健康度 |
| UI 卡片 | `generic`（title: "Herdr snapshot"） |
| 错误 | 连接失败/CLI 缺失 → 抛错（`HERDR_UNAVAILABLE`） |

#### 8.2.2 `herdr_agent_list`

| 项 | 内容 |
|---|---|
| description | 列出 Herdr 检测到的 agent 及其语义状态（working/blocked/done/idle/unknown）。 |
| parameters | `workspace_id?: string`；`status?: enum[working, blocked, done, idle, unknown]` |
| output.schema | `{ type: 'array', items: { type: 'object', additionalProperties: true, properties: { pane_id: string, workspace_id: string, agent: string, status: string, message?: string, foreground_cwd?: string } } }` |
| render | 等宽表格：pane | agent | status | message |
| UI 卡片 | `generic`（kind: `search` 不适用；用默认） |

#### 8.2.3 `herdr_pane_run`

| 项 | 内容 |
|---|---|
| description | 在 Herdr pane 中运行 shell 命令：可新建 split pane 或复用已有 pane；前台等待输出。 |
| parameters | `command: string (required)`；`pane_id?: string`（复用；缺省新建）；`workspace_id?: string`；`direction?: enum[right, down]`（默认 right）；`ratio?: number`（0.1–0.9）；`cwd?: string`；`env?: { type:'object', additionalProperties:true, items:{type:'string'} }`；`wait_ms?: number`（默认配置 timeoutMs）；`run_in_background?: boolean`（受 `allowBackground` 闸门，缺省 false） |
| output.schema | oneOf：`{ kind:'completed', pane_id, exit_code: number\|null, output: string, truncated: boolean, timed_out?: boolean }` \| `{ kind:'background', jobId: string }` |
| render | completed：exit 状态标记 + 输出；background：`started background job herdr-<n>` 人话 |
| UI 卡片 | `terminal`（title = command；output = 输出正文；exit 状态 pill） |
| 实现（M1 实测） | 复用 pane：CLI `pane run <id> sh -c <cmd>`（argv 语义，无 shell 注入）；新建：`pane split` → 同上；`pane run` 异步无输出，前台用轮询 `pane read --source visible`（500ms 间隔，静默 ≥1.5s 判定完成）代替 `wait-output` 精确匹配（M2 增强）；超时返回 `{kind:'completed', ..., timed_out:true}`（领域结果，不抛错） |

#### 8.2.4 `herdr_agent_wait`

| 项 | 内容 |
|---|---|
| description | 等待目标 pane 的 agent 达到指定状态（如 done）；支持后台化。 |
| parameters | `target: string (required)`（pane id 或 agent 名）；`until: AgentStatus[] (required)`（可多状态：idle/working/blocked/done/unknown，默认语义对齐 CLI）；`timeout_ms?: number`（默认配置 timeoutMs，上限 10 分钟）；`run_in_background?: boolean`（受闸门） |
| output.schema | oneOf：`{ kind:'completed', pane_id, agent, status, message?, waited_ms }` \| `{ kind:'timeout', pane_id, agent, status?, waited_ms }` \| `{ kind:'not_found', target }` \| `{ kind:'background', jobId }` |
| render | completed：`agent <name> is done (waited 12s)`；timeout：提示当前状态与可重试建议 |
| UI 卡片 | `generic`（title: "Wait for agent"） |
| 实现 | 前台：`agent.wait` 带 `AbortSignal`（来自 `exec.signal` + 自身超时）；后台：§9 producer |

### 8.3 扩展工具清单（M2+，非承诺范围）

| 工具 | 底层方法 | 说明 |
|---|---|---|
| `herdr_workspace_create` | `workspace.create` | `--cwd --label`，agent 常用入口 |
| `herdr_pane_split` | `pane.split` | 显式分裂，返回 pane_id |
| `herdr_pane_send_keys` | `pane.send_keys` | 按键串（`ctrl+c` 等） |
| `herdr_pane_read` | `pane.read` | 增量读 + scroll 指标（at-bottom） |
| `herdr_pane_layout` | `pane.layout` / `layout.export` | 布局快照/导出 |
| `herdr_layout_apply` | `layout.apply` | 声明式恢复标签/cwd/argv |
| `herdr_agent_prompt` | `agent.prompt` | 提交输入并等待（带 until+timeout） |
| `herdr_agent_explain` | `agent.explain --json` | 检测归因诊断 |
| `herdr_agent_send_keys` | `agent.send_keys` | 给 agent 发按键 |
| `herdr_notification` | `notification.show` | 向用户弹通知 |
| `herdr_integration_manage` | `integration.install/uninstall` + `integration status` | 管理官方集成 |
| `herdr_plugin_invoke` | `plugin.action.invoke` | 调用已安装 Herdr 插件的 action（跨生态桥） |

---

## 9. 后台任务设计

### 9.1 何时后台化

- 满足任一条件时工具应提供后台分支：
  - 预期等待 > 30s（`agent.wait` 直到 done）；
  - 命令本身是长驻进程（dev server、watch、测试套件）。
- 前台/后台由模型参数决定，但参数可见性由 `allowBackground` 配置闸门控制。

### 9.2 producer 契约（对齐 `dsh-jobs` 的 `JobStart`）

```ts
ctx.jobs.start({
  kind: 'herdr',                          // id 前缀：herdr-1, herdr-2 ...
  label: `herdr wait ${target} until ${until}`,
  owner: exec.agent,                      // 会话围栏 + 所有者清理
  run: () => {
    const controller = new AbortController()
    const outcome = waitAgent({ target, until }, controller.signal)   // 真实等待
      .then<JobOutcome>(result => ({
        status: 'completed',
        detail: `waited ${result.waited_ms}ms`,   // JobOutcome: { status, detail?, output? }
        output: renderWaitResult(result),         // 模型可读的最终文本
      }))
      .catch(err => ({ status: 'failed', detail: String(err) }))
    return {
      cancel: (reason) => controller.abort(reason),   // 同步、幂等
      done: outcome,                                   // 资源释放后才 settle
      readOutput: () => formatDelta(resultSoFar),      // 可选：增量输出
    }
  },
})
```

### 9.3 语义要点

- **取消链路**：`job_kill` → producer `cancel` → `AbortSignal` → `agent.wait` 服务端取消；
  `done` 在 Herdr 调用真正 settle 后才 resolve。
- **前台与后台共用同一 `waitAgent` 实现**：前台传 `exec.signal`，后台传 task-owned signal；
  避免两套等待逻辑漂移。
- **结果获取**：后台分支的最终结果经任务完成通知送达模型；模型也可用通用 job 工具（`job_list` / `job_output`）按 `jobId` 读取最终输出与状态。
- **通知**：任务完成时通用通知机制自动送达模型；`readOutput` 提供增量（后台 pane 命令场景）。
- **teardown**：插件卸载/所有者销毁时 `ctx.jobs` 取消并等待在途任务，producer 必须合规 settle。

---

## 10. 事件集成设计（双向）

### 10.1 Herdr → DSH（`events/forward.ts`，M2）

- 开启条件：`events.enabled === true` 且传输层可用。
- 订阅：socket 适配器 `events.subscribe`（长连接）；CLI 传输下退化为轮询
  `session.snapshot` + diff（低频固定间隔 5s——仅作兜底，不推荐）。
- 命名空间与类型（`declare module '@deepseek-ai/cordis'`）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Herdr 中某 agent 状态变化。 */
    'herdr/agent-state'(info: { paneId: string; agent: string; status: HerdrAgentStatus; message?: string }): void
    /** Herdr 资源集变化（workspace/tab/pane 增删改），载荷为变化的资源 id。 */
    'herdr/resource-changed'(change: { type: 'workspace' | 'tab' | 'pane'; action: 'created' | 'updated' | 'closed'; id: string }): void
    /** 事件订阅通道健康状态。 */
    'herdr/channel'(state: 'connected' | 'disconnected' | 'reconnecting'): void
  }
}
```

- 事件名遵循 `namespace/action` 约定（对齐 Cordis 事件命名）。
- 生命周期：effect 注册；断线重连（指数退避，上限 `events.maxReconnectMs`）；插件卸载即断开。

### 10.2 DSH → Herdr（`events/state-report.ts`，M3）

- 激活条件：`reportState === true` 且 `process.env.HERDR_ENV === '1'`（ADR-6）。
- 输入：DSH 会话事件（`session/event` 中 `turn/*`、`step/*`、`agent/request*`）或
  Cordis `agent/step` 等，映射：

  | DSH 状态 | Herdr 状态 | 上报时机 |
  |---|---|---|
  | 开始处理请求 | `working` | `agent/request` 开始 |
  | 等待用户输入/审批 | `blocked` | 等待审批点（若可观测） |
  | 一轮完成 | `done` | 回合结束、空闲 |
  | 会话空闲 | `idle` | 长时间无活动 |

- 上报：`pane.report_agent({ pane_id: process.env.HERDR_PANE_ID, source: 'dsh:herdr-plugin', agent: 'dsh', state, message: <一步摘要> })`；
  `pane.report_metadata` 可选补充 `title`/`tokens`（模型名等），带 `ttl_ms`。
- 清理：插件卸载时 `pane.clear_agent_authority`（若拥有 authority）或停止刷新 TTL。
- 注意：上报是**展示性**的，不影响 Herdr 的等待/通知语义（语义状态由 Herdr 侧权威决定），
  文档中明确此边界。

---

## 11. 错误处理与诊断

### 11.1 错误分类与工具行为

| 类别 | 例子 | 工具行为 |
|---|---|---|
| 配置错误 | CLI 路径不存在、transport 枚举非法 | 加载期 schema 校验失败（响亮失败） |
| 连接/环境错误 | `herdr` 未安装、server 未启动、socket 不存在 | 抛错（`HERDR_UNAVAILABLE`），render 提示 `herdr status` 诊断 |
| 目标不存在 | pane/workspace/agent id 无效 | 规范值 `{ status:'not_found', ... }`（ADR-3） |
| 超时 | `wait_ms` / `timeout_ms` 到期 | 规范值 `{ kind:'timeout' | timed_out:true }`，附当前观测状态 |
| 协议错误 | 响应形状与生成类型不符 | 抛错（`HERDR_PROTOCOL`），记录原始响应便于上报 |
| 权限/闸门 | `run_in_background` 被配置禁用 | 参数不可见（模型不会生成），不做运行时拒绝 |

### 11.2 重试策略

- **可重试**（幂等读）：`snapshot`、`agent_list`、`pane_read` —— 连接瞬断时自动重试 1 次。
- **不可重试**（写/副作用）：`pane_run`、`send_keys`、`layout_apply` —— 不自动重试，返回错误。
- 重试只发生在**请求发出前**的失败（spawn 失败、连接拒绝）；发出后的失败一律如实返回。

### 11.3 诊断辅助

- 工具错误信息里附命令原文与退出码（对齐 DSH bash 工具的 `[exit code: N]` 惯例）。
- 提供 `herdr_agent_explain`（M2）帮助模型/用户理解 agent 检测归因。
- 日志：插件内 `console` 前缀 `[dsh-plugin-herdr]`；关键请求/响应调试级输出。

---

## 12. 安全与权限

1. **进程权限边界**：插件代码运行在 harness 进程内（与 harness 同权限），**不是**模型 bash
   工具的沙箱上下文。因此工具层必须自我约束：只暴露白名单方法、参数严格校验
   （拒绝任意 shell 拼接——命令作为单参传给 `herdr pane run`，由 Herdr 执行，插件不拼 shell）。
2. **不绕过沙箱**：本插件不改变、不放松 DSH 对模型 bash 工具的沙箱策略；它提供的是
   Herdr 控制面的独立通道，与 bash 沙箱正交。
3. **socket 路径校验**：显式配置的 `socketPath` 只允许绝对路径；日志中不打印 socket 内容。
4. **后台任务闸门**：`allowBackground` 默认关闭（§4 ADR-4），部署方显式开启。
5. **事件订阅隐私**：`events.enabled` 默认关闭；事件载荷只转发结构化字段，不透传原始终端内容
   （pane 内容默认不转发，需要时由 `herdr_pane_read` 显式读取）。
6. **包分发信任**：git 安装要求用户对 `prepare` 脚本显式授权（`pnpm-workspace.yaml`
   `allowBuilds`），README 说明；建议发布 npm 或 tarball 免构建授权路径。
7. **内容持久化边界**：`herdr_pane_run` / `herdr_pane_read` 的输出会作为工具结果进入
   DSH 会话日志（tool/result 持久化）。工具描述提示模型"pane 输出可能含敏感信息"；
   密钥/令牌不得经 `env` 参数传入 pane 命令。

---

## 13. UI 呈现设计

| 工具 | pending 卡片 | 完成卡片 |
|---|---|---|
| `herdr_pane_run` | `terminal`（title=command，description=目标 pane/workspace） | `terminal`（输出正文 + exit 状态 pill） |
| `herdr_agent_wait` | `generic`（title="Wait for agent"） | `generic`（内容=结果摘要；timeout 状态含当前观测） |
| `herdr_agent_list` | `generic` | `generic`（内容=表格文本） |
| `herdr_snapshot` | `generic` | `generic`（内容=摘要） |

- 卡片纯函数约束：`presentCall` 只依赖 `args`；`presentResult` 依赖 `args` + 持久化
  `result.meta`（若需要结果期事实，用 `output.presentationMeta` 投影）。
- 输出正文与卡片内容分离：模型结果（render）不含 UI 专用格式（如 ```console 围栏）。

---

## 14. 测试与验证

### 14.1 单元测试（离线，无 Herdr）

- `client/cli.ts`：mock `spawn`，断言命令构造、JSON 解析、超时 kill、错误归类。
- `client/socket.ts`：fixture JSONL 流（`test/fixtures/herdr-api.schema.json` + 录制响应），
  断言请求/响应 id 匹配、订阅事件分发、断线重连。
- 工具层：参数校验（必填/枚举/跨字段）、规范值形状（oneOf 分支）、render 纯函数。
- `jobs.ts`：producer cancel 幂等、done 在取消后 settle、readOutput 增量。

### 14.2 集成测试（需要真实 herdr，CI 可选）

验收脚本 `test/integration/run.sh`（对已启动的 herdr 默认会话）：

1. `herdr_snapshot` 返回非空 workspace 列表；
2. `herdr_pane_run { command: 'echo hello-herdr' }` → 输出含 `hello-herdr`；
3. `herdr_agent_list` 在 pane 中启动 `herdr` 支持的 agent 后能看到状态变化（⚠️ 需要真实 agent 凭据；CI 中跳过或标记 optional）；
4. `herdr_agent_wait { target, until: 'done' }` 前台与后台（`allowBackground: true`）两条路径；
5. 事件订阅开启后，`herdr/resource-changed` 在 split 新 pane 时触发。

### 14.3 手动验证（加载到 Web UI）

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml   # 开发期
# 或
dsh plugin --profile demo add ./dsh-plugin-herdr && dsh --profile demo
```

聊天内依次调用四个 MVP 工具，观察卡片渲染与规范值。

### 14.4 验收标准（M1）

- [ ] 插件在 `dsh web --patch` 下加载，无 schema 校验错误；
- [ ] 4 个 MVP 工具注册且 `schemas()` 输出正确；
- [ ] 连接缺失时错误信息给出可操作诊断；
- [ ] 所有工具通过 `exec.signal` 取消测试（模拟中途停止）。

---

## 15. 里程碑

| 阶段 | 内容 | 交付物 | 依赖 |
|---|---|---|---|
| **M0 脚手架** | bundle 骨架、Config、空工具注册、加载验证（HMR） | 可加载的空插件 + 本文档评审 | — |
| **M1 MVP** | CLI 适配器 + 4 个 MVP 工具（前台）+ 卡片 + 单元测试 | 可用的观察/控制/等待闭环 | M0 |
| **M2 进阶** | socket 适配器、后台任务（jobs）、事件订阅转发、扩展工具集 | 长连接订阅 + 后台等待 + layout/keys/notification | M1 |
| **M3 双向** | `HERDR_ENV` 状态上报、`report_metadata` 增强 | Herdr 侧边栏可见 DSH 状态 | M2 |
| **M4 发布** | 集成测试补全、README、类型生成脚本固化、npm/git 分发验证 | 可安装发布 | M3 |

---

## 16. 风险与开放问题

| # | 风险/问题 | 影响 | 缓解 |
|---|---|---|---|
| 1 | Herdr 协议演进（preview） | 类型/方法漂移 | `herdr api schema` 生成 + 版本快照 + 加载期兼容警告 |
| 2 | Windows named pipe 的 raw 客户端复杂度 | socket 适配器成本 | CLI 适配器为默认；socket 仅 POSIX 声明支持（文档注明） |
| 3 | 长连接资源泄漏/重连风暴 | 事件订阅稳定性 | effect 清理、指数退避、`herdr/channel` 事件可见 |
| 4 | `agent.wait` 在服务端取消后的竞态 | 后台任务悬挂 | task-owned signal + `done` 必须 settle 的 producer 契约 + 集成测试 |
| 5 | `allowBackground` 误开导致任务堆积 | 资源占用 | 默认关闭；文档写明任务生命周期与 `job_kill` |
| 6 | Herdr CLI 输出格式变化 | CLI 解析失败 | 结构化输出优先 + 解析失败归类为 `HERDR_PROTOCOL` 并附原始输出 |
| 7 | 状态上报的语义权威（Herdr 与 DSH 状态机不一致） | 侧边栏误导 | 只报展示性元数据，文档明确边界（§10.2） |
| 8 | ~~开放~~ **已关闭（M0-01 实测）**：`agent.wait` 支持 `until: AgentStatus[]` 多状态 + 可空 `timeout_ms`（CLI：`--until` 可重复 + `--timeout <MS>`） | — | 见 docs/env-findings.md |

---

## 17. 参考资料

- DSH：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>（第一个插件 / tool / config / publish）、
  <https://deepseek-harness.github.io/deepseek-harness/develop/framework/>（service / events）、
  <https://deepseek-harness.github.io/deepseek-harness/develop/practice/>（能力分层）
- DSH 包：`@deepseek-ai/dsh-tools`（defineTool / ToolRuntime / 事件管线）、
  `@deepseek-ai/dsh-shell`（ShellExecRequest / ShellProcess）、
  `@deepseek-ai/dsh-jobs`（JobStart / JobHooks）、`@deepseek-ai/dsh-agent`
- Herdr：<https://herdr.dev/agent-guide.md>、<https://herdr.dev/docs/socket-api/>、
  <https://herdr.dev/docs/cli-reference/>、<https://herdr.dev/docs/agents/>、
  <https://herdr.dev/docs/integrations/>；skill 文件
  <https://raw.githubusercontent.com/herdrdev/herdr/master/skills/herdr/SKILL.md>

---

## 18. M5 补充：Herdr 监控面板（Web UI 视图 Tab）

> 用户新增需求（对话确认）：在"对话/轨迹"右侧视图 Tab 中新增 **Herdr** 视图，
> 分块实时显示所有 Agent（含 dsh）的状态与只读输出，非终端样式。

### 架构

```
浏览器 (conversation.view slot: herdr Tab)
   │  轮询 GET /herdr-status（2s）
   ▼
dsh web server ── webServer.register() 路由（dsh-host-webserver）
   │
HerdrStatusTracker（服务端，消费者插件内）
   ├─ 轮询 agent.list（2s）→ 状态（agent_status 归一化）
   ├─ 轮询 pane.read（2s）→ 输出缓冲（visible 快照，8KB 上限）
   └─ 事件加速：herdr/agent-state、herdr/resource-changed（可选）
```

### 组件

- 服务端：`src/status.ts`（tracker）、`/herdr-status` 路由（consumer 内 ctx.inject(['webServer'])）
- 客户端：`src/client.tsx`（HerdrView + AgentBlock，conversation.view 注册 id:'herdr' order:20）
- 构建：tsdown 双配置（node entry + web entry browser/jsx/external）；bundle 以包名安装（dsh plugin add）使 client bundle 进入 boot 图

### 已实现

✅ /herdr-status 端点（实抓验证：状态上报后快照含 agent） ✅ client bundle 进入 __DSH_BOOT__（/plugins/dsh-plugin-herdr/client.js 200） ✅ 输出轮询 ✅ 40/40 单测 + 集成全过

### 待验证

- 浏览器刷新后 "Herdr" 视图 Tab 出现并渲染 agent 分块（需用户确认）
- 面板样式后续可迁移 dsh-client-ui-primitives（当前内联样式）

---

## 19. 补充：Herdr Skill 注入会话

启用插件即向会话 skill 目录注册官方 SKILL.md（v0.8.0 内嵌快照）：
- 注册 API：`ctx.skills.register({name: 'herdr', description, content})`（ctx.inject(['skills']) 等待，headless 跳过）
- 内容内嵌：`scripts/embed-skill.mjs` 把 `src/assets/herdr-skill.md` 编译为 TS 字符串模块（JSON 字面量免转义）
- 模型侧：会话请求时 skill 目录含 herdr（description 匹配触发加载）；加载后获得完整的 Herdr CLI 操作指南
- 验证：真实环境日志确认注册；单测覆盖内容与 frontmatter 解析

---

## 20. herdr 模式（M6）：新建会话时的模式开关

用户可在"新建会话"的模式选择器中直接选择 **Herdr 模式**：开启后对话本身就是
Herdr 里的对话（agent 绑定 Herdr，状态实时上报 Herdr 侧边栏），而不是从会话里
再开启 herdr。实现走 DSH 的 **agent preset** 机制，与 M3 的 HERDR_ENV 上报互补：

| 维度 | M3 HERDR_ENV 上报 | M6 herdr 模式（preset） |
| --- | --- | --- |
| 触发 | DSH 进程跑在 Herdr pane 内（环境变量） | 新建会话时选择预设（无进程约束） |
| 绑定 | HERDR_PANE_ID 环境变量 | config.paneId 或自动取焦点 pane |
| 载体 | 消费者插件 index.ts | preset 组合里的 session-mode 插件 |
| 状态 | working/idle 上报 | 同（agent/request→working，turn-stopping→idle） |

### 架构

- `presets/herdr/agent.cordis.yml`：preset 组合（persona 行 + session-mode 行）
- `presets/herdr/preset.yml`：选择器展示名（Herdr 模式）
- `src/preset-install.ts`：ensureHerdrPreset() 把 preset 复制到
  `$DSH_HOME/.agent-presets/herdr/`（幂等，存在 marker 即跳过）
- 安装时机：provider 插件（client-entry）apply 时调用一次
- `src/session-mode.ts`：会话插件 dsh-plugin-herdr-session-mode
  （inject ['herdr']）：绑定 pane → 初始 idle 上报；agent/request（waterfall）
  → working；agent/turn-stopping → idle；卸载时 clearAgentAuthority
- preset 发现：@deepseek-ai/dsh-agent-presets 每次 list() 重读
  `.agent-presets/` 根，无需重启；web 组合自带
  dsh-client-ui-agent-preset（模式选择器卡片）

### 构建

- package.json：新增 ./session-mode export（lib/session-mode.mjs）；files 含 presets
- tsdown：entry 增加 src/session-mode.ts（与主插件同包，preset 按包名
  dsh-plugin-herdr/session-mode 解析）

### 验证

✅ preset 自动安装（服务器日志 + .dsh-home/.agent-presets/herdr/ 落盘）
✅ web 组合含 agent-presets 服务 + 选择器 UI（dsh --dump-config）
✅ preset 形状合法（id 匹配 /^[a-z0-9][a-z0-9-]*$/、行引用真实插件名）
✅ dsh-plugin-herdr/session-mode 从 profile 解析（name=session-mode 插件）
✅ 单测 47+3 全过（preset-install 幂等/路径/内容）
待用户确认：新建会话对话框出现 "Herdr 模式" 卡片，选择后侧边栏显示本会话状态。

---

## 21. herdr 服务启动看板（M7）：新建会话 + 会话页面

需求：新建会话与会话页面都应有"检查 herdr 服务是否已启动"的看板；未启动时提供启动按钮。

### 服务端（src/status.ts + src/index.ts）

- `probeServer(cliPath)`：`herdr status server --json` → HerdrServerInfo
  （status/running/version/protocol/socket/session；失败降级 unknown）；execFn 可注入
- `startHerdrServer(cliPath)`：spawn `herdr server`（headless daemon，detached+unref），
  轮询 probeServer 直到 running（默认 15s 超时）；并发调用共享同一启动；
  已运行时直接返回；spawn 失败立即 reject
- tracker 每 2s 轮询一次 server 状态；snapshot.connected = CLI 可用 && server.running
- GET /herdr-status 返回新增 `server` 字段；新增 POST /herdr-start
  （webServer.register，handler 异步，返回 {ok, server}）

### 客户端（src/client.tsx）

三个注册面（全部走官方 slot，无 DOM 注入）：

| 位置 | slot | 形态 |
| --- | --- | --- |
| 会话页 Herdr Tab 顶部 | conversation.view（已有） | 完整看板条：运行中（绿）/ 未启动（琥珀 + 启动按钮）/ CLI 未安装（灰） |
| 会话页 header | conversation.session.header.actions（list） | 状态胶囊：herdr 运行中 / 未启动 + 启动按钮 |
| 新建会话（hero 相位） | shell.overlay（list, root） | 右上浮层卡片，data-phase=hero 时显示 |

- 共享 hook：useHerdrStatus（2s 轮询 + refresh）、useHerdrStart（POST + 状态）
- overlay 层 CSS：pointer-events:none，直接子元素 auto → 卡片可点击

### 验证

✅ 单测 12 项（probeServer 解析/降级、startHerdrServer 已运行/轮询成功/spawn 失败/超时）
✅ E2E：herdr server stop → GET 显示 not_running → POST /herdr-start
  → ok:true 且服务恢复（由 web 进程 spawn 成功）
✅ 客户端 bundle 含看板代码（rev 变化 + 字符串断言）
待用户确认：浏览器新建会话页面右上卡片、会话页 header 胶囊与 Herdr Tab 看板条

---

## 22. herdr 模式修正（M8）：会话成为 Herdr 的 pane

问题：开启 herdr 模式后，新建的 dsh 会话没有被作为 Herdr 的 pane（侧边栏无显示）。

### 根因（实测）

1. **agent preset 是 standing mount**：组合内插件在进程内只有一份实例，服务于所有
   加入该 preset 的 agent——旧实现把 paneId 当全局单例（apply 时取一次焦点 pane），
   多会话互相覆盖，且焦点 pane 为 null（headless 无焦点）时完全不绑定
2. `workspace.create` 的 CLI/socket 解析漏了 `result.root_pane.pane_id`
   （新 workspace 的根 pane），导致无焦点场景无法拿到 pane

### 修复

- `src/session-mode.ts` 重写：按 `payload.agent.id`（= session id）维护绑定
  Map；dsh-agent 事件（agent/created、agent/request、agent/turn-stopping、
  agent/disposed）经 scope 载体投递（standing scope 是 agent scope 祖先，
  自动收到其下所有 agent 的事件）
- 绑定策略：config.paneId 固定绑定 > 焦点 pane split（direction right）
  > workspace.create 的 root pane > 失败降级（日志，不阻断会话）
- agent/created → 绑定 + idle 上报；request → working；turn-stopping → idle；
  disposed/卸载 → pane.release-agent 释放 authority
- `src/client/{cli,socket}.ts`：workspaceCreate 解析 root_pane.pane_id
- `src/preset-install.ts`：内容同步（相同跳过；不同备份 .herdr-bak-<ts> 后覆盖），
  插件升级后已安装的 preset 自动更新（含 paneId/label 新配置）
- preset 组合新增 `label: dsh`（自动创建 workspace 时的标签）

### 验证（实抓）

✅ 单测 66 全过（session-mode 7 项：split 绑定/多会话隔离/固定 pane/workspace
  root pane/降级/disposed 释放/卸载释放；preset-install 更新语义 4 项）
✅ 真实环境：用户创建 herdr 模式会话 → 服务器日志
  `session-mode: agent session-<id> bound to new pane wB:p2 (split)`
✅ `herdr agent list` → wB:p2 agent=dsh status=idle；snapshot 显示 pane 标记 (dsh)

---

## 23. session log 分析与修复（M9）

分析 ~/session.jsonl（用户真实 herdr 模式会话：standard 创建 → 切换 herdr preset，
任务为启动 pi agent 打印 hello world，42 次工具调用 0 次工具层错误（2 个工具 bug））：

### 发现与修复

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| herdr_agent_prompt 报 INVALID_TOOL_OUTPUT | 返回对象含 `status: undefined`（lossless JSON 拒绝）；CLI envelope 状态在 `result.agent.agent_status` 而非顶层 | cli/socket 解析 agent_status，条件包含字段（真实验证返回 {submitted,status,waited_ms}） |
| herdr_layout_apply 在 CLI 下被调用即失败 | CLI 无 layout 命令，但工具仍注册 | transport=cli 时不注册 layout_apply（smoke 测试同步改 13 个工具） |
| pane_run 输出含大量终端历史噪音（30 次调用中反复出现旧输出） | pane.read visible 是**当前视口**（23 行，新输出顶掉旧行）；recent 是 scrollback | 读取切到 `--source recent`；执行前读基线快照，输出以基线为前缀时只保留新增（尾部提示符剥除后匹配）——真实验证：第二次运行输出仅含本次命令 |
| 专属 pane 累积（恢复会话每次 split 新 pane） | dispose 只释放 authority 不关 pane | 新增 `paneClose`：created 的 pane dispose/卸载时关闭；固定绑定仅 release（实测重启后旧 pane 自动清理） |

### pane.read 快照语义（实测）

- `--source visible`：当前视口（viewport_rows=23），长输出滚动时旧行被顶出——
  不适合作命令输出捕获
- `--source recent`：scrollback（10MB 上限），历史完整保留；配合基线裁剪
  拿到干净的本次输出
- 快照含 shell 提示符；命令执行后基线末尾的提示符位置变成命令回显
  （`❯\n` → `❯ sh -c ...`）——基线匹配必须先剥掉尾部提示符
- 终端 54 列折行：`echo FINAL-CLEAN` 显示为 `echo F\nINAL-CLEAN`——
  断言/解析需注意折行

### 会话日志观察

- 会话创建为 standard 后在 blank 窗口切换 herdr preset（agent-preset/selected 事件）
- 模型在**自动绑定的 pane**（wB:p2）上执行全部 herdr_pane_run——persona 引导生效
- 模型最终用 shell 直接跑 `herdr agent start pi --kind pi` 成功（agentPrompt 工具修复后
  可直接走工具）
- 单测 69 全过（新增 baseline 裁剪、agentPrompt lossless 回归）

---

## 24. workspace / pane 列表（M10）：DSH 设计系统落地

需求：以 DSH 真实 UI 适配 herdr 面板（原型 docs/prototype/herdr-panel.html 确认后落地）。

### 数据（服务端 src/status.ts）

- /herdr-status 新增 `topology`（workspaces → tabs → panes 层级，snapshot 提取）：
  workspace(label/active_tab_id)、tab(label/pane_count)、pane(title/cwd/
  foreground_cwd/focused/agent_status)；tracker 每 2s pollTopology
- agents 保持原有状态/输出缓冲（pane 的 agent 状态以 agents 为准）

### 视图（src/client.tsx）

- 组件全部来自 dsh-client-ui-primitives（真实 DSH 设计系统）：
  StateDot（working=ongoing 矩阵动画 / blocked=error / idle=done）、Pill（agent 名+状态）、
  Button（outline sm 刷新）、TerminalBlock（pane 输出：prompt/cwd/command/输出行/
  内置中文 labels，running 态显示 runState）
- 布局：视图头（sticky：标题+统计+刷新）→ 服务 banner → workspace 组（折叠）→ pane 行
  （StateDot+pane_id+焦点标记+Pill+cwd+时间+chevron）→ 展开 TerminalBlock
- 交互：workspace 折叠（Set 状态）、pane 展开（Set 状态）
- 样式全部使用真实 token（--dsw-alias-* / --dsw-static-* / --dsw-shadow-*），
  自动跟随深浅主题

### 构建

- tsdown.web external 增加 @deepseek-ai/dsh-client-ui-primitives
  （运行时由 web shell 的 ClientModuleLoader 提供，不打包）
- src/client-primitives.d.ts：ambient 声明（无顶层 import/export，否则被视为
  模块增强要求模块可解析）——本地编译期契约，与运行时版本解耦

### 验证

✅ 69 单测全过；bundle 25KB（primitives require external）
✅ /herdr-status 实抓返回 topology（workspaces/tabs/panes 完整）
✅ boot 图含 primitives（inject 依赖加载），client rev 更新，服务器日志无错误
待用户确认：浏览器 Herdr Tab 的列表渲染效果（组件/配色/交互）

---

## 25. 会话页右侧 pane 状态列表（M11）

需求：对话页面右侧展示 pane 状态 list（可折叠为 Herdr logo；本对话开始任务时自动展开）。

### 服务端

- `src/binding-registry.ts`：跨 bundle 共享绑定注册表——session-mode.mjs 与
  index.mjs 是独立构建入口，直接 import 会得到两份模块实例；用 globalThis 的
  Symbol.for 共享同一 Map
- session-mode：bind 成功后 registry.set(agentId → pane)；disposed/卸载时清理
- index.ts：GET /herdr-session-pane?agent=<sessionId> → {pane_id}
  （webServer handler 的 req 是 node:http IncomingMessage，用 new URL 解析 query）

### 客户端（src/client.tsx）

- 模块级共享轮询 store：useHerdrStatus 重构为单例订阅（一个 2s 轮询循环，
  多组件共享；无监听者时停止），banner/pill/hero/视图/面板不再各自轮询
- HerdrPaneList（shell.overlay 新 entry id herdr-pane-list，order 40）：
  - 会话页检测：conversation root 的 data-phase 存在且非 hero
  - 当前会话 id：apply 时 ctx.inject(['sessions'])（ui-preset 同款），
    组件定时读取 list.getSnapshot().current，变化时查 /herdr-session-pane
  - 列表：按 workspace 分组（可折叠），行 = StateDot + pane_id + agent +
    状态词；本对话 pane 高亮 + 「本对话」标签；纯终端 pane 显示「纯终端」
  - 折叠：面板头按钮 → 仅 Herdr logo 圆钮（2x2 窗格 SVG，一窗格品牌蓝）
  - 自动展开：轮询中检测本对话 pane 状态 working 边沿（非 working → working）
    且处于折叠 → 展开

### 验证

✅ 69 单测全过；端点实抓返回 {pane_id:"wB:p7"}（跨 bundle 注册表生效）
✅ client bundle 含面板代码（rev 更新）；/herdr-status 正常
待用户确认：浏览器会话页右侧面板渲染、折叠、任务自动展开

---

## 26. 面板拖动/跳转/官方 logo（M12）

需求：1) 面板与折叠按钮可拖动、松手吸附边界；2) 点击列表项跳转 Herdr Tab 定位对应 pane；
3) logo 使用 Herdr 官方 logo。

### 拖动 + 吸附（src/client.tsx useFloatingDrag）

- Pointer Events 实现（pointerdown 记录起点 → pointermove 位移 >4px 判定拖动 →
  pointerup 吸附）：水平吸附最近的左右边界（16px），垂直夹在视口内
- 面板与折叠圆钮共用位置 state（useFloatingDrag 各自持有但面板/圆钮同一组件内，
  折叠/展开保持位置）；拖动手柄 = 面板头部（cursor grab/grabbing）
- moved 标记区分点击与拖动（位移阈值，避免拖动触发点击）

### 点击列表项 → Herdr Tab 定位（focusPaneInHerdrTab）

- conversation.view 无公开 setView API（views 只有 list/subscribe/version）→
  模拟用户点击 header 的 Herdr tab（document.querySelectorAll('[role=tab]') 匹配文本）
- 定位：模块级 pendingFocusPane（视图未挂载时的时序兜底）+ CustomEvent
  herdr:focus-pane 广播；HerdrView 挂载时消费 pending、监听事件：展开全部
  workspace、展开目标 pane、scrollIntoView(nearest) + 蓝色 flash 动画
- pane 行与 Herdr 视图行均带 data-pane-id 供定位

### 官方 logo

- 来源 https://github.com/herdrdev/herdr/blob/master/assets/logo.svg（512×512，
  背景 #d9dad8 + 图形 #303438，无透明通道）
- 适配：剥掉背景 rect，图形 fill=currentColor（随主题取色：浅色主题深色图形、
  深色主题浅色图形）；折叠圆钮 22px、面板头 16px

### 验证

✅ 69 单测全过；构建通过；bundle 含新特性（16 处匹配）；重启后 pane 清理正常
待用户确认：拖动/吸附手感、跳转定位、logo 显示
