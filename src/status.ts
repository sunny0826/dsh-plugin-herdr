import { execFile, spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { HerdrClient } from './client/index.ts'
import { createLogger, createRateLimiter, errText } from './log.ts'

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


/** herdr CLI 可用性探测结果（安装检查）。 */
export interface HerdrCliInfo {
  /** cliPath 是否可执行（ENOENT 视为未安装）。 */
  available: boolean
  /** 探测使用的可执行路径。 */
  path: string
  /** herdr --version 首行（探测成功时）。 */
  version?: string
}

/** 服务端维护的完整快照（/herdr-status 返回值）。 */
export interface HerdrStatusSnapshot {
  agents: HerdrAgentStatus[]
  updated_at: number
  /** herdr 服务可用性（headless server 运行 + CLI 可用时方为 true）。 */
  connected: boolean
  /** herdr CLI 安装检查（未安装时客户端显示安装指引）。 */
  cli: HerdrCliInfo
  /** herdr headless server 运行状态（启动看板）。 */
  server: HerdrServerInfo
  /** workspace / tab / pane 拓扑（列表展示）。 */
  topology: HerdrTopology
  /** CA-012：最近一次轮询错误（诊断；null = 最近一轮无错误）。 */
  last_error: string | null
  /** CA-012：数据是否可能过期（距最近一次成功轮询超过 3×pollIntervalMs，或从未成功）。 */
  stale: boolean
}

const OUTPUT_CAP = 8000

/** herdr headless server 状态（`herdr status server --json`）。 */
export interface HerdrServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  socket: string | null
  session: string | null
  checked_at: number
}

/** execFile 函数形状（测试注入用）。 */
export type ExecFileFn = (cmd: string, args: string[], opts: { timeout: number }, cb: (err: Error | null, stdout: string) => void) => void

/** 探测 herdr headless server 是否运行（`herdr status server --json`；失败降级 unknown）。 */
export function probeServer(cliPath: string, execFn?: ExecFileFn): Promise<HerdrServerInfo> {
  const run = execFn ?? ((cmd, args, opts, cb) => execFile(cmd, args, opts, cb))
  return new Promise(resolve => {
    run(cliPath, ['status', 'server', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ status: 'unknown', running: false, version: null, protocol: null, socket: null, session: null, checked_at: Date.now() })
        return
      }
      try {
        const raw = JSON.parse(stdout.trim().split('\n')[0] ?? '{}') as Record<string, unknown>
        resolve({
          status: typeof raw.status === 'string' ? raw.status : 'unknown',
          running: raw.running === true,
          version: typeof raw.version === 'string' ? raw.version : null,
          protocol: typeof raw.protocol === 'number' ? raw.protocol : null,
          socket: typeof raw.socket === 'string' ? raw.socket : null,
          session: typeof raw.session === 'string' ? raw.session : null,
          checked_at: Date.now(),
        })
      } catch {
        resolve({ status: 'unknown', running: false, version: null, protocol: null, socket: null, session: null, checked_at: Date.now() })
      }
    })
  })
}

/**
 * 探测 herdr CLI：可执行存在即 available（--version 失败也算已安装，
 * 例如 Herdr pane 环境内 --version 行为异常；只有 ENOENT 视为未安装）。
 * execFn 供测试注入（默认 execFile）。
 */
export function probeCli(cliPath: string, execFn?: ExecFileFn): Promise<HerdrCliInfo> {
  const run = execFn ?? ((cmd, args, opts, cb) => execFile(cmd, args, opts, cb))
  return new Promise(resolve => {
    run(cliPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ available: false, path: cliPath })
        return
      }
      const first = stdout?.trim().split('\n')[0]
      resolve({ available: true, path: cliPath, version: first || undefined })
    })
  })
}

// ---------------------------------------------------------------------------
// 启动 herdr headless server（`herdr server`，spawn 后轮询就绪）
// ---------------------------------------------------------------------------

/** spawn 函数形状（测试注入用）。 */
export type SpawnFn = (cmd: string, args: string[], opts: { detached: boolean; stdio: 'ignore' }) => {
  unref(): void
  on(event: 'error', listener: (err: Error) => void): unknown
}

/** 探测函数形状（测试注入用）。 */
export type ServerProbeFn = (cliPath: string) => Promise<HerdrServerInfo>

let starting: Promise<HerdrServerInfo> | null = null

/**
 * 启动 herdr headless server 并轮询 `herdr status server --json` 直到 running
 * （或超时）。并发调用共享同一启动过程；已运行时直接返回当前状态。
 * spawn 失败（ENOENT 等）立即 reject；超时返回最后一次探测结果（running=false）。
 */
