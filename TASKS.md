# dsh-plugin-herdr 任务拆分（TASKS）

> 依据：[DESIGN.md](./DESIGN.md) v0.2（§14 测试与验证、§15 里程碑）
> 约定：每个任务的完成定义（DoD）= 代码实现 + 适用时的测试 + 文档/注释更新；
> 日志统一前缀 `[dsh-plugin-herdr]`；每个里程碑完成后回填本文件的"结果"列并在 DESIGN.md 更新状态。

---

## 0. 总览

| 里程碑 | 任务数 | 规模 | 依赖 | 关键交付 |
|---|---|---|---|---|
| M0 脚手架 | 7 | S | — | 可加载空插件 + 环境探测结论 |
| M1 MVP | 10 | M | M0 | 4 个工具闭环（观察/控制/等待） |
| M2 进阶 | 8 | L | M1 | socket 传输、后台任务、事件订阅、扩展工具 |
| M3 双向 | 5 | S | M2 | DSH→Herdr 状态上报 |
| M4 发布 | 5 | S | M3 | 可安装发布 |

规模：XS < 0.5d，S ≤ 1d，M ≤ 3d，L > 3d（相对量级，供排期参考，非承诺）。

任务 ID 规则：`M<里程碑>-<序号>`。带 ⚠️ 的任务需要本机环境（真实 herdr / dsh CLI）。

---

## 1. M0 脚手架（S，全部串行）

### M0-01 ⚠️ 环境探测（XS）
- **内容**：`herdr --version`；`herdr api schema --json` 导出到 `test/fixtures/herdr-api.schema.json`；
  落实 DESIGN.md §7.1 的三个待验证项：
  1. `herdr agent list` 的 CLI 标志（有无 `--json`）；
  2. `herdr agent wait` 的标志（`--until`、超时参数）；
  3. `pane.wait_for_output` 的时间上限参数形状；
  另确认 socket 路径解析（`~/.config/herdr/herdr.sock` 存在性）与 `herdr api snapshot` 输出。
- **产出**：`docs/env-findings.md` 记录结论；schema 快照入库。
- **验收**：§7.1 三个 ⚠️ 项与 DESIGN.md 风险 #8 全部有确定答案；快照可离线测试使用。
- **依赖**：—

### M0-02 协议类型生成脚本（S）
- **内容**：`scripts/gen-types.mjs`：读取 `herdr api schema --json`（或 fixtures 快照），生成
  `src/client/types.ts`。M0 先覆盖最小子集：`session.snapshot`、`agent.list`、`agent.wait`、
  `pane.split`、`pane.send_text`、`pane.wait_for_output`、`pane.read`、`pane.report_agent`。
  生成文件头记录来源版本（§4 ADR-2）。
- **验收**：对 fixtures 快照可跑通；生成的 `types.ts` 通过 `tsc --noEmit`；幂等（重跑 diff 为空）。
- **依赖**：M0-01

### M0-03 bundle 骨架（S）
- **内容**：`package.json`（§5.2：`dsh.bundle`、`prepare: tsdown`、`files`、dependencies/devDependencies）、
  `cordis.patch.yml`、`tsconfig.json`、`.gitignore`、`pnpm-workspace.yaml` 占位（若需要）。
- **验收**：`pnpm install` 成功；`pnpm build` 产出 `lib/`；`pnpm pack` 内容符合 `files`。
- **依赖**：—

### M0-04 Config 模块（S）
- **内容**：`src/config.ts`：§6.1 全字段 + Schemastery schema；
  纯函数辅助：`resolveCliPath`（显式 > `HERDR_BIN_PATH` > PATH，§6.2 修订）、
  `resolveSocketPath`（显式 > `HERDR_SOCKET_PATH` > POSIX 默认路径）、`resolveSession`。
- **验收**：非法配置（transport 枚举、timeoutMs 越界）加载报错；默认值正确；辅助函数单测覆盖解析顺序。
- **依赖**：M0-03

### M0-05 插件入口（S）
- **内容**：`src/index.ts`：`apply(ctx)` 装配——加载 Config、注册 HerdrClient 占位服务
  （§5.3 骨架，方法先抛 NotImplemented）、空工具注册验证、`ctx.effect()` 清理；加载日志。
- **验收**：`tsc --noEmit` 通过；单元测试加载无错误、卸载无泄漏。
- **依赖**：M0-03、M0-04

