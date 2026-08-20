import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * dsh-plugin-herdr 配置（DESIGN.md §6）。
 * 所有非必填项都有默认值；非法枚举/越界在插件加载期报错。
 * 全量迁移后传输固定为 socket（CLI 传输与 transport/cliPath 配置已移除）。
 *
 * ——— Pane 终端 Observer/Controller（design: pane-terminal-session-state-machine §6.2）———
 * `terminalSession` 是新增的流式终端会话配置；嵌套对象全部子项都有默认值，
 * 旧配置缺省该块时自动按默认物化。各数值字段在 Schemastery 中设明确上下界。
 */
export interface TerminalSessionConfig {
  /** 是否启用 terminal session（observe/control）能力；禁用时直接用 snapshot fallback。 */
  enabled: boolean
  /** herdr 二进制路径；缺省按 HERDR_BIN_PATH → PATH 中的 herdr 解析。 */
  binPath?: string
  /** 每个浏览器页面最多活跃 observer 数（per-page 作用域）。 */
  maxObservers: number
  /** 全局 controller 护栏（per DSH 会话作用域）；允许不同 pane 并行控制，不写死「每会话 1」。 */
  maxControllers: number
  /** 全局子进程总数硬上限（per 插件进程作用域）。 */
  maxProcesses: number
  /** controller 无交互自动释放的超时（ms）。 */
  controllerIdleMs: number
  /** 浏览器断开后到回收子进程的宽限期（ms）。 */
  disconnectGraceMs: number
  /** 单帧 Base64 解码后最大字节数（默认 8 MiB；硬上限 32 MiB）。 */
  maxDecodedFrameBytes: number
  /** stdout 单行（NDJSON）最大字节数（默认 12 MiB；硬上限 48 MiB）。 */
  maxNdjsonLineBytes: number
  /** 每个 session 的连续帧 replay buffer 上限（字节），用于断线续传窗口。 */
  replayBufferBytes: number
}

export interface Config {
  /** 显式 socket 路径；缺省按 HERDR_SOCKET_PATH → POSIX 默认配置目录解析。 */
  socketPath?: string
  /** 目标会话名；缺省按 HERDR_SESSION → 默认会话。 */
  session?: string
  /** 单次同步请求的默认超时（ms）。 */
  timeoutMs: number
  /** 是否允许工具暴露 run_in_background 参数（后台任务闸门，§4 ADR-4）。 */
  allowBackground: boolean
  /** 事件订阅转发（Herdr → DSH，§10.1）。 */
  events: {
    enabled: boolean
    /** 断线重连最大退避（ms）。 */
    maxReconnectMs: number
  }
  /** 是否启用 DSH → Herdr 状态上报（仅 HERDR_ENV=1 时生效，§4 ADR-6）。 */
  reportState: boolean
  /** 项目根目录（看板过滤用；缺省 process.cwd()，§7.2）。 */
  projectRoot?: string
  /** Pane 终端 Observer/Controller 流式会话配置；缺省由 resolveTerminalSessionConfig 物化默认值。 */
  terminalSession?: TerminalSessionConfig
}

/**
 * terminalSession 的默认配置。经 Phase 0 实测校准（docs/pane-terminal-session-probe.md）：
 * 裸/彩色满屏帧最坏约 19.6 B/cell，8/12 MiB 默认上限有 10+ 倍余量；硬上限防内存攻击。
 * 该常量与下方 Schema 默认值必须保持一致（单点维护在 Schema 默认值，见注释）。
 */
const DEFAULT_TERMINAL_SESSION: TerminalSessionConfig = {
  enabled: true,
  binPath: undefined,
  maxObservers: 8,
  maxControllers: 4,
  maxProcesses: 32,
  controllerIdleMs: 600_000,
  disconnectGraceMs: 5_000,
  maxDecodedFrameBytes: 8_388_608,
  maxNdjsonLineBytes: 12_582_912,
  replayBufferBytes: 8_388_608,
}

/** 合并用户 terminalSession 覆盖与默认值（schema 之外的直连/测试路径也安全）。 */
export function resolveTerminalSessionConfig(config: { terminalSession?: Partial<TerminalSessionConfig> }): TerminalSessionConfig {
  return { ...DEFAULT_TERMINAL_SESSION, ...config.terminalSession }
}

export const Config: Schema<Config> = Schema.object({
  socketPath: Schema.string(),
  session: Schema.string(),
  timeoutMs: Schema.number().min(1000).max(600000).default(30000),
  allowBackground: Schema.boolean().default(false),
  events: Schema.object({
    enabled: Schema.boolean().default(true),
    // CA-014：重连退避上限有边界（1s–10min），非法配置加载即失败
    maxReconnectMs: Schema.number().min(1000).max(600000).default(30000),
  }),
  reportState: Schema.boolean().default(true),
  projectRoot: Schema.string(),
  // Pane 终端 Observer/Controller（design: pane-terminal-session-state-machine §6.2）
  // 默认值经 Phase 0 实测校准（docs/pane-terminal-session-probe.md）：裸/彩色满屏帧
  // 最坏约 19.6 B/cell，8/12 MiB 默认上限有 10+ 倍余量；硬上限 32/48 MiB 防内存攻击。
  terminalSession: Schema.object({
    enabled: Schema.boolean().default(true),
    binPath: Schema.string(),
    maxObservers: Schema.natural().min(0).max(64).default(8),
    maxControllers: Schema.natural().min(0).max(32).default(4),
    maxProcesses: Schema.natural().min(1).max(256).default(32),
    controllerIdleMs: Schema.natural().min(1000).max(3_600_000).default(600_000),
    disconnectGraceMs: Schema.natural().min(1000).max(30_000).default(5_000),
    maxDecodedFrameBytes: Schema.natural().min(1_048_576).max(33_554_432).default(8_388_608),
    maxNdjsonLineBytes: Schema.natural().min(2_097_152).max(50_331_648).default(12_582_912),
    replayBufferBytes: Schema.natural().min(1_048_576).max(100_663_296).default(8_388_608),
  }),
})

/**
 * 解析顺序：显式配置 > HERDR_SOCKET_PATH > POSIX 默认路径。
 * Windows 为 named pipe，不做路径猜测（返回 undefined；插件加载报错，不支持 Windows）。
 * 有会话名时指向 sessions/<name>/herdr.sock。
 */
export function resolveSocketPath(config: Pick<Config, 'socketPath' | 'session'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (config.socketPath) return config.socketPath
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH
  if (process.platform === 'win32') return undefined
  const session = resolveSession(config, env)
  const base = join(homedir(), '.config', 'herdr')
  return session ? join(base, 'sessions', session, 'herdr.sock') : join(base, 'herdr.sock')
}

/** 解析顺序：显式配置 > HERDR_SESSION。 */
export function resolveSession(config: Pick<Config, 'session'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return config.session ?? env.HERDR_SESSION ?? undefined
}
