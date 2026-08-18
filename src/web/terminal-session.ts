/**
 * 浏览器侧 TerminalSessionStore（design: pane-terminal-session-state-machine §6.4）。
 *
 * 以 pane ID 为 key，独立于 React 生命周期：
 * - 维护 observer/controller 状态、generation、已确认 cursor（用于断线续传）；
 * - transport 可注入（真实 fetch streaming 或测试 fake）；
 * - 不持有 xterm 实例——只把 frame/status 信号推给订阅方，由组件写入 xterm。
 *
 * cursor 语义（§6.3.2）：cursorSeq 只在组件完成 `xterm.write` callback 后经
 * confirmFrame 推进；断线重连用 (generation, cursorSeq) 询问续传。
 */

import type { BrowserTerminalCommand, BrowserTerminalEvent, TerminalSessionMode, TerminalSessionStartRequest } from '../terminal-session/types.ts'

export interface TerminalSize {
  cols: number
  rows: number
}

export type BrowserSessionStatus = 'starting' | 'observing' | 'controlling' | 'conflict' | 'error' | 'closed'

export type TerminalStoreSignal =
  | { type: 'status'; status: BrowserSessionStatus; message?: string }
  | { type: 'frame'; generation: number; seq: number; full: boolean; width: number; height: number; bytes: string }

export interface EventsHandle {
  close(): void
}

export interface TerminalSessionTransport {
  start(req: TerminalSessionStartRequest): Promise<{ sessionId: string; generation: number }>
  openEvents(
    sessionId: string,
    generation: number,
    afterSeq: number,
    cb: (ev: BrowserTerminalEvent) => void,
  ): Promise<EventsHandle>
  sendCommand(sessionId: string, cmd: BrowserTerminalCommand): Promise<void>
  release(sessionId: string): Promise<void>
}

interface PaneSession {
  paneId: string
  status: BrowserSessionStatus
  message?: string
  sessionId?: string
  controlMode: boolean
  generation: number
  cursorSeq: number
  refcount: number
  handle?: EventsHandle
  reconnecting: boolean
  graceTimer?: ReturnType<typeof setTimeout>
}

type Listener = (sig: TerminalStoreSignal) => void

export interface TerminalSessionStoreOptions {
  /** 引用归零后保留 session 的宽限期（ms），供最大化/切换重挂载复用，默认 600。 */
  graceMs?: number
}

export class BrowserTerminalSessionStore {
  private readonly panes = new Map<string, PaneSession>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly graceMs: number
  constructor(
    private readonly transport: TerminalSessionTransport,
    opts: TerminalSessionStoreOptions = {},
  ) {
    this.graceMs = opts.graceMs ?? 600
  }

  getPane(paneId: string): PaneSession | undefined {
    return this.panes.get(paneId)
  }

  subscribe(paneId: string, cb: Listener): () => void {
    if (!this.listeners.has(paneId)) this.listeners.set(paneId, new Set())
    this.listeners.get(paneId)!.add(cb)
    return () => this.listeners.get(paneId)?.delete(cb)
  }