### M0-06 ⚠️ 加载验证 + HMR（S）
- **内容**：`scratch-plugin/cordis.yml` 指向本地源码；`pnpm dsh web --patch ./scratch-plugin/cordis.yml`
  加载；修改 config 触发 HMR 热替换验证（§6.2）。
- **验收**：终端打印 `[dsh-plugin-herdr] plugin loaded!`；HMR 后旧 effect 清理、新实例生效。
- **依赖**：M0-05

### M0-07 测试骨架（S）
- **内容**：`test/unit/` 目录 + 测试 runner（node:test 优先，避免额外依赖；不满足再引入 vitest）+
  首个冒烟测试（加载插件空跑）。
- **验收**：`pnpm test` 绿色；CI 可复用。
- **依赖**：M0-03

> **M0 里程碑验收**（DESIGN.md §14.4 第 1 条）：插件在 `dsh web --patch` 下加载，无 schema 校验错误。

---

## 2. M1 MVP（M，多数任务可在 M1-02 后并行）

### M1-01 服务接口与类型（S）
- **内容**：`src/client/index.ts`：`HerdrClient extends Service`（§5.3）方法签名全集
  （`snapshot/listAgents/runCommand/waitAgent` + §7.3 扩展方法占位）；领域类型
  （`HerdrSnapshot`、`HerdrAgentInfo`、`RunCommandRequest/Result`、`WaitAgentRequest/Result`）；
  `declare module '@deepseek-ai/cordis' { interface Context { herdr: HerdrClient } }`。
- **验收**：`tsc --noEmit` 通过；工具模块可引用类型。
- **依赖**：M0-05、M0-02

### M1-02 CLI 适配器（M）
- **内容**：`src/client/cli.ts`：§7.1——`spawn`（argv 数组、不经 shell）、JSON 解析、
  超时 kill 进程组、错误归类（§11.1 连接/协议/目标三类）、`--session` 透传、cliPath 解析顺序、
  幂等读方法 1 次重试（§11.2）；命令模板按 M0-01 探测结果定稿。
- **验收**：mock 单测覆盖：命令构造、JSON 解析、超时 kill、错误归类、重试策略。
- **依赖**：M1-01、M0-01

### M1-03 tools/shared.ts（S）
- **内容**：错误归类助手（抛错 vs 规范值，§4 ADR-3）、公共 render（表格、`[exit code: N]` 标记）、
  参数手检助手（非空字符串、跨字段约束，§8.1 原则 2）。
- **验收**：单测覆盖。
- **依赖**：M1-01

### M1-04 工具 herdr_snapshot（XS）
- **内容**：§8.2.1：execute（CLI `api snapshot`）+ render 摘要 + generic 卡片。
- **验收**：单测（连接失败抛 `HERDR_UNAVAILABLE`）+ 集成（快照非空，§14.2 第 1 项）。
- **依赖**：M1-02、M1-03

### M1-05 工具 herdr_agent_list（XS）
- **内容**：§8.2.2：CLI 传输下从 snapshot 派生（v0.2 修订）；`status`/`workspace_id` 过滤；表格 render。
- **验收**：单测（过滤逻辑）；集成（含状态枚举校验）。
- **依赖**：M1-02、M1-03

### M1-06 工具 herdr_pane_run（M）
- **内容**：§8.2.3：新建 split / 复用 pane；`wait_for_output` 带 `wait_ms` 上限；
  规范值 `completed`（含 `timed_out`）与 `background` 分支占位（前台先实现）；
  `terminal` 卡片（§13）；`exec.signal` 合规。
- **验收**：单测（schema、超时路径）；集成（`echo hello-herdr`，§14.2 第 2 项）。
- **依赖**：M1-02、M1-03

### M1-07 工具 herdr_agent_wait（M）
- **内容**：§8.2.4：`agent.wait` 前台；`exec.signal` + 自身超时双取消源；
  规范值 `completed/timeout/not_found` 三分支；`until` 枚举按 M0-01 探测定稿。
- **验收**：单测（三分支 + 取消）；集成（等待已存在 agent 到 done）。
- **依赖**：M1-02、M1-03

### M1-08 单元测试补全（S）
- **内容**：§14.1 清单：全部工具的参数校验、render 纯函数、规范值形状（oneOf 分支）；
  CLI 适配器测试补齐。
- **验收**：`pnpm test` 覆盖 §14.1 全部条目。
- **依赖**：M1-04 ~ M1-07

