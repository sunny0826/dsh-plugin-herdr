/**
 * TerminalSession HTTP 路由（design: pane-terminal-session-state-machine §6.3）。
 *
 * - POST /start     创建 observe/control session -> { session_id, generation }
 * - GET  /events    SSE 推流 frame/ready/conflict/closed/error（带 generation+after_seq 续传）
 * - POST /command   controller-only 命令（input/resize；Phase 2 由浏览器触发）
 * - POST /release   释放 session（写 terminal.release / 回收 child）
 *
 * 路由与 manager 解耦：本模块只做参数校验 + guard + SSE 写回，可注入 fake manager 单测。
 */

import type { TerminalSessionManager } from './manager.ts'
import { TerminalSessionError, isTerminalSessionError } from './errors.ts'
import type { BrowserTerminalCommand, TerminalSessionMode, TerminalSessionStartRequest } from './types.ts'

/** 流式响应所需的最小 Node ServerResponse 结构（host 传真实对象，见 probe §TS-0-1）。 */
interface StreamRes {
  writeHead(code: number, headers: Record<string, string>): void
  flushHeaders?(): void
  write(chunk: string): boolean
  once(event: 'drain' | 'close' | 'error', listener: () => void): void
  end(body?: string): void
  destroyed?: boolean
}
interface StreamReq {
  on(event: 'close' | 'aborted', listener: () => void): void
  off?(event: 'close' | 'aborted', listener: () => void): void
}

export interface TerminalSessionRoutesDeps {
  manager: TerminalSessionManager
  /** capability：返回 true 才允许 start；false → 503（触发 snapshot fallback）。 */
  ensureAvailable: () => Promise<boolean>
  /** pane 归属校验；返回 false 拒绝。 */
  checkOwnership: (paneId: string) => Promise<boolean>
  /** 通用 guard（方法 + local），通过返回 true，失败已写拒绝响应。 */
  guard: (res: unknown, req: unknown, method: 'GET' | 'POST') => boolean
  /** 写 JSON 拒绝响应（ok:false）。 */
  reject: (res: unknown, status: number, message: string) => void
  /** 写 JSON 成功响应（任意 status + 结构）。 */
  sendJson: (res: unknown, status: number, obj: unknown) => void
  /** 读取请求体并 JSON.parse（失败抛错由 reject 400）。 */
  readBody?: (req: unknown) => Promise<unknown>
}

type Register = (route: {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}) => () => void

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

function statusFor(err: TerminalSessionError): number {
  switch (err.code) {
    case 'terminal_session_unavailable': return 503
    case 'terminal_session_forbidden': return 403
    case 'terminal_session_conflict': return 409
    case 'terminal_session_not_found': return 404
    case 'terminal_session_process_exited': return 409
    default: return 400
  }
}

/** 参数校验：合法返回 null，否则返回错误消息。 */
function validateStart(body: Record<string, unknown>): { value?: TerminalSessionStartRequest; error?: string } {
  const paneId = body.pane_id
  if (typeof paneId !== 'string' || paneId.trim() === '') return { error: 'pane_id is required' }
  const mode = body.mode
  if (mode !== 'observe' && mode !== 'control') return { error: "mode must be 'observe' or 'control'" }
  const cols = body.cols
  const rows = body.rows
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || cols > 1000) return { error: 'cols must be a positive integer' }
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 1000) return { error: 'rows must be a positive integer' }
  const takeover = body.takeover
  if (takeover !== undefined && typeof takeover !== 'boolean') return { error: 'takeover must be boolean' }
  return {
    value: {
      pane_id: paneId,
      mode: mode as TerminalSessionMode,
      cols,
      rows,
      takeover: typeof takeover === 'boolean' ? takeover : false,
    },
  }
}

function parseCommand(body: Record<string, unknown>): { value?: { sessionId: string; payload: string; release?: boolean }; error?: string } {
  const sessionId = body.session_id
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return { error: 'session_id is required' }
  const cmd = body.command
  if (typeof cmd !== 'object' || cmd === null) return { error: 'command is required' }
  const c = cmd as Partial<BrowserTerminalCommand>
  if (c.type === 'input') {
    if (typeof c.bytes !== 'string') return { error: 'input.bytes is required' }
    return { value: { sessionId, payload: JSON.stringify({ type: 'terminal.input', bytes: c.bytes }) } }
  }
  if (c.type === 'resize') {
    if (typeof c.cols !== 'number' || typeof c.rows !== 'number') return { error: 'resize.cols/rows are required' }
    return { value: { sessionId, payload: JSON.stringify({ type: 'terminal.resize', cols: c.cols, rows: c.rows }) } }
  }
  if (c.type === 'scroll') {
    if (c.direction !== 'up' && c.direction !== 'down') return { error: 'scroll.direction must be up|down' }
    if (typeof c.lines !== 'number' || !Number.isInteger(c.lines) || c.lines < 1) return { error: 'scroll.lines must be a positive integer' }
    return { value: { sessionId, payload: JSON.stringify({ type: 'terminal.scroll', direction: c.direction, lines: c.lines }) } }
  }
  if (c.type === 'release') {
    return { value: { sessionId, payload: '', release: true } }
  }
  return { error: 'unknown command type' }
}

