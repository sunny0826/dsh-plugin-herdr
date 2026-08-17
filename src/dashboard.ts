// Herdr Dashboard 服务端采集（design: dashboard §4 —— 本机只读控制面总览）。
//
// 拓扑 / agent / server 状态**复用** HerdrStatusTracker 的单飞轮询结果
// （readStatus: () => tracker.snapshot('all')，全量、不按项目过滤），Dashboard 自身
// 不再重复打 socket，避免两套无限轮询。Dashboard 自己只做：
//   1) host 元数据（node:os，进程内一次采集）；
//   2) POSIX best-effort 进程探测（pgrep/ps，macOS/Linux；失败/不支持 → unavailable，
//      携带 source/reason，绝不返回伪造数值）；
//   3) 归一化 DTO 装配（聚合纯函数在 src/client-logic.ts，可 node:test 直测）。
//
// 失败语义：进程探测有独立超时（≤1.5s）且与装配并行，不阻塞状态读取；拓扑始终来自
// status tracker 的“最后一份有效快照”（失败不覆盖）；stop() 中止在途探测且结果不落盘。

import { execFile } from 'node:child_process'
import { arch, hostname, platform, release, type as osType } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  aggregateDashboardWorkspaces,
  buildDashboardSummary,
  deriveStale,
  pathBase,
  shouldProbeNow,
  type DashboardAgentLike,
  type DashboardSummaryLike,
  type DashboardTopologyLike,
  type DashboardWorkspaceAgg,
} from './client-logic.ts'
import { createLogger, createRateLimiter, errText } from './log.ts'

// ---------------------------------------------------------------------------
// DTO 类型（wire JSON；Web 侧镜像于 src/web/dashboard-types.ts）
// ---------------------------------------------------------------------------

/** host 基础信息（node:os；仅必要字段，不采集用户数据）。 */
export interface HerdrDashboardHost {
  hostname: string
  platform: string
  arch: string
  os_type: string
  os_release: string
  node_version: string
}

/**
 * Herdr server 进程采样（best-effort）。任何字段不可靠 → null，
 * available=false 时 UI 显示 Unavailable 并附 source/error，绝不伪造数值。
 */
export interface HerdrDashboardProcess {
  available: boolean
  pid: number | null
  started_at: number | null
  cpu_percent: number | null
  rss_bytes: number | null
  /** 采集来源标识（如 'posix-pgrep-ps'；unavailable 时仍标注探测方法）。 */
  source: string | null
  sampled_at: number
  error: string | null
}

/** server 状态（socket ping 派生；socket 路径已脱敏为 basename）。 */
export interface HerdrDashboardServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  socket: string | null
  session: string | null
  checked_at: number
  /** Herdr CLI/server binary 可用性（PATH fs.access 探测）。 */
  installation: 'installed' | 'missing' | 'unknown'
}

/** socket 连接与各采集器状态（socket 可达 ≠ 每项指标都新鲜）。 */
export interface HerdrDashboardConnection {
  connected: boolean
  last_success_at: number
  collectors: {
    server: boolean
    topology: boolean
    agents: boolean
    host: boolean
    process: boolean
  }
}

/** Dashboard 响应 DTO（GET /herdr-dashboard，只读）。 */
export interface HerdrDashboardSnapshot {
  updated_at: number
  stale: boolean
  last_error: string | null
  server: HerdrDashboardServerInfo
  connection: HerdrDashboardConnection
  host: HerdrDashboardHost
  process: HerdrDashboardProcess
  summary: DashboardSummaryLike
  workspaces: DashboardWorkspaceAgg[]
}

/** status tracker 快照的最小形状（HerdrStatusSnapshot 结构兼容）。 */
export interface HerdrDashboardStatusSource {
  connected: boolean
  stale: boolean
  last_error: string | null
  server: {
    status: string
    running: boolean
    version: string | null
    protocol: number | null
    socket: string | null
    session: string | null
    checked_at: number
    installation: 'installed' | 'missing' | 'unknown'
  }
  topology: DashboardTopologyLike
  agents: ReadonlyArray<DashboardAgentLike>
}

// ---------------------------------------------------------------------------
// host 采集（node:os，进程内一次）
// ---------------------------------------------------------------------------

