import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { HerdrClient } from './client/index.ts'
import { HerdrError } from './client/error.ts'
import { socketPing } from './client/socket.ts'
import { createLogger, createRateLimiter, errText } from './log.ts'
import { isPathWithinProject } from './paths.ts'
import { getBoundPaneIds } from './binding-registry.ts'

/** 面板展示的单个 agent 状态块（wire JSON，客户端直接消费）。 */
export interface HerdrAgentStatus {
  pane_id: string
  workspace_id?: string
  agent: string
  status: string
  message?: string
  /** 最近输出（只读；服务端轮询 pane.read 的全量快照，上限截断）。 */
  output: string
  updated_at: number
}

/** workspace 拓扑（snapshot 提取，wire JSON）。 */
export interface HerdrWorkspaceView {
  workspace_id: string
  label?: string
  active_tab_id?: string
  /** worktree.checkout_path（幂等筛选的第 2 判据，§7.2）。 */
  checkout_path?: string
}

/** tab 拓扑。 */
export interface HerdrTabView {
  tab_id: string
  workspace_id: string
  label?: string
  active_pane_id?: string
  pane_count?: number
}

/** pane 拓扑（snapshot 提取，供 workspace/pane 列表展示）。 */
export interface HerdrPaneView {
  pane_id: string
  workspace_id: string
  tab_id?: string
  title?: string
  label?: string
  cwd?: string
  foreground_cwd?: string
  focused: boolean
  agent_status?: string
}

/** Herdr 拓扑快照（workspaces → tabs → panes 层级）。 */
export interface HerdrTopology {
  workspaces: HerdrWorkspaceView[]
  tabs: HerdrTabView[]
  panes: HerdrPaneView[]
}

/** 看板目录过滤元数据（design-v2 §7.3）。matched/total 以全量为口径，与 scope 无关。 */
export interface HerdrFilterInfo {
  /** 判定的项目根（缺省 process.cwd()）。 */
  project_root: string
  /** 留下的 workspace 数。 */
  matched: number
  /** 全部 workspace 数。 */
  total: number
  /** 被剔除的 workspace_id 列表。 */
  hidden_workspaces: string[]
}


/** 服务端维护的完整快照（/herdr-status 返回值）。 */
export interface HerdrStatusSnapshot {
  agents: HerdrAgentStatus[]
  updated_at: number
  /** herdr 服务可用性（socket ping 成功时方为 true）。 */
  connected: boolean
  /** herdr headless server 运行状态（socket ping 派生；启动看板）。 */
  server: HerdrServerInfo
  /** workspace / tab / pane 拓扑（列表展示）。 */
  topology: HerdrTopology
  /** CA-012：最近一次轮询错误（诊断；null = 最近一轮无错误）。 */
  /** 目录过滤元数据（§7.3）。 */
  filter: HerdrFilterInfo
  last_error: string | null
  /** CA-012：数据是否可能过期（距最近一次成功轮询超过 3×pollIntervalMs，或从未成功）。 */
  stale: boolean
}

const OUTPUT_CAP = 8000

/**
 * herdr headless server 状态（socket ping 派生；全量迁移后不再调用
 * `herdr status server --json`——version/protocol 由 pong 提供）。
 */
export interface HerdrServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  socket: string | null
  session: string | null
  checked_at: number
}

/** ping 探测函数形状（测试注入用）；null = 服务器不可达。 */
export type PingProbeFn = () => Promise<{ version: string; protocol: number } | null>

// ---------------------------------------------------------------------------
// 启动 herdr headless server（`herdr server`，spawn 后轮询就绪）
// ---------------------------------------------------------------------------

/** spawn 函数形状（测试注入用）。 */
export type SpawnFn = (cmd: string, args: string[], opts: { detached: boolean; stdio: 'ignore' }) => {
  unref(): void
  on(event: 'error', listener: (err: Error) => void): unknown
}

let starting: Promise<HerdrServerInfo> | null = null

/** ping 结果 → HerdrServerInfo（socket/session 由调用方解析配置提供）。 */
export function serverInfoFromPing(
  ping: { version: string; protocol: number } | null,
  socketPath: string | null,
  session: string | null,
  status: 'running' | 'not_running',
): HerdrServerInfo {
  return {
    status,
    running: status === 'running',
    version: ping?.version ?? null,
    protocol: ping?.protocol ?? null,
    socket: socketPath,
    session,
    checked_at: Date.now(),
  }
}