function handleStart(deps: TerminalSessionRoutesDeps) {
  return async (req: unknown, res: unknown): Promise<void> => {
    if (!deps.guard(res, req, 'POST')) return
    let body: Record<string, unknown>
    try {
      const parsed = (await (deps.readBody ?? readJsonBody)(req)) as Record<string, unknown>
      body = parsed
    } catch {
      deps.reject(res, 400, 'invalid JSON body')
      return
    }
    const v = validateStart(body)
    if (v.error) {
      deps.reject(res, 400, v.error)
      return
    }
    const value = v.value!
    if (!(await deps.checkOwnership(value.pane_id))) {
      deps.reject(res, 403, 'pane not accessible from this session')
      return
    }
    if (!(await deps.ensureAvailable())) {
      deps.reject(res, 503, 'terminal session 不可用')
      return
    }
    try {
      const { sessionId, generation } = deps.manager.start(value)
      deps.sendJson(res, 200, { ok: true, session_id: sessionId, generation })
    } catch (err) {
      if (isTerminalSessionError(err)) {
        deps.reject(res, statusFor(err), err.message)
      } else {
        deps.reject(res, 500, String(err instanceof Error ? err.message : err))
      }
    }
  }
}

function handleEvents(deps: TerminalSessionRoutesDeps) {
  return (req: unknown, res: unknown): void => {
    if (!deps.guard(res, req, 'GET')) return
    const url = new URL((req as { url?: string }).url ?? '/', 'http://x')
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId || sessionId.trim() === '') {
      deps.reject(res, 400, 'session_id query parameter is required')
      return
    }
    const gen = Number(url.searchParams.get('generation'))
    const after = Number(url.searchParams.get('after_seq'))
    const sr = res as StreamRes
    const rq = req as StreamReq
    // 写出 200 + 流式 header；此后不得再走 reject 的立即 end 路径
    sr.writeHead(200, SSE_HEADERS)
    sr.flushHeaders?.()
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      rq.off?.('close', close)
      rq.off?.('aborted', close)
      unsubscribe()
      deps.manager.onClientDisconnect(sessionId)
      if (!sr.destroyed) sr.end()
    }
    const unsubscribe = deps.manager.subscribe(
      sessionId,
      { generation: Number.isSafeInteger(gen) && gen >= 0 ? gen : 0, afterSeq: Number.isSafeInteger(after) && after >= 0 ? after : 0 },
      (ev) => {
        if (closed) return
        const ok = sr.write(`data: ${JSON.stringify(ev)}\n\n`)
        if (ok === false) {
          deps.manager.setBlocked(sessionId, true)
          sr.once('drain', () => deps.manager.setBlocked(sessionId, false))
        }
      },
    )
    rq.on('close', close)
    rq.on('aborted', close)
  }
}

function handleCommand(deps: TerminalSessionRoutesDeps) {
  return async (req: unknown, res: unknown): Promise<void> => {
    if (!deps.guard(res, req, 'POST')) return
    let body: Record<string, unknown>
    try {
      body = (await (deps.readBody ?? readJsonBody)(req)) as Record<string, unknown>
    } catch {
      deps.reject(res, 400, 'invalid JSON body')
      return
    }
    const v = parseCommand(body)
    if (v.error) {
      deps.reject(res, 400, v.error)
      return
    }
    const value = v.value!
    try {
      if (value.release) {
        await deps.manager.release(value.sessionId)
      } else {
        deps.manager.writeCommand(value.sessionId, value.payload)
      }
      deps.sendJson(res, 200, { ok: true })
    } catch (err) {
      if (isTerminalSessionError(err)) deps.reject(res, statusFor(err), err.message)
      else deps.reject(res, 500, String(err instanceof Error ? err.message : err))
    }
  }
}

function handleRelease(deps: TerminalSessionRoutesDeps) {
  return async (req: unknown, res: unknown): Promise<void> => {
    if (!deps.guard(res, req, 'POST')) return
    let body: Record<string, unknown>
    try {
      body = (await (deps.readBody ?? readJsonBody)(req)) as Record<string, unknown>
    } catch {
      deps.reject(res, 400, 'invalid JSON body')
      return
    }
    const sessionId = body.session_id
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      deps.reject(res, 400, 'session_id is required')
      return
    }
    await deps.manager.release(sessionId)
    deps.sendJson(res, 200, { ok: true })
  }
}

function handleStats(deps: TerminalSessionRoutesDeps) {
  return (_req: unknown, res: unknown): void => {
    if (!deps.guard(res, _req, 'GET')) return
    deps.sendJson(res, 200, { ok: true, stats: deps.manager.report() })
  }
}

async function readJsonBody(req: unknown): Promise<unknown> {
  const r = req as { on?: (ev: string, cb: (chunk?: Buffer | string) => void) => unknown; body?: unknown }
  if (typeof r.on === 'function') {
    const chunks: Array<Buffer | string> = []
    await new Promise<void>((resolve, reject) => {
      r.on!('data', (c) => { if (c != null) chunks.push(c) })
      r.on!('end', () => resolve())
      r.on!('error', reject)
    })
    const raw = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }
  const b = r.body
  return typeof b === 'string' ? JSON.parse(b) : (b ?? {})
}

export function registerTerminalSessionRoutes(register: Register, deps: TerminalSessionRoutesDeps): () => void {
  const offs = [
    register({ kind: 'exact', path: '/herdr-terminal-session/start', handler: handleStart(deps) }),
    register({ kind: 'exact', path: '/herdr-terminal-session/events', handler: handleEvents(deps) }),
    register({ kind: 'exact', path: '/herdr-terminal-session/stats', handler: handleStats(deps) }),
    register({ kind: 'exact', path: '/herdr-terminal-session/command', handler: handleCommand(deps) }),
    register({ kind: 'exact', path: '/herdr-terminal-session/release', handler: handleRelease(deps) }),
  ]
  return () => { for (const off of offs) off() }
}