### M1-09 ⚠️ 集成测试脚本（S）
- **内容**：`test/integration/run.sh`：§14.2 第 1、2 项（snapshot 非空、pane_run echo），
  对已启动的 herdr 默认会话运行；失败时输出诊断（§11.3）。
- **验收**：本机真实 herdr 上连续跑 2 次通过。
- **依赖**：M1-04、M1-06

### M1-10 ⚠️ 手动验收（S）
- **内容**：Web UI 加载；聊天依次调用 4 个工具；检查卡片渲染（terminal/generic）与规范值；
  模拟中途停止验证 `exec.signal` 取消。
- **验收**：DESIGN.md §14.4 全部 4 条勾选完成。
- **依赖**：M1-08、M1-09

---

## 3. M2 进阶（L，M2-05/M2-06 可并行）

### M2-01 socket 适配器（L）
- **内容**：§7.2：JSONL 连接（node:net）、请求/响应 id 匹配、惰性连接、`ctx.effect` 清理、
  断线指数退避重连、`events.subscribe` 订阅事件分发（按 `type`）。
- **验收**：fixture 单测：请求/响应匹配、订阅分发、断线重连（退避上限）、清理无泄漏。
- **依赖**：M1-01、M0-02

### M2-02 传输工厂（S）
- **内容**：`client/index.ts` 按 `config.transport` 选择 CliAdapter / SocketAdapter；
  `resolveSocketPath` 接入（POSIX，§6.2 修订）；两种适配器行为差异文档化。
- **验收**：工厂单测；两种传输各跑通 `snapshot()`。
- **依赖**：M2-01、M1-02

### M2-03 jobs 后台化（M）
- **内容**：`src/jobs.ts`：§9——producer 封装（`JobStart`/`JobHooks`，`JobOutcome` 按 v0.2 修正形状）；
  `herdr_agent_wait` 与 `herdr_pane_run` 的 `run_in_background` 分支；`allowBackground` 闸门
  （条件注册参数，§4 ADR-4）；前后台共用同一 `waitAgent` 实现（§9.3）。
- **验收**：单测（cancel 幂等、done 在取消后 settle、readOutput 增量）；集成（后台 wait 两条路径，§14.2 第 4 项）。
- **依赖**：M2-02、M1-07、M1-06

### M2-04 事件转发（M）
- **内容**：`src/events/forward.ts`：§10.1——`herdr/*` 事件类型声明（`agent-state`、`resource-changed`、
  `channel`）；socket 订阅转发；CLI 传输下轮询兜底（固定 5s）；重连退避。
- **验收**：集成（split 新 pane 触发 `herdr/resource-changed`，§14.2 第 5 项）；`herdr/channel` 状态可见。
- **依赖**：M2-02

### M2-05 扩展工具第一批（M）
- **内容**：§8.3：`herdr_workspace_create`、`herdr_pane_split`、`herdr_pane_send_keys`、
  `herdr_pane_read`、`herdr_pane_layout`（含 scroll/at-bottom 指标）。
- **验收**：单测（参数/规范值）+ 集成抽查 2 个。
- **依赖**：M2-02

### M2-06 扩展工具第二批（M）
- **内容**：§8.3：`herdr_layout_apply`、`herdr_agent_prompt`、`herdr_agent_explain`、
  `herdr_agent_send_keys`、`herdr_notification`。
- **验收**：单测（参数/规范值）+ 集成抽查 2 个。
- **依赖**：M2-02

### M2-07 测试补全（S）
- **内容**：§14.1 剩余条目（jobs/事件/socket）+ §14.2 第 4、5 项集成。
- **验收**：`pnpm test` 全绿。
- **依赖**：M2-03、M2-04、M2-05、M2-06

### M2-08 里程碑验收（S）
- **内容**：Web UI 手动验证：长连接订阅、后台等待（`allowBackground: true` 配置下）、扩展工具集。
- **验收**：M2 交付物（DESIGN.md §15 表）全部可用。
- **依赖**：M2-07

---

## 4. M3 双向（S）

### M3-01 HERDR_ENV 探测（XS）
- **内容**：§4 ADR-6：启动探测 `process.env.HERDR_ENV === '1'`；不满足时注册空实现并打一行日志；
  `reportState` 配置接入。
- **验收**：非 Herdr 环境加载无任何副作用（单测模拟）。
- **依赖**：M2-04

