/**
 * 浏览器侧 TerminalSessionStore（design: pane-terminal-session-state-machine §6.4）。
 *
 * 以 pane ID 为 key，独立于 React 生命周期：
 * - 全部会话均为 controller（默认即可操作；观察模式已移除）；
 * - 维护 generation、已确认 cursor（用于断线续传）；
 * - transport 可注入（真实 fetch streaming 或测试 fake）；
 * - 不持有 xterm 实例——只把 frame/status 信号推给订阅方，由组件写入 xterm。
 *
 * cursor 语义（§6.3.2）：cursorSeq 只在组件完成 `xterm.write` callback 后经
 * confirmFrame 推进；断线重连用 (generation, cursorSeq) 询问续传。
 */

import type { BrowserTerminalCommand, BrowserTerminalEvent, TerminalSessionStartRequest } from '../terminal-session/types.ts'
import { subscribeHerdrEvents } from './store.ts'

export interface TerminalSize {
  cols: number
  rows: number
}

export type BrowserSessionStatus = 'starting' | 'controlling' | 'conflict' | 'error' | 'closed'

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
  generation: number
  cursorSeq: number
  refcount: number
  handle?: EventsHandle
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
  /** start 连续 503（capability 不可用 / 上限）后的冷却截止时间戳。 */
  private unavailableUntil = 0
  private static readonly UNAVAILABLE_COOLDOWN_MS = 60_000
  constructor(
    private readonly transport: TerminalSessionTransport,
    opts: TerminalSessionStoreOptions = {},
  ) {
    this.graceMs = opts.graceMs ?? 600
  }

  getPane(paneId: string): PaneSession | undefined {
    return this.panes.get(paneId)
  }

  getRefCount(paneId: string): number {
    return this.panes.get(paneId)?.refcount ?? 0
  }

  subscribe(paneId: string, cb: Listener): () => void {
    if (!this.listeners.has(paneId)) this.listeners.set(paneId, new Set())
    this.listeners.get(paneId)!.add(cb)
    return () => this.listeners.get(paneId)?.delete(cb)
  }

  /**
   * 获取 controller（唯一模式：所有终端默认可操作）。
   * 同一 pane 多组件共享 live 会话（refcount，不重复 start）；
   * takeover=true 走 --takeover（需用户二次确认），总是全新 start。
   */
  async requestControl(paneId: string, size: TerminalSize, takeover = false): Promise<void> {
    const existing = this.panes.get(paneId)
    // 仅复用 live 会话；closed/error（stale，服务端 session 已回收或上次失败）一律全新 start，
    // 避免 agent 任务结束后点击仍残留 "session 不存在" 等过期错误
    if (!takeover && existing && existing.status !== 'closed' && existing.status !== 'error') {
      existing.refcount++
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer)
        existing.graceTimer = undefined
      }
      this.emit(paneId, { type: 'status', status: existing.status, message: existing.message })
      return
    }
    // 冷却期：capability 探测失败或达到上限后 60s 内不再发起 start，
    // 直接报错让组件回退快照模式（避免多卡片 503 重试风暴）
    if (!takeover && Date.now() < this.unavailableUntil) {
      this.emit(paneId, { type: 'status', status: 'error', message: 'terminal session 暂不可用（冷却中）' })
      return
    }
    // stale：重置同一对象（不换引用，保持多组件 refcount 语义）再全新连接
    const ps: PaneSession = existing ?? {
      paneId, status: 'starting', generation: 0, cursorSeq: -1, refcount: 0,
    }
    ps.handle?.close()
    if (ps.graceTimer) { clearTimeout(ps.graceTimer); ps.graceTimer = undefined }
    ps.status = 'starting'
    ps.generation = 0
    ps.cursorSeq = -1
    ps.sessionId = undefined
    ps.refcount = 1
    this.panes.set(paneId, ps)
    this.emit(paneId, { type: 'status', status: 'starting' })
    await this.connect(ps, size, takeover)
  }

  /** 释放引用：归零后进入宽限期（最大化/切换重挂载复用），宽限期后真实关闭并释放服务端会话。 */
  async release(paneId: string): Promise<void> {
    const ps = this.panes.get(paneId)
    if (!ps) return
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

  /** controller 发命令。 */
  sendCommand(paneId: string, cmd: BrowserTerminalCommand): void {
    const ps = this.panes.get(paneId)
    if (!ps?.sessionId || ps.status !== 'controlling') return
    void this.transport.sendCommand(ps.sessionId, cmd).catch(() => {})
  }

  /** controller 输入：bytes → base64 `terminal.input`。 */
  sendInput(paneId: string, bytes: Uint8Array): void {
    this.sendCommand(paneId, { type: 'input', bytes: bytesToBase64(bytes) })
  }

  /** resize：改变真实 PTY cols/rows（§7.3，调用方已去重/节流）。仅 controller。 */
  resize(paneId: string, size: TerminalSize): void {
    const ps = this.panes.get(paneId)
    if (!ps?.sessionId) return
    if (ps.status !== 'controlling') return
    void this.transport.sendCommand(ps.sessionId, { type: 'resize', cols: size.cols, rows: size.rows }).catch(() => {})
  }

  /** controller scroll。 */
  scroll(paneId: string, direction: 'up' | 'down', lines: number): void {
    this.sendCommand(paneId, { type: 'scroll', direction, lines })
  }

  /** 组件拿到的当前已确认 cursor（供重连 / 诊断）。 */
  cursor(paneId: string): { generation: number; afterSeq: number } {
    const ps = this.panes.get(paneId)
    return { generation: ps?.generation ?? 0, afterSeq: ps && ps.cursorSeq >= 0 ? ps.cursorSeq : 0 }
  }

  private async connect(ps: PaneSession, size: TerminalSize, takeover = false): Promise<void> {
    try {
      const { sessionId, generation } = await this.transport.start({ pane_id: ps.paneId, mode: 'control', cols: size.cols, rows: size.rows, takeover })
      ps.sessionId = sessionId
      ps.generation = generation
      ps.cursorSeq = -1
      // 调用方（requestControl）已置 status='starting'。
      // 不要在 start 成功后立即宣告 live——只有收到 ready（基线确认）才 live（见 onEvent 'ready'）。
      const handle = await this.transport.openEvents(sessionId, generation, 0, ev => this.onEvent(ps, ev))
      // 切换（takeover 重建）时关闭旧连接，避免泄漏旧 events 流
      const prev = ps.handle
      if (prev) prev.close()
      ps.handle = handle
      if (this.panes.get(ps.paneId) !== ps) handle.close()
    } catch (err) {
      ps.status = 'error'
      ps.message = err instanceof Error ? err.message : String(err)
      // capability 不可用 / 限额 503：进入冷却期，其余 pane 不再重复打满 start
      if (ps.message.includes('不可用') || ps.message.includes('上限')) {
        this.unavailableUntil = Date.now() + BrowserTerminalSessionStore.UNAVAILABLE_COOLDOWN_MS
      }
      this.emit(ps.paneId, { type: 'status', status: 'error', message: ps.message })
    }
  }

  private onEvent(ps: PaneSession, ev: BrowserTerminalEvent): void {
    const current = this.panes.get(ps.paneId)
    if (current !== ps) return // stale
    // 忽略来自旧流（sessionId 不匹配当前 session）的迟到事件：切换后被取消的旧 handle
    // 其 reader.cancel() 会在 finally 里发 closed，不得污染新 controller 状态 (#2)。
    if (ev.type !== 'frame' && ev.sessionId !== ps.sessionId) return
    switch (ev.type) {
      case 'ready':
        ps.generation = ev.generation
        if (!ev.resumed) ps.cursorSeq = -1 // 新 baseline：清旧 cursor
        // #4：仅当收到 ready（基线确认）才宣告 live；否则 events 失败或始终无 full 时
        // 组件会把 liveSucceeded 置 true、抑制 snapshot fallback。
        if (ps.status === 'starting') {
          ps.status = 'controlling'
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
        // 服务端 session 已回收（agent 任务结束、子进程退出等）：按 closed 处理，
        // 组件回退快照而非显示 "session 不存在"；下次 requestControl 会全新 start
        if (ev.code === 'terminal_session_not_found' || ev.code === 'terminal_session_process_exited') {
          ps.status = 'closed'
          this.emit(ps.paneId, { type: 'status', status: 'closed' })
        } else {
          ps.status = 'error'
          ps.message = ev.message
          this.emit(ps.paneId, { type: 'status', status: 'error', message: ev.message })
        }
        break
      case 'closed':
        // 流结束：标记 closed（组件回退快照）；下次 requestControl 全新 start
        ps.status = 'closed'
        this.emit(ps.paneId, { type: 'status', status: 'closed' })
        break
    }
  }

  private closePane(ps: PaneSession): void {
    ps.status = 'closed'
    if (ps.graceTimer) { clearTimeout(ps.graceTimer); ps.graceTimer = undefined }
    ps.handle?.close()
    this.panes.delete(ps.paneId)
    // 共享单流（/herdr-events）下没有 per-session SSE 断连来触发服务端宽限回收，
    // 会话要显式 release（服务端幂等），否则会话泄漏直至打满上限
    if (ps.sessionId) void this.transport.release(ps.sessionId).catch(() => { /* 幂等 */ })
    this.emit(ps.paneId, { type: 'status', status: 'closed' })
  }

  private emit(paneId: string, sig: TerminalStoreSignal): void {
    this.listeners.get(paneId)?.forEach(cb => { try { cb(sig) } catch { /* 订阅方容错 */ } })
  }
}

/** 真实 transport：fetch POST /start + 共享 /herdr-events 单流收帧。 */
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
  return {
    start: (req) => json('/herdr-terminal-session/start', req).then(b => ({ sessionId: b.session_id as string, generation: b.generation as number })),
    // 复用 /herdr-events 共享单流收帧：浏览器对单域名的并发连接数有限（HTTP/1.1 约 6 条），
    // 逐 session 各开一条 SSE 会在多卡片场景耗尽配额、饿死状态轮询与 bootstrap。
    // generation/after_seq 续传由服务端在单流连接建立时回放（ready + 最新 full 基线）替代。
    openEvents: (sessionId, _generation, _afterSeq, cb) => {
      let closed = false
      const off = subscribeHerdrEvents(ev => {
        if (closed || ev.type !== 'term' || ev.session_id !== sessionId) return
        try { cb(ev.event as BrowserTerminalEvent) } catch { /* 订阅方容错 */ }
      })
      return Promise.resolve({
        close() {
          if (closed) return
          closed = true
          off()
        },
      })
    },
    sendCommand: (sessionId, cmd) => json('/herdr-terminal-session/command', { session_id: sessionId, command: cmd }).then(() => {}),
    release: (sessionId) => json('/herdr-terminal-session/release', { session_id: sessionId }).then(() => {}),
  }
}

/** 全局单例（模块级共享，多卡片共享同一 store）。 */
export const terminalSessionStore = new BrowserTerminalSessionStore(createFetchTransport())

/** bytes → base64（浏览器端；逐字节拼接避免大数组展开爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const bytesElement of bytes) bin += String.fromCharCode(bytesElement)
  return btoa(bin)
}
