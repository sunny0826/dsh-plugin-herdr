# 环境探测结论（M0-01）

> 日期：2026-02（会话内）· 对应 TASKS.md M0-01 · 落实 DESIGN.md §7.1 待验证项与风险 #8

## 1. 环境信息

| 项 | 值 |
|---|---|
| herdr 版本 | `0.8.0`（stable channel） |
| 安装路径 | `/Users/san3an/.local/bin/herdr` |
| 协议版本 | `protocol: 19`，`schema_version: 1` |
| server 状态 | running（`herdr status`） |
| socket 路径 | `~/.config/herdr/herdr.sock`（另有 `herdr-client.sock`） |
| 环境变量 | `HERDR_SOCKET_PATH`/`HERDR_ENV`/`HERDR_BIN_PATH` 均未设置（本会话不在 Herdr pane 内） |
| schema 快照 | `test/fixtures/herdr-api.schema.json`（251,527 字节） |

## 2. 待验证项结论（DESIGN.md §7.1 ⚠️ 三项）

### 2.1 `herdr agent list` 的 CLI 标志
- **无 `--json` 标志**（`herdr agent list --help` 仅显示 `Usage: herdr agent list`）。
- **但实际输出本身就是 JSON envelope**：
  `{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}`
- **结论**：CLI 适配器可直接解析该 envelope（取 `result`）；`herdr api snapshot` 输出同样为
  envelope（`{"id":...,"result":{"snapshot":{...},"type":"snapshot"}}`），snapshot 含
  `agents/panes/tabs/workspaces/layouts/focused_*` 字段，可作为 agent 列表的备用数据源。
- **注意**：envelope 格式为 CLI 当前行为，M1 实现时对每个命令实测，解析失败归类 `HERDR_PROTOCOL`。

### 2.2 `herdr agent wait` 的标志
- `herdr agent wait <TARGET> [OPTIONS]`
- `--until <STATUS>`：**可重复**（`[possible values: idle, working, blocked, done, unknown]`）；
  不传时默认匹配 `idle, done, blocked`；匹配 `unknown` 需显式传。
- `--timeout <MS>`：超时毫秒；**不传则无限等待**。
- **结论**：与 raw `agent.wait` 一致（`{ target, until: AgentStatus[], timeout_ms? }`）。
- **设计影响**：`herdr_agent_wait` 的 `until` 参数应为**数组**（可多状态），默认语义对齐 CLI。

### 2.3 `pane.wait_for_output` 的时间上限参数
- CLI 命令名为 **`herdr pane wait-output`**（不是 `wait_for_output`）：
  `herdr pane wait-output [--match <TEXT> | --regex <PATTERN>] <PANE_ID> [--source recent] [--lines <N>] [--timeout <MS>] [--raw]`
- raw 方法 `pane.wait_for_output` 参数：
  `{ pane_id, source, match, lines?, timeout_ms?, strip_ansi? }`（`match` 必填：`OutputMatch` = `{type:'substring'|'regex', value}`）
- **结论**：时间上限为 `--timeout <MS>` / `timeout_ms`，超时后命令失败（工具层转为 `timed_out` 规范值）。

## 3. raw schema 关键方法参数（protocol 19 快照）

| 方法 | 参数（必填加粗） | 备注 |
|---|---|---|
| `session.snapshot` | — | 返回 `{agents, panes, tabs, workspaces, layouts, focused_*}` |
| `agent.list` | — | — |
| `agent.get` / `agent.explain` | **`target`** | — |
| `agent.wait` | **`target`**；`until: AgentStatus[]`；`timeout_ms?` | until 可多状态 |
| `agent.prompt` | **`target`、`text`**；`wait?: {until, timeout_ms} | null` | 可附带等待 |
| `agent.send_keys` | **`target`、`keys: string[]`** | — |
| `pane.split` | **`direction`**；`cwd/env/focus/ratio/target_pane_id/workspace_id?` | — |
| `pane.send_text` | **`pane_id`、`text`** | — |
| `pane.send_keys` | **`pane_id`、`keys`** | — |
| `pane.read` | **`pane_id`、`source`**；`format/lines/strip_ansi?` | — |
| `pane.wait_for_output` | **`pane_id`、`source`、`match`**；`lines/timeout_ms/strip_ansi?` | — |
| `pane.report_agent` | **`pane_id`、`source`、`agent`、`state`**；`message/agent_session_id/agent_session_path/seq?` | 状态上报 |
| `pane.report_metadata` | **`pane_id`、`source`**；`title/display_agent/state_labels/tokens/agent/applies_to_source/ttl_ms/clear_*?` | — |
| `pane.clear_agent_authority` | **`pane_id`**；`source?` | — |
| `events.subscribe` | **`subscriptions: Subscription[]`** | 事件类型如 `workspace.created` 等 |
| `events.wait` | **`match_event`**；`timeout_ms?` | — |
| `workspace.create` | —；`cwd/label/env/focus?` | — |
| `layout.export` | —；`tab_id/pane_id?` | — |
| `layout.apply` | **`root`**；`workspace_id/tab_id/tab_label/focus?` | — |
| `notification.show` | **`title`**；`body/position/sound?` | — |
| `integration.install` | **`target`** | 枚举：pi/omp/claude/codex/copilot/devin/droid/kimi/opencode/kilo/hermes/qodercli/cursor/mastracode/antigravity_cli/grok |