/**
 * 启动 herdr headless server（D1：全插件唯一的 CLI spawn 引导例外——协议无
 * server.start，socket 无法启动自身）。spawn `herdr server` 后轮询 socket ping
 * 直到可达（或超时）。并发调用共享同一启动过程；已运行时直接返回当前状态。
 * spawn 失败（ENOENT 等）立即 reject；超时返回未运行状态（running=false）。
 */
export function startHerdrServer(
  socketPath: string,
  opts: { binPath?: string; session?: string | null; timeoutMs?: number; spawnFn?: SpawnFn; probe?: PingProbeFn } = {},
): Promise<HerdrServerInfo> {
  if (starting) return starting
  const binPath = opts.binPath ?? 'herdr'
  const spawnFn = opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, o) as ReturnType<SpawnFn>)
  const probe = opts.probe ?? (() => socketPing(socketPath))
  const timeoutMs = opts.timeoutMs ?? 15000
  const session = opts.session ?? null
  starting = (async () => {
    const before = await probe()
    if (before) return serverInfoFromPing(before, socketPath, session, 'running')
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(binPath, ['server'], { detached: true, stdio: 'ignore' })
    } catch (e) {
      throw new Error(`herdr server spawn failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    child.unref()
    const spawnError = new Promise<never>((_resolve, reject) => {
      child.on('error', err => reject(new Error(`herdr server spawn failed: ${err.message}`)))
    })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const signal = await Promise.race([
        spawnError,
        new Promise<'tick'>(res => setTimeout(() => res('tick'), 500)),
      ])
      void signal
      const info = await probe()
      if (info) return serverInfoFromPing(info, socketPath, session, 'running')
      if (Date.now() >= deadline) return serverInfoFromPing(null, socketPath, session, 'not_running')
    }
  })().finally(() => {
    starting = null
  })
  return starting
}

/** pane_id 自然排序（w8:p2 < w8:p10）：workspace 字典序 + pane 数字序。 */
export function comparePaneId(a: string, b: string): number {
  const [wa, pa] = a.split(':')
  const [wb, pb] = b.split(':')
  if (wa !== wb) return wa < wb ? -1 : 1
  const na = Number((pa ?? '').replace(/\D/g, '')) || 0
  const nb = Number((pb ?? '').replace(/\D/g, '')) || 0
  return na - nb
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 项目目录过滤（design-v2 §7.2，纯函数，可单测）。
 * workspace 命中条件（任一）：worktree.checkout_path 在项目内 或 任一 pane 的
 * cwd/foreground_cwd 在项目内（isPathWithinProject）；self pane 豁免：包含任一
 * 已绑定 pane 的 workspace 无条件保留。命中则整组（tabs/panes）保留。
 * 返回过滤后拓扑 + filter 元数据；无项目根（空串）时返回全量且不剔除。
 */
export function filterTopology(
  topology: HerdrTopology,
  projectRoot: string,
  boundPaneIds: string[],
): { filtered: HerdrTopology; filterInfo: HerdrFilterInfo } {
  const total = topology.workspaces.length
  // 预设返回：无项目根（空串）→ 全量保留，无剔除
  const none: HerdrFilterInfo = { project_root: projectRoot, matched: total, total, hidden_workspaces: [] }
  if (projectRoot === '') return { filtered: topology, filterInfo: none }

  const bound = new Set(boundPaneIds)
  const wsIdToPanes = new Map<string, HerdrPaneView[]>()
  for (const p of topology.panes) {
    const arr = wsIdToPanes.get(p.workspace_id) ?? []
    arr.push(p)
    wsIdToPanes.set(p.workspace_id, arr)
  }

  const keep = new Set<string>()
  const hidden: string[] = []
  for (const w of topology.workspaces) {
    const panes = wsIdToPanes.get(w.workspace_id) ?? []
    // self pane 豁免：任一已绑定 pane 在本 workspace → 无条件保留（防本对话 pane 消失）
    if (panes.some(p => bound.has(p.pane_id))) {
      keep.add(w.workspace_id)
      continue
    }
    // §7.2 命中：worktree.checkout_path 在项目内 或 任一 pane 的 cwd/foreground_cwd 在项目内
    const hit =
      isPathWithinProject(projectRoot, w.checkout_path) ||
      panes.some(p =>
        isPathWithinProject(projectRoot, p.cwd) ||
        isPathWithinProject(projectRoot, p.foreground_cwd))
    if (hit) keep.add(w.workspace_id)
    else hidden.push(w.workspace_id)
  }

  return {
    filtered: {
      workspaces: topology.workspaces.filter(w => keep.has(w.workspace_id)),
      tabs: topology.tabs.filter(t => keep.has(t.workspace_id)),
      panes: topology.panes.filter(p => keep.has(p.workspace_id)),
    },
    filterInfo: { project_root: projectRoot, matched: keep.size, total, hidden_workspaces: hidden },
  }
}

/**
 * Herdr 状态跟踪器：维护所有检测到的 agent 的状态与最近输出。
 * - 状态：消费 forward 转发的 herdr/* 事件 + 轮询 agent.list 兜底；
 * - 输出：定期轮询各 agent pane 的 pane.read；
 * - 安装检查：启动时探测 herdr CLI（未安装时面板显示安装指引）。
 *
 * CA-012 轮询纪律：首次立即 tick；单飞（上一轮未完成则跳过本轮）；
 * 停止时 abort 在途轮询（结果不再落盘）；快照携带 last_error/stale 诊断。
 */
export class HerdrStatusTracker {
  private readonly agents = new Map<string, HerdrAgentStatus>()
  private timer: NodeJS.Timeout | null = null
  private readonly pollIntervalMs: number
  private serverInfo: HerdrServerInfo = { status: 'unknown', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
  // 双拓扑（design-v2 §7.3）：full 全量 + filtered 按项目目录过滤
  private fullTopology: HerdrTopology = { workspaces: [], tabs: [], panes: [] }
  private filteredTopology: HerdrTopology = { workspaces: [], tabs: [], panes: [] }
  // 目录过滤元数据（§7.2）：{matched,total,hidden}
  private filterInfo: HerdrFilterInfo = {
    project_root: '',
    matched: 0,
    total: 0,
    hidden_workspaces: [],
  }
  // CA-012：在途轮询周期（单飞 guard）与取消控制器
  private cycle: Promise<void> | null = null
  private abort: AbortController | null = null
  private lastError: string | null = null
  private lastSuccessAt = 0
  private readonly staleThresholdMs: number
  // CA-017：轮询错误与 stale 转迁限流告警
  private readonly rateLimited: (key: string, fn: () => void) => void
  private readonly logger: ReturnType<typeof createLogger>
  private staleLogged = false

  constructor(
    private readonly ctx: Context,
    private readonly client: HerdrClient,
    opts: {
      pollIntervalMs?: number
      staleThresholdMs?: number
      /** socket 路径（看板 server.socket 展示；缺省 null）。 */
      socketPath?: string | null
      /** 会话名（看板 server.session 展示；缺省 null）。 */
      session?: string | null
      /** ping 探测（测试注入用；缺省 client.ping 包装：连接类失败 → null=未运行）。 */
      pingFn?: PingProbeFn
      /** 项目根（过滤用；缺省 process.cwd()，§7.2）。注入便于测试。 */
      projectRoot?: string
      /** self pane 豁免：枚举已绑定 pane_id（缺省走 binding-registry；注入便于测试）。 */
      getBoundPaneIds?: () => string[]
    } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000
    this.staleThresholdMs = opts.staleThresholdMs ?? this.pollIntervalMs * 3
    this.logger = createLogger(ctx, 'status')
    this.rateLimited = createRateLimiter(10_000)
    this.socketPath = opts.socketPath ?? null
    this.session = opts.session ?? null
    this.pingFn = opts.pingFn ?? (async () => {
      try {
        const p = await client.ping()
        return { version: p.version, protocol: p.protocol }
      } catch (err) {
        // 连接类失败（socket 不存在/拒绝）→ 未运行；协议类失败才视为探测错误
        if (err instanceof HerdrError && err.code === 'HERDR_UNAVAILABLE') return null
        throw err
      }
    })
    this.projectRoot = opts.projectRoot ?? process.cwd()
    this.boundPaneIdsFn = opts.getBoundPaneIds ?? getBoundPaneIds
    this.filterInfo.project_root = this.projectRoot
  }

  /** socket 路径（看板 server.socket 展示）。 */
  private readonly socketPath: string | null
  /** 会话名（看板 server.session 展示）。 */
  private readonly session: string | null
  /** 项目根（过滤基准）。 */
  private readonly projectRoot: string
  /** self pane 豁免的已绑定 pane_id 来源（可注入）。 */
  private readonly boundPaneIdsFn: () => string[]

  /** ping 探测（默认真实 client.ping 包装）。 */
  private readonly pingFn: PingProbeFn

  /** 消费 herdr/agent-state 事件（forward.ts 发出）。 */
  onAgentState(info: { pane_id: string; agent: string; status: string; message?: string }): void {
    const prev = this.agents.get(info.pane_id)
    this.agents.set(info.pane_id, {
      pane_id: info.pane_id,
      agent: info.agent,
      status: info.status,
      message: info.message,
      output: prev?.output ?? '',
      updated_at: Date.now(),
    })
  }

  /** 消费 herdr/resource-changed 事件：pane 关闭时移除对应块。 */
  onResourceChanged(change: { type: string; action: string; id: string }): void {
    if (change.type === 'pane' && change.action === 'closed') {
      this.agents.delete(change.id)
    }
  }

  /** 后台轮询：server 状态 + 拓扑 + agent 列表（兜底）+ 各 pane 输出。 */
  start(): void {
    if (this.timer) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    const tick = () => this.runCycle(signal)
    // CA-012：首次立即 tick（不等第一个 interval）
    tick()
    this.timer = setInterval(tick, this.pollIntervalMs)
  }

  /** CA-012：停止轮询并取消在途请求（结果不再落盘）。幂等。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abort?.abort()
    this.abort = null
  }

  /**
   * CA-012：单飞轮询周期——上一轮未完成则跳过本轮（慢请求不再跨 tick 重叠）；
   * 四类轮询在同一周期内并行（并发上限 = 4），周期级串行。
   */
  private runCycle(signal: AbortSignal): void {
    if (this.cycle) return
    this.cycle = (async () => {
      const errorBefore = this.lastError
      try {
        await Promise.all([
          this.pollServer(signal),
          this.pollTopology(signal),
          this.pollAgents(signal),
          this.pollOutputs(signal),
        ])
        // CA-012：仅当本轮无任何轮询错误时才视为“成功刷新”（stale 据此判定）
        if (!signal.aborted && this.lastError === errorBefore) {
          // codex review P2：成功周期显式清空旧错误——一次故障后 last_error 不得永久保留
          this.lastError = null
          this.lastSuccessAt = Date.now()
          this.staleLogged = false
        } else if (!signal.aborted) {
          // CA-017：stale 转迁有级别与上下文（只在转迁时告警一次，恢复时复位）
          if (!this.staleLogged && this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt > this.staleThresholdMs) {
            this.staleLogged = true
            this.logger.warn('status snapshot stale (last clean refresh %dms ago): %s', Date.now() - this.lastSuccessAt, this.lastError ?? '')
          }
        }
      } finally {
        this.cycle = null
      }
    })()
  }

  /**
   * 看板数据快照。
   * @param scope 'project'（默认）返回按项目目录过滤后的 topology；'all' 返回全量。
   *              两种 scope 都附带 filter 元数据（matched/total 以全量为口径）。
   */
  snapshot(scope: 'all' | 'project' = 'project'): HerdrStatusSnapshot {
    const agents = [...this.agents.values()].sort((a, b) => comparePaneId(a.pane_id, b.pane_id))
    const stale = this.lastSuccessAt === 0 || Date.now() - this.lastSuccessAt > this.staleThresholdMs
    return {
      agents,
      updated_at: Date.now(),
      connected: this.serverInfo.running,
      server: this.serverInfo,
      topology: scope === 'all' ? this.fullTopology : this.filteredTopology,
      last_error: this.lastError,
      stale,
      filter: this.filterInfo,
    }
  }

  /** 轮询 herdr headless server 状态（看板数据源；socket ping 派生）。 */
  private async pollServer(signal: AbortSignal): Promise<void> {
    try {
      const ping = await this.pingFn()
      if (signal.aborted) return
      this.serverInfo = serverInfoFromPing(ping, this.socketPath, this.session, ping ? 'running' : 'not_running')
    } catch (err) {
      // 探测失败（协议类）→ 降级 unknown 并记录诊断，便于 stale 排查
      if (!signal.aborted) {
        this.serverInfo = { status: 'unknown', running: false, version: null, protocol: null, socket: this.socketPath, session: this.session, checked_at: Date.now() }
        this.lastError = `server probe failed: ${errMsg(err)}`
        this.rateLimited('poll-server', () => this.logger.warn('server probe failed: %s', errMsg(err)))
      }
    }
  }

  /** 轮询 snapshot 提取 workspace/tab/pane 拓扑（失败记录 last_error，下轮重试）。 */
  private async pollTopology(signal: AbortSignal): Promise<void> {
    try {
      const snap = await this.client.snapshot()
      if (signal.aborted) return
      const full: HerdrTopology = {
        workspaces: snap.workspaces.map(w => {
          // worktree.checkout_path 作 §7.2 第二判据（快照 WorkspaceInfo.worktree）
          const wt = (w as { worktree?: { checkout_path?: string } | null }).worktree
          return {
            workspace_id: (w as { workspace_id?: string }).workspace_id ?? '',
            label: (w as { label?: string }).label,
            active_tab_id: (w as { active_tab_id?: string }).active_tab_id,
            checkout_path: wt?.checkout_path,
          }
        }),
        tabs: snap.tabs.map(t => ({
          tab_id: (t as { tab_id?: string }).tab_id ?? '',
          workspace_id: (t as { workspace_id?: string }).workspace_id ?? '',
          label: (t as { label?: string }).label,
          active_pane_id: (t as { active_pane_id?: string }).active_pane_id,
          pane_count: (t as { pane_count?: number }).pane_count,
        })),
        panes: snap.panes.map(p => {
          // label 来自 snapshot PaneInfo.label（rename 后即时，T01 实测）
          const src = p as { pane_id?: string; workspace_id?: string; tab_id?: string; title?: string; terminal_title?: string; label?: string; cwd?: string; foreground_cwd?: string; focused?: boolean; agent_status?: string }
          return {
            pane_id: src.pane_id ?? '',
            workspace_id: src.workspace_id ?? '',
            tab_id: src.tab_id,
            title: src.title ?? src.terminal_title,
            label: src.label,
            cwd: src.cwd,
            foreground_cwd: src.foreground_cwd,
            focused: src.focused === true,
            agent_status: src.agent_status,
          }
        }),
      }
      // self pane 豁免依赖最新已绑定 pane id（属性型正则调用，成本低）
      const { filtered, filterInfo } = filterTopology(full, this.projectRoot, this.boundPaneIdsFn())
      this.fullTopology = full
      this.filteredTopology = filtered
      this.filterInfo = filterInfo
    } catch (err) {
      if (!signal.aborted) {
        this.lastError = `topology poll failed: ${errMsg(err)}`
        this.rateLimited('poll-topology', () => this.logger.warn('topology poll failed: %s', errMsg(err)))
      }
    }
  }

  /** 轮询 agent.list 更新状态（事件接入是加速路径，轮询是兜底）。 */
  private async pollAgents(signal: AbortSignal): Promise<void> {
    try {
      const agents = await this.client.listAgents()
      if (signal.aborted) return
      const seen = new Set<string>()
      for (const a of agents) {
        if (!a.pane_id) continue
        seen.add(a.pane_id)
        const prev = this.agents.get(a.pane_id)
        const status = a.status ?? 'unknown'
        this.agents.set(a.pane_id, {
          pane_id: a.pane_id,
          workspace_id: a.workspace_id,
          agent: a.agent ?? 'unknown',
          status,
          message: a.message ?? undefined,
          output: prev?.output ?? '',
          updated_at: prev && prev.status === status ? prev.updated_at : Date.now(),
        })
      }
      // 消失的 pane 清理
      for (const key of [...this.agents.keys()]) {
        if (!seen.has(key)) this.agents.delete(key)
      }
    } catch (err) {
      if (!signal.aborted) {
        this.lastError = `agent poll failed: ${errMsg(err)}`
        this.rateLimited('poll-agents', () => this.logger.warn('agent poll failed: %s', errMsg(err)))
      }
    }
  }

  private async pollOutputs(signal: AbortSignal): Promise<void> {
    for (const [paneId, agent] of this.agents) {
      if (signal.aborted) return
      try {
        // 实测（env-findings v2）：recent_unwrapped 是 herdr 原生未折行快照（逻辑行），
        // 避免窄终端（约 35~40 列）折行导致卡片日志每行过短、右侧大片空白
        const { text } = await this.client.paneRead({ pane_id: paneId, source: 'recent_unwrapped', lines: 300 })
        if (signal.aborted) return
        const current = agent.output
        // 仅当内容变化时更新（避免无谓的 updated_at 抖动）
        if (text !== current) {
          agent.output = text.slice(-OUTPUT_CAP)
          agent.updated_at = Date.now()
        }
      } catch (err) {
        // 单个 pane 读取失败忽略（pane 可能已关闭，由 resource-changed 清理）；记录诊断
        if (!signal.aborted) {
          this.lastError = `pane read failed (${paneId}): ${errMsg(err)}`
          this.rateLimited('poll-outputs', () => this.logger.warn('pane read failed (%s): %s', paneId, errMsg(err)))
        }
      }
    }
  }
}
