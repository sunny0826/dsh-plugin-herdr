/**
 * TerminalSession CLI 子进程封装（design: pane-terminal-session-state-machine §6.2）。
 *
 * - binPath 解析顺序：config.terminalSession.binPath → 可信 HERDR_BIN_PATH → PATH 的 herdr；
 * - socket 连接走 resolveSocketPath() 最终结果，写入子进程 HERDR_SOCKET_PATH；
 *   HERDR_SESSION 仅作辅助上下文；paneId 作为 argv 传递，禁止拼 shell；
 * - 子进程 env 使用 allowlist，避免无关敏感环境变量泄漏。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveSocketPath, resolveSession, type Config } from '../config.ts'

/** allowlist 环境：仅注入运行/连接所需的最小集合。 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const

export interface TerminalSessionSpawn {
  mode: 'observe' | 'control'
  paneId: string
  cols: number
  rows: number
  takeover?: boolean
}

/** 解析 herdr 二进制（config > HERDR_BIN_PATH > PATH）。 */
export function resolveHerdrBin(opts: { binPath?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  const env = opts.env ?? process.env
  if (opts.binPath) return opts.binPath
  if (env.HERDR_BIN_PATH) return env.HERDR_BIN_PATH
  return 'herdr'
}

/** 从插件 Config 解析出终端会话对应的 socket/session，供 spawn 使用。 */
export function resolveSessionConnection(config: Config): { socketPath?: string; session?: string } {
  const socketPath = resolveSocketPath(config)
  const session = typeof config.session === 'string' ? config.session : resolveSession(config)
  return { socketPath, session }
}

/** 构造最小安全 env（allowlist 合并 + 明确写入 socket/session）。 */
function buildEnv(env: NodeJS.ProcessEnv | undefined, socketPath: string, session?: string): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {}
  const src = env ?? process.env
  for (const key of ENV_ALLOWLIST) {
    const v = src[key]
    if (v !== undefined) allowed[key] = v
  }
  allowed.HERDR_SOCKET_PATH = socketPath
  if (session) allowed.HERDR_SESSION = session
  return allowed
}

/** spawn 一个 `herdr terminal session <mode> <paneId> ...` 子进程。 */
export function spawnTerminalSession(
  binPath: string,
  req: TerminalSessionSpawn,
  socketPath: string,
  session: string | undefined,
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  const args = [
    'terminal', 'session', req.mode, req.paneId,
    '--cols', String(req.cols),
    '--rows', String(req.rows),
  ]
  if (req.mode === 'control' && req.takeover) args.push('--takeover')
  return spawn(binPath, args, {
    env: buildEnv(env, socketPath, session),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}