## 4. 枚举值（protocol 19）

| 枚举 | 值 |
|---|---|
| `AgentStatus` | `idle, working, blocked, done, unknown` |
| `PaneAgentState`（上报用） | `idle, working, blocked, unknown`（**无 done**） |
| `ReadSource` | `visible, recent, recent_unwrapped, detection`（CLI `read` 另有 `--format text|ansi`） |
| `SplitDirection` | `right, down` |
| `OutputMatch.type` | `substring, regex` |
| `ToastHerdrPosition` | `top-left, top-right, bottom-left, bottom-right` |

## 5. 对设计文档的影响

1. **§7.1 命令模板表**：agent 列表行与等待行、新增 wait-output 行——已按本报告更新（见 DESIGN.md v0.2+）。
2. **§8.2.4 `herdr_agent_wait`**：`until` 参数从单选改为**数组**（`until: AgentStatus[]`），默认语义对齐 CLI；
3. **§8.2.3 `herdr_pane_run`**：输出等待用 `herdr pane wait-output --match ... --timeout <ms>` 实现；
4. **§10.2 状态上报**：`PaneAgentState` 无 `done` 状态——上报 `done` 时映射为 `idle`（与官方集成行为一致，待 M3 实测确认）。
5. **风险 #8 已关闭**：`agent.wait` 的 until/timeout 形状已确认（多状态数组 + 可空 timeout_ms）。

## 6. 遗留观察

- CLI 各命令输出格式不统一风险：`agent list`/`api snapshot` 实测为 envelope JSON；其他命令（`pane list` 等）M1 实现时逐一实测并记录。
- `PaneAgentState` 无 `done`：上报状态机的最终映射需 M3 用真实 Herdr 侧边栏验证。
---

## 7. M0 阶段补充发现（dsh web 加载与 HMR）

| # | 发现 | 说明 |
|---|---|---|
| 1 | **插件必须导出 `Config`** | cordis 通过插件模块导出的 `Config` 属性做 schema 校验与默认值填充；只 import 不 export 时配置原样透传（实测 `allowBackground=undefined`） |
| 2 | **web profile 默认禁用 HMR** | dsh-web-app bundle 的 patch 含 `- id: hmr\n  disabled: true`（官方 TODO：reload 生命周期未测试）；开发期需覆盖：`- id: hmr\n  disabled: false\n  config: {root: [<workspace>], debounce: 100}` |
| 3 | **patch 覆盖行语法** | 顶层直接写 `- id: <id>`（不带 `insert:`）即为按 id 覆盖前面层的行；`insert` 追加会导致 `duplicate loader entry id` 启动失败 |
| 4 | **--patch 验证命令** | `DSH_HOME=<dir> dsh web --patch <file> --dump-config` 可离线验证层组合；默认 DSH_HOME 为 `~/.dsh` |
| 5 | **HMR 验证结论** | 修改 `lib/index.mjs`（构建产物）→ `plugin disposed` + `plugin loaded!` 日志链确认热替换；配置默认值随之生效 |
---

## 8. M1 阶段实测发现（CLI 行为）