/** host 元数据采集（测试可注入）。 */
export function collectHostInfo(): HerdrDashboardHost {
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    os_type: osType(),
    os_release: release(),
    node_version: process.version,
  }
}

// ---------------------------------------------------------------------------
// POSIX best-effort 进程探测（pgrep + ps；macOS/Linux）
// ---------------------------------------------------------------------------

/** 进程探测函数形状（测试注入用）。 */
export type ProcessProbeFn = (signal: AbortSignal) => Promise<HerdrDashboardProcess>

// ---------------------------------------------------------------------------
// ps/pgrep 输出解析（纯函数，node:test 直接覆盖）
// ---------------------------------------------------------------------------

/** pgrep 输出（每行一个 pid）→ PID 数组（空/无匹配 → []；非数字行忽略）。 */
export function parsePgrepOutput(stdout: string): number[] {
  return stdout.trim().split(/\s+/)
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0)
}

/** ps -o 'pid=,%cpu=,rss=,lstart=' 单行输出 → 解析记录；无法解析 → null。 */
export interface PsSampleLine {
  ps_pid: number
  cpu_percent: number
  rss: number
  lstart: string
}

export function parsePsOutput(stdout: string): PsSampleLine | null {
  const m = stdout.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
  if (!m) return null
  const [, pidRaw, cpuRaw, rssRaw, lstart] = m
  const psPid = Number(pidRaw)
  const cpuPercent = Number.parseFloat(cpuRaw)
  const rss = Number.parseInt(rssRaw, 10)
  if (!Number.isInteger(psPid) || Number.isNaN(cpuPercent) || Number.isNaN(rss)) return null
  return { ps_pid: psPid, cpu_percent: cpuPercent, rss, lstart }
}

/** 进程不可用样本（available=false；error 说明原因，不伪造数值）。 */
function unavailableProcess(sampledAt: number, error: string, extra: Partial<HerdrDashboardProcess> = {}): HerdrDashboardProcess {
  return {
    available: false,
    pid: null,
    started_at: null,
    cpu_percent: null,
    rss_bytes: null,
    source: 'posix-pgrep-ps',
    sampled_at: sampledAt,
    error,
    ...extra,
  }
}

/**
 * execFile 文本封装：成功 → stdout；失败 → null。
 * pgrep 退出码 1 = 无匹配（正常结果，返回 ''）；killed（超时/中止）与其它错误 → null。
 */
function execFileText(cmd: string, args: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, [...args], { timeout: timeoutMs, windowsHide: true, signal }, (err, stdout) => {
      if (!err) {
        resolve(String(stdout))
        return
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
      if (typeof e.code === 'number' && e.code === 1) {
        resolve('') // pgrep 无匹配（ps 无该 pid 也走此处 → 解析失败 → unavailable）
        return
      }
      resolve(null) // ENOENT / 超时 / 中止 / 其它退出码
    })
  })
}

/**
 * POSIX best-effort 进程探测：pgrep 定位 herdr server PID（优先 argv 精确 'herdr server'，
 * 回退进程名 'herdr'；多实例取第一个，best-effort），ps 采样 CPU/RSS/启动时间。
 * - 平台非 darwin/linux → unavailable（不支持，不猜测）；
 * - pgrep 无匹配 → unavailable（未运行或进程名不匹配）；
 * - RSS 单位：darwin/linux 的 ps -o rss= 均为 KB（实测：macOS bash ≈2016KB、herdr ≈5792KB），
 *   统一 ×1024 归一为字节；
 * - 任一项解析失败 → 该项 null（UI 显示 Unavailable），不伪造 0/猜测值；
 * - 超时（1.5s）或中止 → unavailable，且调用方在 abort 时丢弃结果。
 */
