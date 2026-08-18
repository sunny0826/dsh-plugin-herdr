/**
 * terminal session 能力探测（design: pane-terminal-session-state-machine §8.1）。
 *
 * 只做无副作用探测（`herdr terminal session --help`）并缓存；不得为探测启动真实
 * terminal session。最低版本门槛（0.8.0）不能代替探测——发行版裁剪/回移时以帮助
 * 输出中是否包含 observe/control 为准。
 */

import { resolveHerdrBin } from './process.ts'

export interface TerminalSessionCapability {
  available: boolean
  observe: boolean
  control: boolean
  reason?: 'cli_missing' | 'command_missing' | 'unsupported_platform' | 'probe_failed'
}

export interface ProbeOptions {
  binPath?: string
  env?: NodeJS.ProcessEnv
  /** 探测超时（ms），默认 5000。 */
  timeoutMs?: number
}

function runHelp(bin: string, opts: ProbeOptions, extra: string[]): Promise<string | null> {
  return new Promise(resolveDone => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    let out = ''
    let settled = false
    const child = spawn(bin, extra, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (v: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolveDone(v)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { out += c.slice(0, 4096) })
    child.stderr.resume()
    child.on('error', () => finish(null))
    child.on('exit', (code) => finish(code === 0 ? out : null))
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? 5_000)
  })
}

/**
 * 探测并返回能力。结果应缓存（见 manager 或插件级缓存），生命周期内调用一次。
 */
export async function probeTerminalSession(opts: ProbeOptions = {}): Promise<TerminalSessionCapability> {
  if (process.platform === 'win32') {
    return { available: false, observe: false, control: false, reason: 'unsupported_platform' }
  }
  const bin = resolveHerdrBin(opts)
  if (!bin) {
    return { available: false, observe: false, control: false, reason: 'cli_missing' }
  }
  const help = await runHelp(bin, opts, ['terminal', 'session', '--help'])
  if (help === null) {
    return { available: false, observe: false, control: false, reason: 'probe_failed' }
  }
  const observe = /\bobserve\b/.test(help)
  const control = /\bcontrol\b/.test(help)
  if (!observe && !control) {
    return { available: false, observe, control, reason: 'command_missing' }
  }
  return { available: true, observe, control }
}