| # | 发现 | 适配器处理 |
|---|---|---|
| 1 | **CLI 错误时退出码仍为 0**（多数命令），错误在 envelope `error` 字段 | 以 envelope 为准，不依赖退出码；退出码仅作参考 |
| 2 | **部分错误（不存在的 pane 等）把 envelope 输出到 stderr 且 exit 1** | stdout 为空/解析失败时回退解析 stderr |
| 3 | `pane read` 输出**纯文本**（非 envelope）；`pane run` 异步执行、无 stdout | read 用 rawText 模式；run 同样按纯文本处理 |
| 4 | `pane run` 是 **argv 语义**（COMMAND... 为参数数组） | 命令以 `sh -c <cmd>` 包装执行（POSIX；Windows 留待后续） |
| 5 | `pane read --source recent` 在无滚动历史时为空；`visible` 返回当前屏幕（含提示符与命令回显） | M1 轮询 visible；输出含终端**折行**（窄 pane），模型侧为正常现象 |
| 6 | `agent wait` 对不存在的 pane 返回 `agent_not_found`（stderr）；无 agent 的 pane 同码（stdout） | 统一映射 `{kind:'not_found'}` 规范值 |
| 7 | 输出稳定判定：连续两次 visible 内容相同且静默 ≥1.5s 视为命令完成 | 轮询 500ms；`wait_ms` 上限到时返回 `timed_out: true` |
---

## 9. cordis 4 服务注入规则（M1 验收 bug 复盘）

**现象**：工具调用报 `cannot get property "herdr" without inject`——插件 inject 只有 ['tools']，工具 execute 闭包访问 `ctx.herdr` 失败。

**根因**（cordis 4 源码 lib/index.js ReflectService.handler.get）：
- 每次 `ctx.<service>` 访问从**当前 fiber** 开始沿 parent 链向上解析；
- 每层只查 `fiber.store`——store 是**该 fiber 的 inject 声明的服务快照**（未声明即不在 store）；
- 走到根 fiber（runtime 为 null）仍未命中 → 抛 `cannot get property "X" without inject`。

**推论**：访问任何服务的代码所在 fiber 必须显式 inject 该服务；**服务提供者与消费者必须拆成两个插件**（提供者先加载注册服务，消费者 inject 后等待服务就绪再加载）。这与 DSH 官方"能力分层"（Service Definition / Provider / Consumer）一致。

**修复**：
- `src/client-entry.ts`：提供者插件（name: dsh-plugin-herdr-client），注册 ctx.herdr；
- `src/index.ts`：消费者插件，`inject: ['tools', 'herdr']`，只注册工具；
- cordis.patch.yml 两行（client 在前）；tsdown 双入口。

**验证**：单测 20/20（含"消费者在提供者缺席时不激活"断言）、集成 5/5、验收 server 加载正常。
---

## 10. M2 阶段实测发现（socket 协议与扩展工具）

| # | 发现 | 适配器处理 |
|---|---|---|
| 1 | **Herdr socket 是请求-响应短连接**：每个请求一个连接，服务器回复后立即关闭；仅 events.subscribe 保持连接推送订阅事件 | callOnce：每次新建连接；subscribe：专用长连接 |
| 2 | **订阅变体需精确匹配 schema**：`tab.updated` 不存在（合法：tab.created/closed/focused/renamed/moved）；`pane.agent_status_changed`/`pane.scroll_changed`/`pane.output_matched` 需要 `pane_id` | 订阅列表取自 schema；pane 状态订阅动态构建（snapshot 所有 pane），pane.created 时去抖重建 |
| 3 | **socket pane.read 响应嵌套**：`{type:'pane_read', read:{text,...}}`（text 在 result.read.text） | 解析 `result.read.text`（CLI 版是纯文本，两传输解析不同） |
| 4 | **pane.send_keys 是单键语义**：普通文本需逐字符键（'e','c','h'...），控制键 'enter'/'ctrl+c'；多字符串不是合法键 | 工具描述注明；集成测试用逐字符 |
| 5 | **pane.send_text + '\n' 可执行命令**（POSIX shell）；CLI pane run 用 argv 语义（sh -c） | socket runCommand 用 send_text + '\n' |
| 6 | **Herdr 后端（ghostty）有资源上限**：大量 split 后报 `pane_split_failed: ghostty error -2` | 集成测试自清理（关闭测试创建的 workspace/pane）；文档提示用户注意 pane 数量 |
| 7 | **events.subscribe 的响应 id 为空串**（`{"id":"","error":...}`），错误时连接即关 | 订阅实现按"首个带 id 的行"判定响应；错误走 error envelope |
---

## 11. M3 阶段实测发现（状态上报与 pane 环境）

