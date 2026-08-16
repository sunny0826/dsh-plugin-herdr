import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * dsh-plugin-herdr 配置（DESIGN.md §6）。
 * 所有非必填项都有默认值；非法枚举/越界在插件加载期报错。
 */
export interface Config {
  /** herdr CLI 可执行文件。默认 'herdr'（走 PATH，优先 HERDR_BIN_PATH）。 */
  cliPath: string
  /** 显式 socket 路径；缺省按 HERDR_SOCKET_PATH → POSIX 默认配置目录解析。 */
  socketPath?: string
  /** 目标会话名；缺省按 HERDR_SESSION → 默认会话。 */
  session?: string
  /** 传输层：cli（默认）| socket（M2 实现）。 */
  transport: 'cli' | 'socket'
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
}

export const Config: Schema<Config> = Schema.object({
  cliPath: Schema.string().default('herdr'),
  socketPath: Schema.string(),
  session: Schema.string(),
  transport: Schema.union(['cli', 'socket']).default('cli'),
  timeoutMs: Schema.number().min(1000).max(600000).default(30000),
  allowBackground: Schema.boolean().default(false),
  events: Schema.object({
    enabled: Schema.boolean().default(false),
    // CA-014：重连退避上限有边界（1s–10min），非法配置加载即失败
    maxReconnectMs: Schema.number().min(1000).max(600000).default(30000),
  }),
  reportState: Schema.boolean().default(true),
  projectRoot: Schema.string(),
})

/** 解析顺序（§6.2 修订）：显式配置 > HERDR_BIN_PATH > PATH 中的 herdr。 */
export function resolveCliPath(config: Pick<Config, 'cliPath'>, env: NodeJS.ProcessEnv = process.env): string {
  if (config.cliPath !== 'herdr') return config.cliPath
  if (env.HERDR_BIN_PATH) return env.HERDR_BIN_PATH
  return 'herdr'
}

/**
 * 解析顺序：显式配置 > HERDR_SOCKET_PATH > POSIX 默认路径。
 * Windows 为 named pipe，不做路径猜测（返回 undefined，走 CLI 传输）。
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