export async function probeHerdrProcess(signal: AbortSignal): Promise<HerdrDashboardProcess> {
  const sampledAt = Date.now()
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return unavailableProcess(sampledAt, `process probing unsupported on platform ${process.platform}`)
  }
  // 1) 定位 server 进程
  let pid: number | null = null
  for (const args of [['-f', 'herdr server'], ['-x', 'herdr']] as const) {
    const out = await execFileText('pgrep', [...args], 1500, signal)
    if (out === null) return unavailableProcess(sampledAt, 'process probe failed (pgrep unavailable or timed out)')
    const pids = parsePgrepOutput(out)
    if (pids.length > 0) {
      pid = pids[0]
      break
    }
  }
  if (pid === null) return unavailableProcess(sampledAt, 'herdr server process not found (is the server running?)')
  // 2) ps 采样 CPU/RSS/启动时间（lstart 为 C locale 英文格式，Date.parse 可解析）
  const out = await execFileText('ps', ['-p', String(pid), '-o', 'pid=,%cpu=,rss=,lstart='], 1500, signal)
  if (out === null) return unavailableProcess(sampledAt, 'process probe failed (ps timed out or unavailable)', { pid })
  const parsed = parsePsOutput(out)
  if (!parsed) return unavailableProcess(sampledAt, `ps output unparseable for pid ${pid}`, { pid })
  if (parsed.ps_pid !== pid) return unavailableProcess(sampledAt, 'ps returned a different pid than pgrep', { pid })
  const startedAt = Date.parse(parsed.lstart)
  return {
    available: true,
    pid,
    started_at: Number.isNaN(startedAt) ? null : startedAt,
    cpu_percent: parsed.cpu_percent,
    rss_bytes: Number.isNaN(parsed.rss) ? null : parsed.rss * 1024,
    source: 'posix-pgrep-ps',
    sampled_at: sampledAt,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// HerdrDashboardTracker
// ---------------------------------------------------------------------------

export interface HerdrDashboardTrackerOptions {
  /** 状态快照来源（缺省要求注入；index.ts 传 () => statusTracker.snapshot('all')）。 */
  readStatus: () => HerdrDashboardStatusSource
  pollIntervalMs?: number
  staleThresholdMs?: number
  /** 进程探测（测试注入用；缺省 probeHerdrProcess）。 */
  probeProcess?: ProcessProbeFn
  /** 进程探测最小间隔（ms；节流：socket 数据 2s 刷新，进程采样 ≥15s 一次，避免频繁 ps/pgrep）。 */
  probeIntervalMs?: number
  /** host 元数据采集（测试注入用；缺省 collectHostInfo）。 */
  collectHost?: () => HerdrDashboardHost
}

/** 未完成任何周期时的空 DTO（host 恒可用；其余 unavailable/空，结构完整）。 */
function emptyDashboardSnapshot(host: HerdrDashboardHost): HerdrDashboardSnapshot {
  return {
    updated_at: 0,
    stale: true,
    last_error: null,
    server: {
      status: 'unknown',
      running: false,
      version: null,
      protocol: null,
      socket: null,
      session: null,
      checked_at: 0,
      installation: 'unknown',
    },
    connection: {
      connected: false,
      last_success_at: 0,
      collectors: { server: false, topology: false, agents: false, host: true, process: false },
    },
    host,
    process: unavailableProcess(0, 'no process sample yet'),
    summary: { workspaces: 0, tabs: 0, panes: 0, agents: 0, agents_by_status: {} },
    workspaces: [],
  }
}

/**
 * Dashboard 采集器：复用 status tracker 的单飞快照 + 自身 host/进程采集，装配 DTO。
 * CA-012 纪律与 status tracker 一致：首次立即 tick；单飞（上一轮未完成跳过）；
 * 停止时 abort 在途探测（结果不落盘）；失败不覆盖最后一份有效 DTO 拓扑。
 */
export class HerdrDashboardTracker {
  private timer: NodeJS.Timeout | null = null
  private cycle: Promise<void> | null = null
  private abort: AbortController | null = null
  private lastDto: HerdrDashboardSnapshot | null = null
  /** 观察到的最近一次干净刷新（status 源 stale=false）；0 = 从未。 */
  private lastSuccessAt = 0
  /** 最近一次进程探测错误（成功周期清空）。 */
  private probeError: string | null = null
  /** 进程探测节流状态（≥probeIntervalMs 才重新 spawn ps/pgrep；期间复用上次样本）。 */
  private lastProbeAt = 0
  private lastProbeSample: HerdrDashboardProcess | null = null
  private readonly host: HerdrDashboardHost
  private readonly pollIntervalMs: number
  private readonly staleThresholdMs: number
  private readonly probeIntervalMs: number
  private readonly probeFn: ProcessProbeFn
  private readonly rateLimited: (key: string, fn: () => void) => void
  private readonly logger: ReturnType<typeof createLogger>

  constructor(
    private readonly ctx: Context,
    private readonly opts: HerdrDashboardTrackerOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000
    this.staleThresholdMs = opts.staleThresholdMs ?? this.pollIntervalMs * 3
    this.probeIntervalMs = opts.probeIntervalMs ?? 15_000
    this.host = (opts.collectHost ?? collectHostInfo)()
    this.probeFn = opts.probeProcess ?? probeHerdrProcess
    this.logger = createLogger(ctx, 'dashboard')
    this.rateLimited = createRateLimiter(10_000)
  }

  /** 当前 DTO（未完成任何周期时返回结构完整的空 DTO）。 */
  snapshot(): HerdrDashboardSnapshot {
    return this.lastDto ?? emptyDashboardSnapshot(this.host)
  }

  /** 启动轮询：首次立即 tick（不等第一个 interval）。 */
  start(): void {
    if (this.timer) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    const tick = () => void this.runCycle(signal)
    tick()
    this.timer = setInterval(tick, this.pollIntervalMs)
  }

  /** 停止轮询并中止在途探测（结果不落盘）。幂等。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abort?.abort()
    this.abort = null
  }

  /** 单飞周期：进程探测（节流）与状态读取并行（探测有独立超时，不阻塞拓扑刷新）。 */
  private runCycle(signal: AbortSignal): void {
    if (this.cycle) return
    this.cycle = (async () => {
      try {
        const probePromise = this.probeThrottled(signal)
        const status = this.opts.readStatus()
        const sample = await probePromise
        if (signal.aborted) return // stop() 后结果不落盘
        this.probeError = sample.error
        if (!status.stale) this.lastSuccessAt = Date.now()
        this.lastDto = this.assemble(status, sample)
      } catch (err) {
        if (!signal.aborted) {
          this.probeError = `dashboard cycle failed: ${errText(err)}`
          this.rateLimited('dash-cycle', () => this.logger.warn('dashboard cycle failed: %s', errText(err)))
        }
      } finally {
        this.cycle = null
      }
    })()
  }

  /**
   * P1-3：进程探测节流——距上次探测 < probeIntervalMs（默认 15s）时复用上次样本，
   * 不 spawn ps/pgrep（避免 4s 客户端轮询每次触发子进程）；abort 时不写缓存。
   */
  private async probeThrottled(signal: AbortSignal): Promise<HerdrDashboardProcess> {
    if (this.lastProbeSample !== null && !shouldProbeNow(this.lastProbeAt, Date.now(), this.probeIntervalMs)) {
      return this.lastProbeSample
    }
    const sample = await this.probeFn(signal)
    if (!signal.aborted) {
      this.lastProbeAt = Date.now()
      this.lastProbeSample = sample
    }
    return sample
  }

  /** DTO 装配：聚合纯函数 + 脱敏（socket/checkout_path 只留 basename）+ self 判定。 */
  private assemble(status: HerdrDashboardStatusSource, process: HerdrDashboardProcess): HerdrDashboardSnapshot {
    const workspaces = aggregateDashboardWorkspaces(status.topology, status.agents)
    const summary = buildDashboardSummary(workspaces, status.agents)
    return {
      updated_at: this.lastSuccessAt,
      stale: deriveStale(this.lastSuccessAt, Date.now(), this.staleThresholdMs),
      last_error: status.last_error ?? this.probeError,
      server: {
        status: status.server.status,
        running: status.server.running,
        version: status.server.version,
        protocol: status.server.protocol,
        // 脱敏（决策 4）：socket 绝对路径只暴露 basename
        socket: pathBase(status.server.socket),
        session: status.server.session,
        checked_at: status.server.checked_at,
        installation: status.server.installation,
      },
      connection: {
        connected: status.connected,
        last_success_at: this.lastSuccessAt,
        collectors: {
          server: status.server.status !== 'unknown',
          topology: this.lastSuccessAt > 0,
          agents: this.lastSuccessAt > 0,
          host: true,
          process: process.available,
        },
      },
      host: this.host,
      process,
      summary,
      workspaces,
    }
  }
}