| # | 发现 | 处理 |
|---|---|---|
| 1 | **Herdr pane 环境注入确认**：pane 内进程可见 `HERDR_ENV=1`、`HERDR_PANE_ID`、`HERDR_SOCKET_PATH`、`HERDR_WORKSPACE_ID`、`HERDR_TAB_ID` | state-report 按 HERDR_ENV/HERDR_PANE_ID 激活（ADR-6 实测成立） |
| 2 | **pane.report_agent 链路完整**：working→idle→blocked 轮转在 agent list / pane get 中正确显示（state_change_seq 递增）；pane 内执行 report-agent 可用（nested herdr 禁用的提示是软警告，不影响 report-agent 子命令？——待确认，release-agent 场景实测可执行） | 集成验证通过 |
| 3 | **release-agent 需要 `--agent` 参数**（CLI 契约），raw `pane.clear_agent_authority` 不需要 | clearAgentAuthority 请求类型加 agent（CLI 必需） |
| 4 | **dsh CLI 在 Herdr pane 内行为异常**：`--version` 报 `--profile required`、`--dump-config` 静默无输出——疑似 dsh 对 HERDR_ENV/TTY 环境的检测问题 | 记录为已知限制：真正"pane 内跑 dsh web"的端到端需 dsh 侧调查；M3 以链路级验证替代（单测覆盖 DSH 侧映射 + 真实 pane 验证 Herdr 侧） |
| 5 | **agent list 记录形状**：`{agent, agent_status, cwd, focused, foreground_cwd, pane_id, revision, state_change_seq, tab_id, terminal_id, workspace_id}`——状态在 `agent_status` 字段 | herdr_agent_list 的 status 过滤使用 agent_status（适配器已按此归一化） |
| 6 | **⚠️ 安全提醒**：pane 环境继承用户 shell 环境变量（`MINIMAX_API_KEY` 等在 pane 内可见）。插件不会读取/转发它们，但用户应知晓 Herdr pane 内进程可见这些变量 | 文档提示；插件只读取 HERDR_* 命名空间 |
| 7 | **ghostty 资源上限复现**：pane 数过多/状态异常时 split 报 `pane_split_failed: ghostty error -2`；关闭多余 pane 后恢复 | 集成测试自清理 + 文档提示 pane 数量管理 |
---

## 12. M5 阶段发现（Herdr 监控面板架构）

| # | 发现 | 处理 |
|---|---|---|
| 1 | **客户端插件必须以"包名"作为 Loader entry**（`dsh plugin add` 安装进 profile）；文件路径 entry 不会被 dsh-client-modules 的 Node half 扫描，客户端 bundle 不加载 | bundle 的 cordis.patch.yml 用包名（`dsh-plugin-herdr` / `dsh-plugin-herdr/client-entry`），exports 提供 `./client` |
| 2 | **typert `@Remote` 装饰器只支持标准装饰器语义**；tsdown/rolldown 只转换 legacy 装饰器，两者冲突 | 放弃 typert remote，改用 **dsh-host-webserver 的 `webServer.register()` HTTP 路由**（`/herdr-status`） |
| 3 | **fiber 的 `store` 只含 inject 声明的服务**——非 inject 服务连 `ctx.get()` 也拿不到（root ctx 的 get 是注册表宽松路径，但时序不可靠） | 用官方 `ctx.inject(['webServer'], cb)` 等待服务就绪；headless 无 webServer 时回调不执行（功能自动降级） |
| 4 | **agent 记录的状态字段是 `agent_status`**（不是 status）；此前 herdr_agent_list 的 status 过滤实际无效 | 两适配器 listAgents 归一化 `agent_status → status`（env-findings §11 的遗留问题，本次修复） |
| 5 | **状态面板数据源不依赖 events 配置**：tracker 轮询 `agent.list` + `pane.read`（2s），事件订阅只是加速路径 | `/herdr-status` 返回 `{agents:[{pane_id,agent,status,message,output,updated_at}],connected}` |
| 6 | **客户端视图**：注册 `conversation.view` slot（id: herdr, order: 20, label 'Herdr'）——与 trajectory 同级的视图 Tab；客户端轮询 `/herdr-status` 渲染分块 agent 卡片 | client bundle 外部化 react/client 包（ModuleLoader 运行时解析） |
| 7 | 客户端插件 manifest：package.json `dsh.client`（inject 运行时、platform web）+ exports `./client`（预构建 CJS） | tsdown.web.config.ts（browser + jsx + external） |
| 8 | 测试环境敏感性：w8 的 pane 数影响新 split 宽度（窄 pane 输出折行导致集成断言失败） | 集成测试需在 pane 数少的干净环境跑；文档注明 |
---