  /** 引用计数 + 幂等：同一 pane 多组件不重复启动 observer；宽限期内复用已有 session。 */
  async acquireObserver(paneId: string, size: TerminalSize): Promise<void> {
    const existing = this.panes.get(paneId)
    if (existing && existing.status !== 'closed') {
      existing.refcount++
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer)
        existing.graceTimer = undefined
      }
      this.emit(paneId, { type: 'status', status: existing.status, message: existing.message })
      return
    }
    const ps: PaneSession = {
      paneId, status: 'starting', controlMode: false, generation: 0, cursorSeq: -1, refcount: 1, reconnecting: false,
    }
    this.panes.set(paneId, ps)
    this.emit(paneId, { type: 'status', status: 'starting' })
    await this.connect(ps, size, 'observe')
  }

  /** controller 激活（Phase 2）。takeover=true 走 --takeover（需用户二次确认）。 */
  async requestControl(paneId: string, size: TerminalSize, takeover = false): Promise<void> {
    const ps = this.panes.get(paneId)
    if (!ps || ps.status === 'closed') {
      const fresh: PaneSession = { paneId, status: 'starting', controlMode: true, generation: 0, cursorSeq: -1, refcount: 1, reconnecting: false }
      this.panes.set(paneId, fresh)
      this.emit(paneId, { type: 'status', status: 'starting' })
      await this.connect(fresh, size, 'control', takeover)
      return
    }
    // 从 observer 升级：复用 same pane state，重启为 control（后端 observe->control 走重建）
    ps.controlMode = true
    ps.status = 'starting'
    ps.cursorSeq = -1
    this.emit(paneId, { type: 'status', status: 'starting' })
    await this.connect(ps, size, 'control', takeover)
  }

  /** 释放控制 / 停止观察（观测量=0 时先进入宽限期，可选复用；宽限期后真实关闭）。 */
  async release(paneId: string): Promise<void> {
    const ps = this.panes.get(paneId)
    if (!ps) return
    if (ps.controlMode) {
      ps.controlMode = false
      if (ps.sessionId) void this.transport.release(ps.sessionId)
    }
    ps.refcount = Math.max(0, ps.refcount - 1)
    if (ps.refcount === 0) {
      if (this.graceMs === 0) {
        this.closePane(ps)
      } else {
        // 宽限期：保留 session 短暂，最大化/切换重挂载时复用同一流（§4.3 / §6.4 保活）
        if (ps.graceTimer) clearTimeout(ps.graceTimer)
        ps.graceTimer = setTimeout(() => {
          if (this.panes.get(paneId) === ps && ps.refcount === 0) this.closePane(ps)
        }, this.graceMs)
      }
    } else {
      if (ps.graceTimer) { clearTimeout(ps.graceTimer); ps.graceTimer = undefined }
      this.emit(paneId, { type: 'status', status: ps.status })
    }
  }

  /** 组件完成某帧的 xterm.write callback 后调用，推进续传 cursor。 */
  confirmFrame(paneId: string, seq: number): void {
    const ps = this.panes.get(paneId)
    if (!ps) return
    if (seq > ps.cursorSeq) ps.cursorSeq = seq
  }

  /** 向 controller 发命令（Phase 2）。 */
  sendCommand(paneId: string, cmd: BrowserTerminalCommand): void {
    const ps = this.panes.get(paneId)
    if (!ps?.sessionId || ps.status !== 'controlling') return
    void this.transport.sendCommand(ps.sessionId, cmd).catch(() => {})
  }

  /** controller 输入：bytes → base64 `terminal.input`。 */
  sendInput(paneId: string, bytes: Uint8Array): void {
    this.sendCommand(paneId, { type: 'input', bytes: bytesToBase64(bytes) })
  }

  /** controller resize：改变真实 PTY cols/rows（§7.3，调用方已去重/节流）。 */
  resize(paneId: string, size: TerminalSize): void {
    this.sendCommand(paneId, { type: 'resize', cols: size.cols, rows: size.rows })
  }

  /** controller scroll（Phase 4）。 */
  scroll(paneId: string, direction: 'up' | 'down', lines: number): void {
    this.sendCommand(paneId, { type: 'scroll', direction, lines })
  }

  /** 用户「释放控制」：释放 controller 并回退到只读 observer。 */
  async releaseControl(paneId: string, size: TerminalSize): Promise<void> {
    const ps = this.panes.get(paneId)
    if (!ps) return
    ps.controlMode = false
    ps.status = 'starting'
    this.emit(paneId, { type: 'status', status: 'starting' })
    if (ps.sessionId) {
      try { await this.transport.release(ps.sessionId) } catch { /* release 幂等 */ }
    }
    await this.connect(ps, size, 'observe')
  }

  /** 组件拿到的当前已确认 cursor（供重连 / 诊断）。 */
  cursor(paneId: string): { generation: number; afterSeq: number } {
    const ps = this.panes.get(paneId)
    return { generation: ps?.generation ?? 0, afterSeq: ps && ps.cursorSeq >= 0 ? ps.cursorSeq : 0 }
  }

  private async connect(ps: PaneSession, size: TerminalSize, mode: TerminalSessionMode, takeover = false): Promise<void> {
    try {
      const { sessionId, generation } = await this.transport.start({ pane_id: ps.paneId, mode, cols: size.cols, rows: size.rows, takeover })
      ps.sessionId = sessionId
      ps.generation = generation
      ps.cursorSeq = -1
      // 调用方（acquireObserver/requestControl/releaseControl）已置 status='starting'。
      // 不要在 start 成功后立即宣告 live——只有收到 ready（基线确认）才 live（见 onEvent 'ready'）。
      const handle = await this.transport.openEvents(sessionId, generation, 0, ev => this.onEvent(ps, ev))
      // 切换（observer→control / 重连）时关闭旧连接，避免泄漏旧 events 流
      const prev = ps.handle
      if (prev) prev.close()
      ps.handle = handle
      if (this.panes.get(ps.paneId) !== ps) handle.close()
    } catch (err) {
      ps.status = 'error'
      ps.message = err instanceof Error ? err.message : String(err)
      this.emit(ps.paneId, { type: 'status', status: 'error', message: ps.message })
    }
  }

  private onEvent(ps: PaneSession, ev: BrowserTerminalEvent): void {
    const current = this.panes.get(ps.paneId)
    if (current !== ps) return // stale
    // 忽略来自旧流（sessionId 不匹配当前 session）的迟到事件：切换后被取消的旧 handle
    // 其 reader.cancel() 会在 finally 里发 closed，不得污染新 controller/observer 状态 (#2)。
    if (ev.type !== 'frame' && ev.sessionId !== ps.sessionId) return
    switch (ev.type) {
      case 'ready':
        ps.generation = ev.generation
        if (!ev.resumed) ps.cursorSeq = -1 // 新 baseline：清旧 cursor
        // #4：仅当收到 ready（基线确认）才宣告 live；否则 events 失败或始终无 full 时
        // 组件会把 observerSucceeded 置 true、抑制 snapshot fallback。
        if (ps.status === 'starting') {
          ps.status = ps.controlMode ? 'controlling' : 'observing'
          this.emit(ps.paneId, { type: 'status', status: ps.status })
        }
        break
      case 'frame':
        if (ev.generation !== ps.generation) break // 迟到旧 generation，丢弃
        this.emit(ps.paneId, { type: 'frame', generation: ev.generation, seq: ev.seq, full: ev.full, width: ev.width, height: ev.height, bytes: ev.bytes })
        break
      case 'conflict':
        ps.status = 'conflict'
        ps.message = ev.message
        this.emit(ps.paneId, { type: 'status', status: 'conflict', message: ev.message })
        break
      case 'error':
        ps.status = 'error'
        ps.message = ev.message
        this.emit(ps.paneId, { type: 'status', status: 'error', message: ev.message })
        break
      case 'closed': {
        // 流结束：observer 断线可尝试重连；错误退出则标记 closed（组件回退快照）
        const after = ps.cursorSeq < 0 ? 0 : ps.cursorSeq
        if (!ps.reconnecting && !ps.controlMode) {
          ps.reconnecting = true
          void this.reconnect(ps, after)
        } else {
          ps.status = 'closed'
          ps.reconnecting = false
          this.emit(ps.paneId, { type: 'status', status: 'closed' })
        }
        break
      }
    }
  }

  private async reconnect(ps: PaneSession, after: number): Promise<void> {
    try {
      if (!ps.sessionId) { ps.status = 'error'; this.emit(ps.paneId, { type: 'status', status: 'error', message: 'session 缺失' }); return }
      const handle = await this.transport.openEvents(ps.sessionId, ps.generation, after, ev => this.onEvent(ps, ev))
      const prev = ps.handle
      if (prev) prev.close()
      ps.handle = handle
      ps.reconnecting = false
    } catch {
      ps.status = 'error'
      ps.reconnecting = false
      this.emit(ps.paneId, { type: 'status', status: 'error', message: '重连失败' })
    }
  }

  private closePane(ps: PaneSession): void {
    ps.status = 'closed'
    if (ps.graceTimer) { clearTimeout(ps.graceTimer); ps.graceTimer = undefined }
    ps.handle?.close()
    this.panes.delete(ps.paneId)
    this.emit(ps.paneId, { type: 'status', status: 'closed' })
  }

  private emit(paneId: string, sig: TerminalStoreSignal): void {
    this.listeners.get(paneId)?.forEach(cb => { try { cb(sig) } catch { /* 订阅方容错 */ } })
  }
}

