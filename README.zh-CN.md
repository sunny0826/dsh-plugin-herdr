# dsh-plugin-herdr

> [English](README.md) | **简体中文**

DeepSeek Harness（DSH）的 Herdr 控制面插件：在 DSH 会话中观察与驱动
[Herdr](https://herdr.dev)——面向 AI 编码代理的终端工作区管理器。

- **19 个 `herdr_*` 工具**：snapshot、agent list、agent start/wait/prompt/
  explain/send-keys、pane run/read/split/send-keys、workspace create/close/
  rename、pane close/rename、pane layout、layout apply、notification——
  全部走 Herdr socket 协议（Unix domain socket 上的 JSONL；CLI 传输已移除）。
- **Herdr Tab 与面板（会话聚焦）**：会话页的 Herdr Tab 与右侧悬浮 pane 列表
  **只显示当前会话的专属 workspace 及其 pane**。非 herdr 模式（未选择
  「Herdr 模式」预设）的对话完全不显示 Herdr Tab、面板与 header 状态胶囊。
- **herdr 模式（agent preset）**：新建会话时选择「Herdr 模式」——会话启动时
  在**项目目录创建专属 workspace**，本会话产出的所有 pane（split、agent）都
  放在这个 workspace 中，会话结束整个 workspace 一并回收。
- **开启真实 agent 执行任务**：`herdr_agent_start` 在会话 workspace 中启动
  编码 agent（pi / codex / claude）并等待 Herdr 识别就绪；用
  `herdr_agent_prompt` 提交任务、`herdr_agent_wait` 等待完成。
- **Server 看板**：检测 headless herdr server 运行状态，提供一键启动按钮
  （新建会话页与会话页）。

## 安装

前置条件：一个 DSH profile（如 `web`）以及运行中的 herdr headless server
（面板的启动按钮会从 PATH 中拉起 `herdr server`——这是仅存的 CLI 调用，
见「平台支持」）。

`dsh plugin` 是 pnpm 的薄转发层：在 profile 目录
（`$DSH_HOME/profiles/<名字>/`）内执行 `pnpm <参数>`，随后按实际安装结果
对账 `dsh.profile.bundles` 层列表——本包声明了 `dsh.bundle.patch`，
安装后即加入 profile 的 bundle 层（其 `cordis.patch.yml` 由此被应用）。

```sh
# 本地目录
dsh plugin --profile web add /path/to/dsh-plugin-herdr

# tarball（pnpm pack 产物）
pnpm pack
dsh plugin --profile web add ./dsh-plugin-herdr-*.tgz

# git
dsh plugin --profile web add github:sunny0826/dsh-plugin-herdr
```

> **pnpm allowBuilds**：git 安装会执行包的 `prepare` 脚本。若 pnpm 拦截，
> 将 pnpm 打印的 key 加入 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds`
> 后重试。

可用 `dsh plugin --profile web list`（或
`dsh plugin --profile web why dsh-plugin-herdr`）验证安装结果。

安装后重启 profile。插件注册 `ctx.herdr`、工具与 Herdr 面板；「Herdr 模式」
预设出现在新建会话的模式选择器中（首次加载时复制到
`$DSH_HOME/.agent-presets/herdr/`）。

## 卸载

从 profile 中移除插件——`dsh plugin ... remove` 转发 `pnpm remove`，
并同步把包从 `dsh.profile.bundles` 层列表中删除：

```sh
dsh plugin --profile web remove dsh-plugin-herdr
```

随后重启 profile：`herdr_*` 工具、`ctx.herdr`、Herdr 面板与 herdr 模式的
接线全部消失。

卸载会留下三处痕迹，可按需清理：

- **agent preset**——「Herdr 模式」预设已复制到
  `$DSH_HOME/.agent-presets/herdr/`，**不会**随卸载删除。它仍会出现在
  新建会话的模式选择器中，但没有插件支撑时只是个空壳；手动删除：
  `rm -rf "$DSH_HOME/.agent-presets/herdr"`。
- **Herdr workspace**——herdr 模式会话拥有专属 `dsh:<项目名>` workspace，
  会话结束时回收。卸载前先关闭进行中的 herdr 模式会话；残留的 workspace
  可用 herdr CLI 手工关闭（`herdr workspace list` /
  `herdr workspace close <id>`）。
- **profile 配置**——在 profile 的 `cordis.patch.yml` 里加过的 herdr 配置
  （如 `timeoutMs`）会变为无效条目；想要干净的 profile 请一并删除。

重新安装只需再走一遍「安装」：bundle 层会重新加入，首次加载时 preset
也会重新复制。

## 配置

| Key | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `socketPath` | string | – | herdr socket 路径（`HERDR_SOCKET_PATH`）；仅 POSIX |
| `session` | string | – | herdr 会话名（`HERDR_SESSION`） |
| `timeoutMs` | number | 30000 | 单条命令超时 |
| `allowBackground` | boolean | `false` | 是否暴露 `run_in_background` 参数（pane run） |
| `events.enabled` | boolean | `true` | 订阅 Herdr 事件（push 优先、poll 兜底） |
| `events.maxReconnectMs` | number | 30000 | 事件订阅重连上限 |
| `reportState` | boolean | `true` | 在 pane 内向 Herdr 上报 DSH→Herdr 状态（`HERDR_ENV`） |
| `projectRoot` | string | – | 服务端过滤用的项目目录；默认 `process.cwd()` |

新增面板端点：`GET /herdr-topology?lite=1` 返回 `{server, topology, filter, stale}`（不含 `agents[].output` 的轻量轮询）；`GET /herdr-agents/output?pane_ids=...` 按需拉取 pane 输出（懒加载，支持 `lines`/`format` 参数）。

预设配置（`presets/herdr/agent.cordis.yml` 的 `herdr-session-mode`）：

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `paneId` | `''` | 固定绑定 pane（所有会话共用）；留空 = 每个会话自动创建专属 workspace |
| `label` | `''` | 显示名覆盖；留空 = 优先会话标题（回退 `dsh:<项目名>-<会话短 id>`） |
| `cwd` | – | workspace 工作目录；留空 = 会话项目目录 |

输出上限（CA-014）：

- 单条命令输出上限 1 MiB；`pane_read`/`pane_run` 触顶时上报
  `truncated: true`（服务器端 `truncated` 标志原样透传）。

平台支持：插件**仅支持 POSIX**——所有控制面交互走 herdr Unix domain socket
（JSONL），面板启动按钮从 PATH 拉起 `herdr server` 是唯一的引导例外。
**不支持 Windows**（named pipe）：无法解析 socket 路径时插件拒绝加载。

`cordis.patch.yml` 示例：

```yaml
- id: dsh-plugin-herdr-client
  name: dsh-plugin-herdr/client-entry
  config:
    timeoutMs: 15000
- id: dsh-plugin-herdr
  name: dsh-plugin-herdr
  config:
    timeoutMs: 15000
```

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `herdr_snapshot` | 会话快照：workspaces、tabs、panes、agents、焦点 |
| `herdr_agent_list` | 列出 agent（可按 workspace / 状态过滤） |
| `herdr_agent_start` | **启动编码 agent**（pi / codex / claude）并等待 Herdr 识别；缺省在会话 workspace 内新建 split pane 中启动 |
| `herdr_agent_prompt` | 向 agent 提交提示词，可选等待状态 |
| `herdr_agent_wait` | 等待 agent 到达指定状态 |
| `herdr_agent_explain` | 解释 agent 检测状态 |
| `herdr_agent_send_keys` | 向 agent 发送按键 |
| `herdr_pane_run` | 在 pane 中运行 shell 命令；默认复用本会话绑定 pane（无绑定时才新建 split） |
| `herdr_pane_read` | 读取 pane 终端输出（visible/recent） |
| `herdr_pane_split` | 分裂 pane（方向/比例/cwd/env） |
| `herdr_pane_send_keys` | 向 pane 发送按键 |
| `herdr_pane_layout` | 读取 pane 布局 |
| `herdr_pane_close` | 关闭 pane — **破坏性操作** |
| `herdr_pane_rename` | 重命名 pane（`pane_id`；`label` 为空/ null 清除名称） |
| `herdr_workspace_create` | 创建 workspace（herdr 模式下被拒绝——会话已有专属 workspace） |
| `herdr_workspace_close` | 关闭 workspace 及其全部 pane — **破坏性操作** |
| `herdr_workspace_rename` | 重命名 workspace（`workspace_id`，非空 `label` ≤64 字符） |
| `herdr_layout_apply` | 应用声明式布局 |
| `herdr_notification` | 显示系统通知 |

## herdr 模式（agent preset）

新建会话时选择 **Herdr 模式**。该会话：

- 启动时在**项目目录（会话 cwd）创建专属 workspace**，其 root pane 即本会话
  的绑定 pane；
- 本会话产出的**所有 pane**（pane_run 新建、agent_start 启动、pane_split）
  都放进这个 workspace——`herdr_workspace_create` 会被拒绝，杜绝 pane 外流；
- 向 Herdr 侧边栏上报 `working` / `idle` 状态（`pane.report-agent`）；
- 会话结束时关闭整个专属 workspace（固定绑定只释放 authority）；
- 跨进程重启不重复创建：绑定 pane 携带内部标记
  （`tokens.dsh_session = <sessionId>`，永久），重启后复用同一 pane。

### 命名规范

- **显示名**（workspace / 绑定 pane label）：优先取**会话标题**（session/title，
  即 GUI 侧边栏显示的会话名，如「开启一个 pi Agent 检查当前系统」）；标题异步
  生成（首个用户消息后），生成后自动补正重命名。无标题时回退
  `dsh:<项目名>-<会话短 id>`（项目名 = 会话 cwd 的 basename；无 cwd 回退
  `dsh:<会话短 id>`）。配置 `label` 可覆盖。
- **内部标记与显示名分离**：标记存放在 pane 的 `tokens.dsh_session`
  （而非 label），tokens 保留完整 session id，显示名只暴露后 8 位短标识。
- **agent 名**：`herdr_agent_start` 自动生成 `<kind>-<n>`（如 `pi-1`）；
  显式传 `name` 用 `<kind>-<用途>`（如 `pi-disk-check`）。

### 开启 agent 执行任务

```
herdr_agent_start {kind: 'pi'}                        # 在会话 workspace 的新 pane 中启动
herdr_agent_prompt {target: '<pane_id>', text: '任务'} # 提交任务
herdr_agent_wait   {target: '<pane_id>', until: [idle, done, blocked], timeout_ms}  # 等待完成
herdr_pane_read    {pane_id: '<pane_id>'}              # 读取结果
```

`pi --print "..."` 之类的一次性命令**不是** Herdr agent——
`herdr_agent_wait` 无法跟踪；请使用 `herdr_agent_start`。

## Herdr 面板交互

会话页的 Herdr Tab 与右侧悬浮 pane 列表**按当前会话聚焦**（模式门控：
非 herdr 模式完全隐藏）：

- **只显示本会话 workspace**：两个视图都只展示本会话专属 workspace 及其
  pane（已移除「仅本项目/全部」scope 切换）。
- **双列卡片 + 拖拽排序**：pane 以双列网格渲染；拖动 ⋮⋮ 手柄可在 workspace
  内排序，顺序持久化在 localStorage key `herdr:pane-order:<workspace_id>`；
  跨 workspace 拖拽被忽略；窄屏（<640px）自动单列。
- **日志预览/展开**：卡片正文显示最近输出（渐隐）；「展开」提供独立滚动
  日志，自动跟随 working 的 agent，可「复制」完整输出。
- **重命名**：✎ 或双击进入行内编辑（≤64 字符）；清空 pane 名称即移除
  （回退到 agent 名，无则回退标题）。重命名由 herdr server 持久化。
- **关闭**：✕（hover 显示）弹出确认对话框；关闭 workspace 时显示其 pane
  数。对话框与服务端都会拒绝关闭承载当前会话的 pane（self-pane）。
- **Herdr Tab logo**：Tab 以 herdr logo（CSS mask、随主题取色）替代文字。

## 安全边界

- 所有操作仅限本机：插件只与本机 herdr socket 通信（唯一的子进程是可选
  的 server 启动引导）。
- 面板端点（`/herdr-status`、`/herdr-dashboard`、`/herdr-start`、
  `/herdr-session-pane`、`/herdr-pane-session`、`/herdr-close`、
  `/herdr-rename`）是本机 web server 上的普通 HTTP——
  **不要公开暴露 DSH web 端口**。端点另有守卫（CA-007）：
  - 严格方法：`/herdr-status`、`/herdr-dashboard`、`/herdr-session-pane`
    与 `/herdr-pane-session` 仅 GET，
    `/herdr-start`、`/herdr-close` 与 `/herdr-rename` 仅 POST
    （否则 `405 + Allow`）；
  - 仅限本机上下文：`Host` 必须是 `localhost`/`127.0.0.1`/`::1`
    （DNS rebinding 防御）；跨站 `Origin` 或 `Sec-Fetch-Site: cross-site`
    返回 `403`（CSRF 防御）——未授权请求无法启动 herdr server 或读取
    终端/拓扑数据。
- 状态上报仅用于展示：不影响 Herdr 自身的 wait 与通知语义。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `HERDR_UNAVAILABLE`：herdr socket 找不到 | 启动 herdr headless server（`herdr server` 或面板启动按钮）；先安装 herdr：`curl -fsSL https://herdr.dev/install.sh | sh` |
| 插件加载报「requires a resolvable socket path」 | 不支持 Windows；POSIX 下配置 `socketPath`/`HERDR_SOCKET_PATH` |
| 没有「Herdr 模式」预设 | 检查 `$DSH_HOME/.agent-presets/herdr/` 是否存在（插件加载时会重建） |
| 面板一直显示「正在获取本会话 pane…」 | 会话创建后切到 herdr 模式或服务重启过；首个模型请求会触发兜底绑定——发一条消息，或重启 profile |
| Panel stuck on "正在获取本会话 pane…" → 已由 selfPaneStore 退避单例接管，切会话后 1→2→4s 自动重查，无需手动重启 | 已由 `selfPaneStore` 单例退避接管，切会话后 1→2→4s 自动重查，无需手动重启 |
| No Herdr events / stale 提示 → 检查 events.enabled 默认为 true，` 和 `GET /herdr-events` SSE 是否被代理缓冲（`X-Accel-Buffering:no`） | 检查 `events.enabled` 默认为 `true`，且 `GET /herdr-events` SSE 是否被代理缓冲（`X-Accel-Buffering:no`） |
| `herdr_agent_start` 报 `agent_pane_busy` | 瞬时状态：新 split 的 pane shell 尚在初始化；工具会自动重试——稍后再看 |

## 开发

```sh
pnpm install
pnpm build        # tsdown（node 入口 + web client bundle）
pnpm quality      # typecheck + gen-types 漂移检查 + 单测
pnpm test         # 单测（node --test）
pnpm test:integration  # build + run.mjs + extended.mjs + events.mjs + close-rename.mjs（真实 herdr；不可用时 SKIP）
pnpm gen:types    # 从 herdr schema fixture 重新生成协议类型
```