## 13. Skill 加载（Herdr SKILL.md 注入会话）

- **需求**：启用插件时给会话加载官方 skill <https://github.com/herdrdev/herdr/blob/v0.8.0/skills/herdr/SKILL.md>
- **实现**：`ctx.skills.register()` 运行时注册（dsh-skill registry，base 内置）——不依赖文件系统 provider 或网络：
  - `scripts/embed-skill.mjs`：`src/assets/herdr-skill.md`（v0.8.0 快照，10,140 字节）→ `src/herdr-skill.ts`（JSON 字符串字面量，免转义）
  - `src/skill.ts`：`registerHerdrSkill(ctx)` 用 `ctx.inject(['skills'])` 等待 registry（headless 无 skills 服务时跳过）；注册 name='herdr'、description 来自 frontmatter、content=完整 SKILL.md
- **生效**：注册后当前及后续会话的模型 skill 目录包含 herdr（按 description 匹配，模型按需调 skill 工具加载全文）
- **验证**：单测 3 项（frontmatter 解析、注册内容、官方内容断言）+ 真实环境日志 `skill "herdr" registered`
- **更新方式**：Herdr 版本升级时替换 `src/assets/herdr-skill.md` 并重跑 `node scripts/embed-skill.mjs`

---

## 14. herdr 模式（M6）：agent preset 机制

用户需求：新建会话时应有 herdr 模式开关（对话本身就是 Herdr 里的对话），
而不是从会话里开启 herdr。实现：DSH 的 agent preset 机制。

### 机制要点（来自 @deepseek-ai/dsh-agent-presets 源码）

- preset = `$DSH_HOME/.agent-presets/<id>/` 目录，含 `agent.cordis.yml`（组合）
  与可选 `preset.yml`（展示元数据：name/description/order）
- id 必须匹配 `/^[a-z0-9][a-z0-9-]*$/`（成为路径段）；组合必须是顶层 plugin 行列表
- 发现 unmemoized：list()/resolve() 每次调用重读 roots → 进程运行中写入也可见
- web 启动组合：`dsh web --dump-config` 显示 `@deepseek-ai/dsh-agent-presets`
  （default: standard）+ `@deepseek-ai/dsh-client-ui-agent-preset`（选择器 UI），
  boot 还注入 SHIPPED_PRESET_ROOT（系统预设）
- 选择器 UI 的 roster 由 host 经 client 通道应答（非 HTTP 端点，curl 探测 404）
- 用户已有范例 `~/.dsh/.agent-presets/fangan/`：persona 行（@deepseek-ai/dsh-persona，
  config.text 多行 `>-`）+ 模型工具行

### 本插件实现

- `presets/herdr/{preset.yml,agent.cordis.yml}`：展示名 "Herdr 模式"；
  组合 = persona 行（说明 herdr 模式工作方式，引导使用 herdr_* 工具）+
  `dsh-plugin-herdr/session-mode` 行（paneId 可配，留空自动取焦点 pane）
- `src/preset-install.ts` ensureHerdrPreset()：provider 插件 apply 时把 preset
  复制到 `$DSH_HOME/.agent-presets/herdr/`（marker 幂等，用户改动不被覆盖）
- `src/session-mode.ts`（dsh-plugin-herdr-session-mode，inject ['herdr']）：
  初始 idle 上报（config.paneId 或 snapshot().focused_pane_id）→
  agent/request（waterfall 必须 next()）→ working；agent/turn-stopping → idle；
  卸载 clearAgentAuthority（release-agent 需 --agent，已带 agent 参数）
- 构建：package.json `./session-mode` export + files 含 presets；
  tsdown entry 增加 src/session-mode.ts（与主插件同包按名解析）

### 验证结论

- 服务器日志：`[dsh-plugin-herdr] preset "herdr" installed at ...（herdr 模式开关已可用）`
- 落盘校验：agent.cordis.yml + preset.yml 形状合法；组合行引用真实插件名
- `dsh-plugin-herdr/session-mode` 从 profile 解析成功（exports Config/apply/inject/name）
- `dsh web --dump-config` 确认 agent-presets 服务与选择器 UI 在组合内
- 单测：preset-install.test.ts 3 项（安装/幂等/路径），全套 50 项全过