### M3-02 状态上报核心（M）
- **内容**：`src/events/state-report.ts`：§10.2 状态映射表实现（`agent/request` 开始 → working、
  等待审批 → blocked、回合完成 → done、空闲 → idle）；`pane.report_agent` 载荷构造
  （`source: 'dsh:herdr-plugin'`、`pane_id` 来自 `HERDR_PANE_ID`）。
- **验收**：单测（事件 → 上报载荷映射表全覆盖）。
- **依赖**：M3-01

### M3-03 report_metadata 增强（S）
- **内容**：§10.2：`title`、`tokens`（当前模型名）、`ttl_ms` 刷新的辅助路径。
- **验收**：单测（TTL 刷新与过期）。
- **依赖**：M3-02

### M3-04 清理逻辑（XS）
- **内容**：卸载时 `pane.clear_agent_authority`（若持有 authority）或停止 TTL 刷新；进程内 effect 注册。
- **验收**：单测模拟卸载：清理调用一次、幂等。
- **依赖**：M3-02

### M3-05 ⚠️ 端到端验证（S）
- **内容**：在 Herdr pane 内启动 `pnpm dsh web`，观察 Herdr 侧边栏状态流转（working → blocked → done）。
- **验收**：侧边栏按 §10.2 映射正确显示；文档明确"展示性上报"边界（§10.2 注意）。
- **依赖**：M3-03、M3-04

---

## 5. M4 发布（S）

### M4-01 集成测试补全（S）
- **内容**：§14.2 全 5 项；第 3 项（真实 agent 状态变化）标注 ⚠️ 需凭据、CI 跳过或 optional。
- **验收**：脚本可重复运行；跳过项有明确标记与原因。
- **依赖**：M3-05

### M4-02 README（S）
- **内容**：安装（npm / tarball / git + `allowBuilds` 授权说明，§12 第 6 条）、配置项表、
  工具清单、安全边界（§12）、故障诊断（§11.3）。
- **验收**：按 README 从零安装成功。
- **依赖**：M4-01

### M4-03 gen-types 固化（XS）
- **内容**：`scripts/gen-types.mjs` 记录来源版本；schema 快照入库；`pnpm gen:types` 幂等校验。
- **验收**：重跑脚本 diff 为空；README 记录生成时 `herdr --version`。
- **依赖**：M0-02

### M4-04 ⚠️ 分发验证（S）
- **内容**：三条安装路径：`dsh plugin add ./dsh-plugin-herdr`（本地目录）、`pnpm pack` tarball、
  git 安装（锁定 commit + allowBuilds）。
- **验收**：三种方式安装后 profile 启动均加载成功；`--dump-config` 显示对应层。
- **依赖**：M4-02

### M4-05 文档定稿（XS）
- **内容**：DESIGN.md 移除 Draft 状态、变更记录归档；TASKS.md 回填各任务实际结果与偏差说明。
- **验收**：文档与实现一致；两个文件均无 TODO 遗留。
- **依赖**：M4-04

---

## 6. 依赖图（摘要）

```
M0-01 ─► M0-02 ─► M1-01 ─► M1-02 ─┬─► M1-04 ─┐
M0-03 ─► M0-04 ─► M0-05 ─► M0-06    ├─► M1-05 ─┤
M0-03 ─► M0-07                       ├─► M1-06 ─┼─► M1-08 ─► M1-10
M0-02 ─► M1-01                       └─► M1-07 ─┘     │
M1-03 ◄─ M1-01                        M1-04/06 ─► M1-09┘

M1-01 ─► M2-01 ─► M2-02 ─┬─► M2-03 ─► M2-07 ─► M2-08
                          ├─► M2-04 ─┘
                          ├─► M2-05 ─┘
                          └─► M2-06 ─┘

M2-04 ─► M3-01 ─► M3-02 ─┬─► M3-03 ─► M3-05
                          └─► M3-04 ─┘
M3-05 ─► M4-01 ─► M4-02 ─► M4-04 ─► M4-05
                    M0-02 ─► M4-03 ┘
```

**并行建议**：
- M1-04 ~ M1-07 在 M1-02/M1-03 完成后可并行（4 个工具互不依赖）；
- M2-03 / M2-04 / M2-05 / M2-06 在 M2-02 后可并行；
- M3-03 / M3-04 在 M3-02 后可并行；
- M4-03 与 M4-01/M4-02 可并行。