/** 真实 transport：fetch POST /start + fetch streaming SSE。 */
export function createFetchTransport(base: string = ''): TerminalSessionTransport {
  const json = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const b = (await r.json()) as { ok?: boolean; error?: string; [k: string]: unknown }
    if (!b.ok) throw new Error((b.error as string) ?? `HTTP ${r.status}`)
    return b
  }
  const sse = async (
    sessionId: string, generation: number, afterSeq: number, cb: (ev: BrowserTerminalEvent) => void,
  ): Promise<EventsHandle> => {
    const url = `${base}/herdr-terminal-session/events?session_id=${encodeURIComponent(sessionId)}&generation=${generation}&after_seq=${afterSeq}`
    const resp = await fetch(url)
    if (!resp.ok || !resp.body) {
      cb({ type: 'error', sessionId, code: 'terminal_session_unavailable', message: `events HTTP ${resp.status}`, retryable: true })
      return { close() {} }
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let closed = false
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
            if (!data) continue
            let ev: BrowserTerminalEvent
            try { ev = JSON.parse(data) as BrowserTerminalEvent } catch { continue }
            try { cb(ev) } catch { /* 容错 */ }
          }
        }
      } catch {
        // 读流中断
      } finally {
        cb({ type: 'closed', sessionId, reason: 'stream end' })
      }
    }
    void pump()
    return {
      close() {
        if (closed) return
        closed = true
        void reader.cancel().catch(() => {})
      },
    }
  }
  return {
    start: (req) => json('/herdr-terminal-session/start', req).then(b => ({ sessionId: b.session_id as string, generation: b.generation as number })),
    openEvents: (sessionId, generation, afterSeq, cb) => sse(sessionId, generation, afterSeq, cb),
    sendCommand: (sessionId, cmd) => json('/herdr-terminal-session/command', { session_id: sessionId, command: cmd }).then(() => {}),
    release: (sessionId) => json('/herdr-terminal-session/release', { session_id: sessionId }).then(() => {}),
  }
}

/** 全局单例（模块级共享，多卡片共享同一 store）。 */
export const terminalSessionStore = new BrowserTerminalSessionStore(createFetchTransport())

/** bytes → base64（浏览器端；逐字节拼接避免大数组展开爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