---

## 15. herdr 服务启动与看板（M7）

### herdr server 启动机制（实测）

- `herdr server`（裸命令）= 启动 headless server 守护进程（不是 `server start`！）；
  启动后打印 banner："herdr server running; you can use any herdr CLI command in another terminal."
- `herdr --session X` 需要 TTY（无 TTY 时进程挂起、不启动 server）→ 不适合无头启动
- `herdr status server --json`：单行 JSON
  `{status: running|not_running, running: bool, version, protocol, capabilities, compatible, socket, session, restart_needed}`
- spawn 方式：`spawn('herdr', ['server'], {detached:true, stdio:'ignore'})` + unref，
  然后轮询 status server --json 直到 running（实测 ~1s 内就绪）
- macOS 沙箱限制：herdr server 需绑定 ~/.config/herdr/herdr.sock（workspace 外），
  沙箱内报 `Os { code: 1, kind: PermissionDenied }` → 启动按钮需宽权限环境
- `herdr server stop`：经 API socket 停止（状态回 not_running）

### DSH web 客户端 slot 注入点（实测）

- 会话页 header：`conversation.session.header.actions`（list, session scope）—
  agent-preset label 占用 order:-10，可追加（id + order）
- 新建会话（hero 相位）：hero 只有两个 single slot（workspace/agentPreset，均已占用）
  → 无官方注入点；可用 `shell.overlay`（list, root scope）注册浮层卡片：
  overlayLayer CSS `pointer-events:none` 但直接子元素 `pointer-events:auto`；
  conversation root 元素带 `data-phase=hero|active|settling` 属性可检测相位
- `slots.register({name, id, order}, Component)` 返回 dispose；`ctx.slots.inject(name, fn)` 包裹注册
- webServer.register handler 会被 `await`（dsh-host-webserver handle()），支持异步

---

## 16. agent preset 组合与事件路由（M8 实测）

### standing mount 语义（关键）

- agent preset 组合是 **standing mount**：每个 preset 在进程内只挂载一次
  （挂载在第一个加入的 agent 的 scope 下，PresetTree 插件），所有加入的 agent
  通过 bindScopeParent 共享这一份插件实例（插件需按 payload.agent 区分会话）
- mount 后做 inactive 检查：行 inject 的服务不可解析 → PresetMountError →
  **会话创建被拒绝**（所以 preset 组合里的插件必须声明真实可解析的 inject）
- mountPreset 拒绝向 root 泄露服务（preset 服务须在 isolate realm 内）

### 事件路由（dsh-scope）

- dsh-agent 事件（agent/created、agent/request、agent/turn-stopping、
  agent/disposed）经 scope 载体（scopeTarget(agent, key)）分发：
  filter 接受未打标签的 ctx（root/host）与 key 链上的**祖先** scope 监听器
  （standing preset scope 是 agent scope 的父级 → 收到其下所有 agent 事件）
- payload 恒带 `agent`（id === session id）→ 按 agent id 区分会话
- agent/created：{agent}（announce 阶段，mount 之后，监听器已就绪）；
  agent/disposed：{agent}（agent 退出时）
- cordis 4 事件注册在插件自己的 events registry，但 _hooks 对象沿 extend 链共享
  （实测 root 与 plugin ctx 的 _hooks 是同一对象）；裸环境 ctx.plugin() 的 fiber
  apply 后 uid=null（loader 环境才正常），**单测应直接调用 apply 函数**
- ctx.emit/waterfall/serial 的第一个 object 参数是载体（thisArg），payload 是第二个

### 其他

- `herdr workspace create` 返回 `result.root_pane.pane_id`（新 workspace 根 pane）；
  新 workspace 不会自动成为焦点（focused_pane_id 不变）
- `herdr pane close <id>` 关闭 pane；空 workspace 自动清理
- registry 上的 @deepseek-ai/dsh-agent-presets 是旧版（0.0.1-rc.1），
  npx 缓存为 0.1.0-rc.6——测试/开发一律用缓存版本，避免 API 漂移

---

## 17. pane.read 快照与终端文本语义（M9 实测）

- `herdr pane read <id> --source visible`：**当前视口**（viewport_rows 23 行），
  新输出滚动时旧行被顶出——不适合作命令输出捕获（输出会缺头）
- `--source recent`（默认）：**scrollback**（scrollback_limit_bytes=10MB），
  历史完整；`--lines N` 限制返回行数