**串行关键路径**：M0-01 → M0-02 → M1-01 → M1-02 → M1-06 → M1-08 → M1-10 → M2-01 → M2-02 → M2-03 → M2-07 → M2-08 → M3-01 → M3-02 → M3-05 → M4-01 → M4-02 → M4-04 → M4-05

---

## 7. 执行约定

1. 每个任务开工时在会话内用 todo 工具登记；完成后立即标记，不批量积压。
2. 带 ⚠️ 的任务需要本机环境；若环境缺失（herdr 未安装），先与用户确认再安装或调整范围。
3. 实现中若发现与 DESIGN.md 冲突的协议事实（如 M0-01 探测结果），先更新文档再继续。
4. 测试优先于实现的场景：CLI 适配器、jobs producer、事件映射表（M1-02、M2-03、M3-02）。
---

## 8. M5 补充：UI 展示（已完成）

（规划外补充，用户要求：插件有做 UI 部分的展示吗？）

- M5-01 工具调用卡片：14 个工具的 presentCall/presentResult（herdr_pane_run 终端卡片）
- M5-02 Herdr 视图 Tab：conversation.view slot 注册 id:'herdr'（客户端 client.tsx，
  window.__ModuleLoader__.load 包裹 + tsdown banner/footer）
- M5-03 状态面板：/herdr-status HTTP 端点（ctx.inject(['webServer']) 路由，
  HerdrStatusTracker 服务端轮询 agent.list + pane.read，2s）

## 9. M6：herdr 模式（新建会话时的模式开关）

> 用户要求：新建会话时增加一个 herdr 模式开关；开启后对话本身就是 Herdr 里的对话
> （agent 绑定 Herdr、状态上报 Herdr 侧边栏），而非从会话里开启 herdr。

### M6-01 preset 文件（S，✅）
- `presets/herdr/preset.yml`（展示名 "Herdr 模式"）+ `presets/herdr/agent.cordis.yml`
  （persona 行 + `dsh-plugin-herdr/session-mode` 行，paneId 可配）
- **验收**：preset id 合法、组合行引用真实插件名 → 已验证

### M6-02 安装器（S，✅）
- `src/preset-install.ts` ensureHerdrPreset()：复制到 `$DSH_HOME/.agent-presets/herdr/`
  （marker 幂等）；provider 插件 apply 时调用
- **验收**：服务器日志打印安装成功、落盘文件齐全 → 已验证；单测 3 项新增全过

### M6-03 会话模式插件（S，✅）
- `src/session-mode.ts`：dsh-plugin-herdr-session-mode（inject ['herdr']），
  绑定 pane（config.paneId 或焦点 pane）→ 初始 idle；agent/request→working；
  turn-stopping→idle；卸载 clearAgentAuthority
- **验收**：tsc 通过、build 产出 lib/session-mode.mjs、profile 解析包名成功 → 已验证

### M6-04 构建接线（S，✅）
- package.json：`./session-mode` export + files 含 presets；tsdown entry 增加 session-mode.ts
- **验收**：pnpm build 全量产物、pnpm pack 含 presets/ → 已构建验证

### M6-05 ⚠️ 端到端确认（待用户）
- 浏览器打开 Web UI → 新建会话 → 模式选择器出现 "Herdr 模式" 卡片
- 选择后会话创建成功，Herdr 侧边栏显示该 agent 状态（idle/working）随对话流转

**M6 结果回填**：M6-01~04 全部完成（构建、单测 47+3 全过、服务器实跑日志确认 preset 安装）；
M6-05 留待用户在浏览器确认。

---

## 10. M7：herdr 服务启动看板（M7-01 ~ M7-03）

> 需求：新建会话和会话页面增加"检查 herdr 服务是否已启动"的看板；未启动时提供启动按钮。

### M7-01 服务端探测与启动（S，✅）
- probeServer（`herdr status server --json` 解析 + 降级）、startHerdrServer
  （spawn `herdr server` + 轮询就绪，并发去重，spawn 错误 reject，超时返回末态）
- **验收**：单测 8 项（解析/降级/已运行/轮询成功/spawn 失败/超时）→ 全过

### M7-02 端点（S，✅）
- GET /herdr-status 增加 server 字段；POST /herdr-start（异步 handler）
- **验收**：E2E stop→not_running→start→running（web 进程 spawn 成功）→ 已验证