export function startHerdrServer(
  cliPath: string,
  opts: { timeoutMs?: number; spawnFn?: SpawnFn; probe?: ServerProbeFn } = {},
): Promise<HerdrServerInfo> {
  if (starting) return starting
  const spawnFn = opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, o) as ReturnType<SpawnFn>)
  const probe = opts.probe ?? probeServer
  const timeoutMs = opts.timeoutMs ?? 15000
  starting = (async () => {
    const before = await probe(cliPath)
    if (before.running) return before
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(cliPath, ['server'], { detached: true, stdio: 'ignore' })
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
      const info = await probe(cliPath)
      if (info.running) return info
      if (Date.now() >= deadline) return info
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
  private cliInfo: HerdrCliInfo = { available: false, path: 'herdr' }
  private serverInfo: HerdrServerInfo = { status: 'unknown', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
  private topologyInfo: HerdrTopology = { workspaces: [], tabs: [], panes: [] }
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
    private readonly cliPath: string,
    opts: { pollIntervalMs?: number; staleThresholdMs?: number; probeServerFn?: ServerProbeFn } = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000
    this.staleThresholdMs = opts.staleThresholdMs ?? this.pollIntervalMs * 3
    this.logger = createLogger(ctx, 'status')
    this.rateLimited = createRateLimiter(10_000)
    this.probeServerFn = opts.probeServerFn ?? probeServer
  }

  /** 测试注入用：server 状态探测（默认真实 probeServer）。 */
  private readonly probeServerFn: ServerProbeFn

  /** 探测 herdr CLI（启动时调用一次）。 */
  async probeCli(): Promise<HerdrCliInfo> {
    this.cliInfo = await probeCli(this.cliPath)
    return this.cliInfo
  }

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

  snapshot(): HerdrStatusSnapshot {
    const agents = [...this.agents.values()].sort((a, b) => comparePaneId(a.pane_id, b.pane_id))
    const stale = this.lastSuccessAt === 0 || Date.now() - this.lastSuccessAt > this.staleThresholdMs
    return {
      agents,
      updated_at: Date.now(),
      connected: this.cliInfo.available && this.serverInfo.running,
      cli: this.cliInfo,
      server: this.serverInfo,
      topology: this.topologyInfo,
      last_error: this.lastError,
      stale,
    }
  }

  /** 轮询 herdr headless server 状态（看板数据源；CLI 缺失时降级 unknown）。 */
  private async pollServer(signal: AbortSignal): Promise<void> {
    const info = await this.probeServerFn(this.cliPath)
    if (signal.aborted) return
    this.serverInfo = info
    // 探测降级（unknown/非 running）也记录诊断，便于 stale 排查
    if (info.status === 'unknown') {
      this.lastError = 'herdr server probe degraded (status unknown)'
      this.rateLimited('poll-server', () => this.logger.warn('herdr server probe degraded (status unknown)'))
    }
  }

  /** 轮询 snapshot 提取 workspace/tab/pane 拓扑（失败记录 last_error，下轮重试）。 */
  private async pollTopology(signal: AbortSignal): Promise<void> {
    try {
      const snap = await this.client.snapshot()
      if (signal.aborted) return
      this.topologyInfo = {
        workspaces: snap.workspaces.map(w => ({
          workspace_id: (w as { workspace_id?: string }).workspace_id ?? '',
          label: (w as { label?: string }).label,
          active_tab_id: (w as { active_tab_id?: string }).active_tab_id,
        })),
        tabs: snap.tabs.map(t => ({
          tab_id: (t as { tab_id?: string }).tab_id ?? '',
          workspace_id: (t as { workspace_id?: string }).workspace_id ?? '',
          label: (t as { label?: string }).label,
          active_pane_id: (t as { active_pane_id?: string }).active_pane_id,
          pane_count: (t as { pane_count?: number }).pane_count,
        })),
        panes: snap.panes.map(p => ({
          pane_id: (p as { pane_id?: string }).pane_id ?? '',
          workspace_id: (p as { workspace_id?: string }).workspace_id ?? '',
          tab_id: (p as { tab_id?: string }).tab_id,
          title: (p as { title?: string }).title ?? (p as { terminal_title?: string }).terminal_title,
          cwd: (p as { cwd?: string }).cwd,
          foreground_cwd: (p as { foreground_cwd?: string }).foreground_cwd,
          focused: (p as { focused?: boolean }).focused === true,
          agent_status: (p as { agent_status?: string }).agent_status,
        })),
      }
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
        const { text } = await this.client.paneRead({ pane_id: paneId, source: 'recent', lines: 300 })
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