- 快照含 shell 提示符与命令回显；执行后基线末尾提示符位置变为命令回显
  （`❯\n` → `❯ sh -c ...`）——基线前缀匹配前须剥掉尾部提示符
- 终端 54 列折行：长 token 折成多行（`FINAL-CLEAN` → `F\nINAL-CLEAN`），
  文本断言需先压平换行
- `herdr agent prompt` 的 CLI envelope：状态在 `result.agent.agent_status`
  （顶层无 status/message）；错误时 `error.code`（如 agent_not_ready）
- dsh 工具输出必须是 lossless JSON：返回对象不能含 undefined 字段
  （否则 ToolOutputError INVALID_TOOL_OUTPUT）——条件展开对象字段

---

## 18. primitives 组件与前端落地（M10 实测）

### dsh-client-ui-primitives 组件 props（d.ts 确认）

- `StateDot({state: 'done'|'warning'|'ongoing'|'error', size, className})`：
  ongoing = 深蓝色 3x3 矩阵追逐动画（CSS：.dot 双同心圆 + data-state 颜色 +
  _dsh-state-dot-chase keyframes）；done 绿 / warning 琥珀 / error 红
- `Pill({active, className, children, onClick})`：24px 胶囊（bg-layer-2）
- `Button({variant: primary|ghost|outline|toolbar, size: md|sm, icon})`：
  sm=28px radius14、primary=button-primary-fill
- `TerminalBlock({command, cwd, home, output, exitCode, signal, running, maxLines, labels})`：
  内置中文 labels（复制/复制成功/无输出/展开 N 行/信号/退出码）；
  running 态显示 runState 点；maxLines 默认 16（头部尾部 + 折叠）
- `DisclosureRow({icon, title, open, expandable, onToggle, ...})`：24px 紧凑折叠行
- 组件 CSS 由 web shell 主样式提供（hash 类名随产物版本）——插件只需 token 变量

### 构建与类型

- tsdown.web external 需列出运行时由 ModuleLoader 提供的包
  （@deepseek-ai/dsh-client-ui-primitives 等），否则被内联打包导致重复 React/样式缺失
- primitives 的类型声明用 ambient d.ts（无顶层 import/export）：declare module
  在有 import 的文件里是模块增强（要求模块可解析），纯 ambient 文件才允许
  声明未安装的模块；类型引用用 import('react').ReactNode 内联形式
- /herdr-status topology：snapshot 提取 workspaces（label/active_tab_id）、
  tabs（label/pane_count）、panes（title/cwd/foreground_cwd/focused/agent_status）

---

## 14. M11：会话页右侧 pane 状态列表

> 需求：聊天右侧 pane 状态 list；可折叠为 Herdr logo；开始任务时自动展开。

### M11-01 绑定注册表与端点（S，✅）
- binding-registry（globalThis Symbol.for 跨 bundle 共享）；GET /herdr-session-pane
- **验收**：端点实抓返回绑定 pane

### M11-02 右侧面板（M，✅）
- shell.overlay entry：workspace 分组 list + 本对话标注 + 折叠 logo 圆钮 +
  working 边沿自动展开
- **验收**：构建通过、69 测试全过、bundle 含面板代码

### M11-03 共享轮询（S，✅）
- useHerdrStatus 单例 store（单轮询循环多订阅，无监听者停止）
- **验收**：banner/pill/hero/视图/面板共用数据源

**M11 结果回填**：M11-01~03 完成；浏览器渲染与自动展开待用户确认。

---

## 15. M12：面板拖动/跳转/官方 logo

> 需求：面板可拖动吸附边界；点击 item 跳转 Herdr Tab 对应 pane；logo 用官方图。

### M12-01 拖动吸附（S，✅）
- useFloatingDrag（Pointer Events + 位移阈值 + 水平吸附左右、垂直夹视口）
- **验收**：面板/圆钮共用位置，折叠展开保持

### M12-02 列表项跳转（S，✅）
- tab 点击（role=tab 匹配）+ pendingFocusPane/CustomEvent 双通道 + scrollIntoView/flash
- **验收**：构建通过、69 测试全过

### M12-03 官方 logo（XS，✅）
- logo.svg 剥背景 rect、currentColor 主题化
- **验收**：bundle 含新特性、服务器运行正常

**M12 结果回填**：M12-01~03 完成；交互手感待用户确认。