### M7-03 客户端看板（S，✅）
- Herdr Tab 看板条 + header 状态胶囊（conversation.session.header.actions）+
  hero（新建会话）浮层卡片（shell.overlay，data-phase=hero 检测）
- **验收**：bundle 构建含新代码（rev + 字符串断言）→ 已验证；浏览器视觉待用户确认

**M7 结果回填**：M7-01~03 全部完成（全套 58 单测全过、E2E 服务启停闭环）。

---

## 11. M8：会话成为 Herdr 的 pane（M8-01 ~ M8-03）

> 需求修正：开启 herdr 模式后，新建的 dsh 对话 session 应被作为 Herdr 的 pane（专属 pane + 侧边栏状态）。

### M8-01 根因与 standing mount 认知（S，✅）
- agent preset = standing mount：组合插件进程内单实例、服务所有加入的 agent；
  事件（agent/created 等）经 scope 载体投递，payload.agent.id 区分会话
- workspace.create 返回含 root_pane.pane_id（此前漏解析）
- **验收**：机制确认（源码阅读 + dsh-scope 注释）

### M8-02 session-mode 重写（S，✅）
- 按 agent id 维护绑定 Map；自动创建专属 pane（焦点 split > workspace root pane）；
  created→idle、request→working、turn-stopping→idle、disposed→release-agent
- **验收**：单测 7 项全过（含多会话隔离、降级不崩溃）

### M8-03 preset 同步更新（S，✅）
- ensureHerdrPreset 内容比对：相同跳过 / 不同备份 .herdr-bak-<ts> 后覆盖
- **验收**：单测 4 项（含备份语义）；服务器重启后 .dsh-home preset 自动更新

### M8-04 ⚠️ 真实环境确认（✅）
- 用户创建 herdr 模式会话 → 日志 `bound to new pane wB:p2 (split)`
- `herdr agent list` 显示 wB:p2 agent=dsh idle；snapshot 标记 (dsh)
- 对话进行中应显示 working（事件链由单测覆盖；用户可发消息确认）

**M8 结果回填**：M8-01~04 全部完成（66 单测全过 + 真实会话实抓确认）。

---

## 12. M9：session log 驱动的修复（M9-01 ~ M9-04）

> 依据：~/session.jsonl（真实 herdr 模式会话日志）分析发现的问题。

### M9-01 agentPrompt lossless JSON（S，✅）
- CLI/socket envelope 状态在 result.agent.agent_status；返回对象不再含 undefined 字段
- **验收**：真实 CLI 验证 `{submitted:true,status:'idle',waited_ms}`；回归测试

### M9-02 layout_apply 传输闸门（XS，✅）
- transport=cli 时不注册 herdr_layout_apply（模型不再误调用）
- **验收**：smoke 测试 13 工具断言

### M9-03 pane_run 输出净化（M，✅）
- pane.read 切 recent（scrollback）而非 visible（视口 23 行）；执行前基线快照 +
  前缀裁剪（剥尾部提示符）；剥离尾部提示符与前导空行
- **验收**：真实 pane 二次运行输出仅含本次命令；cli 测试 3 项更新 + 新增

### M9-04 专属 pane 清理（S，✅）
- 新增 paneClose；created pane 在 agent dispose/卸载时关闭（固定绑定仅 release）
- **验收**：服务器重启后旧 pane 自动清理（wB:p4 消失），pane 不累积；
  session-mode 测试 8 项（含固定 pane 不关闭）

**M9 结果回填**：M9-01~04 全部完成（69 单测全过 + 真实验证）。

---

## 13. M10：workspace / pane 列表（DSH 设计系统落地）

> 需求：原型（docs/prototype/herdr-panel.html）确认后，按 DSH 真实 UI 实现列表展示。

### M10-01 服务端 topology（S，✅）
- /herdr-status 新增 topology（workspaces/tabs/panes，snapshot 提取），tracker 2s 轮询
- **验收**：实抓返回完整层级

### M10-02 视图落地（M，✅）
- primitives 组件（StateDot/Pill/Button/TerminalBlock）+ 真实 token 布局
- workspace 折叠 / pane 展开 / 刷新按钮
- **验收**：构建通过、bundle external 正确、69 测试全过

### M10-03 类型与构建（S，✅）
- tsdown.web external 加 primitives；ambient 声明（client-primitives.d.ts）
- **验收**：tsc/tsdown 全过；boot 图含 primitives

**M10 结果回填**：M10-01~03 完成；浏览器渲染待用户确认。

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
