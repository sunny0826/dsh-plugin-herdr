/**
 * TerminalSessionManager（design: pane-terminal-session-state-machine §6.1）。
 *
 * 职责：
 * - 按 sessionId 管理 CLI 子进程（observe/control 均支持；首版路由只暴露 observe）；
 * - 解析 stdout NDJSON → 校验 frame → generation 隔离 → 广播给浏览器订阅方；
 * - replay buffer 支持断线续传；cursor 不满足时重建 generation，新 generation 首帧必 full；
 * - controller-only 的 input/resize/release（Phase 2 由路由门控）；
 * - 限额（per-pane / 全局 controller / 全局进程数）；
 * - 浏览器断开宽限期回收；插件 dispose 释放全部并终止子进程。
 *
 * 不持有 xterm/React 状态，不把 ChildProcess 泄漏给上层。
 */

import type { ChildProcess } from 'node:child_process'
import { randomFillSync } from 'node:crypto'
import { NDJSONParser, parseFrame, isClosedEvent, type TerminalFrame } from './protocol.ts'
import { resolveHerdrBin, spawnTerminalSession } from './process.ts'
import { TerminalSessionError, protocolError } from './errors.ts'
import type { BrowserTerminalEvent, TerminalSessionMode, TerminalSessionStartRequest } from './types.ts'
import type { TerminalSessionConfig } from '../config.ts'

/** 重建前等待旧 child 退出释放 ownership/resize lock 的有界超时（ms）。 */
const REBUILD_WAIT_MS = 1000

/** 等待 child 退出（已退出立即返回；超时兜底），不悬挂。 */
function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise(resolveDone => {
    if (child.exitCode !== null) { resolveDone(); return }
    let settled = false
    const done = (): void => { if (settled) return; settled = true; clearTimeout(timer); child.off('exit', onExit); resolveDone() }
    const onExit = (): void => done()
    child.once('exit', onExit)
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
  })
}

export interface TerminalSessionManagerDeps {
  config: TerminalSessionConfig
  binPath?: string
  socketPath: string
  session?: string
  env?: NodeJS.ProcessEnv
  spawnChild?: typeof spawnTerminalSession
  now?: () => number
  randomId?: () => string
}

export interface AttachCursor {
  generation: number
  afterSeq: number
}

type Subscriber = (ev: BrowserTerminalEvent) => void

/** 全局帧监听器：/herdr-events 单流复用（web 端所有卡片共享一条 SSE，替代 per-session SSE）。 */
export type GlobalFrameListener = (sessionId: string, paneId: string, ev: BrowserTerminalEvent) => void

/** manager 诊断上报形状（Phase 4 指标/诊断面板数据源）。 */
export interface TerminalSessionReport {
  activeProcesses: number
  observers: number
  controllers: number
  limits: { maxObservers: number; maxControllers: number; maxProcesses: number }
  sessions: Array<{
    sessionId: string
    paneId: string
    mode: TerminalSessionMode
    generation: number
    lastSeq: number
    replayBytes: number
  }>
}

interface Session {
  sessionId: string
  paneId: string
  mode: TerminalSessionMode
  cols: number
  rows: number
  takeover: boolean
  generation: number
  lastSeq: number
  fullArmed: boolean
  state: 'starting' | 'live' | 'closing' | 'closed'
  child?: ChildProcess
  parser: NDJSONParser
  subscribers: Set<Subscriber>
  readyBySub: Map<Subscriber, boolean>
  replay: Array<{ seq: number; event: Extract<BrowserTerminalEvent, { type: 'frame' }> }>
  replayBytes: number
  graceTimer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  conflictReported: boolean
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly deps: TerminalSessionManagerDeps
  private readonly maxDecoded: number
  private readonly maxLine: number
  private readonly replayCap: number
  private readonly controllers = new Set<string>()
  private readonly globalListeners = new Set<GlobalFrameListener>()

  constructor(deps: TerminalSessionManagerDeps) {
    this.deps = deps
    this.maxDecoded = deps.config.maxDecodedFrameBytes
    this.maxLine = deps.config.maxNdjsonLineBytes
    this.replayCap = deps.config.replayBufferBytes
  }

  /** 当前活跃进程数（限额/诊断用）。 */
  get processCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.state !== 'closed') n++
    return n
  }

  /** 当前活跃 observer 数（maxObservers 限额用）。 */
  observerCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.mode === 'observe' && s.state !== 'closed') n++
    return n
  }

  /** 诊断/指标数据源（Phase 4 诊断面板）。 */
  report(): {
    activeProcesses: number
    observers: number
    controllers: number
    limits: { maxObservers: number; maxControllers: number; maxProcesses: number }
    sessions: Array<{
      sessionId: string
      paneId: string
      mode: TerminalSessionMode
      generation: number
      lastSeq: number
      replayBytes: number
    }>
  } {
    const cfg = this.deps.config
    const sessions: TerminalSessionReport['sessions'] = []
    for (const s of this.sessions.values()) {
      if (s.state === 'closed') continue
      sessions.push({ sessionId: s.sessionId, paneId: s.paneId, mode: s.mode, generation: s.generation, lastSeq: s.lastSeq, replayBytes: s.replayBytes })
    }
    return {
      activeProcesses: this.processCount,
      observers: this.observerCount(),
      controllers: this.controllers.size,
      limits: { maxObservers: cfg.maxObservers, maxControllers: cfg.maxControllers, maxProcesses: cfg.maxProcesses },
      sessions,
    }
  }

  /** 创建并启动一个 terminal session，返回 sessionId + generation。 */
  start(req: TerminalSessionStartRequest): { sessionId: string; generation: number } {
    const cfg = this.deps.config
    if (req.mode === 'control') {
      if (this.controllers.size >= cfg.maxControllers) {
        throw new TerminalSessionError('terminal_session_unavailable', '达到全局 controller 上限')
      }
      for (const s of this.sessions.values()) {
        if (s.mode === 'control' && s.paneId === req.pane_id && s.state !== 'closed') {
          throw new TerminalSessionError('terminal_session_forbidden', '该 pane 已有 controller')
        }
      }
      this.controllers.add(req.pane_id)
    } else {
      // observer 限额（maxObservers，per 插件进程护栏）与全局进程数
      if (this.observerCount() >= cfg.maxObservers) {
        throw new TerminalSessionError('terminal_session_unavailable', '达到全局 observer 上限')
      }
      if (this.processCount >= cfg.maxProcesses) {
        throw new TerminalSessionError('terminal_session_unavailable', '达到全局进程数上限')
      }
    }

    const sessionId = (this.deps.randomId ?? this.randomId)()
    const session: Session = {
      sessionId,
      paneId: req.pane_id,
      mode: req.mode,
      cols: req.cols,
      rows: req.rows,
      takeover: req.takeover ?? false,
      generation: 1,
      lastSeq: 0,
      fullArmed: false,
      state: 'starting',
      parser: new NDJSONParser(this.maxLine),
      subscribers: new Set(),
      readyBySub: new Map(),
      replay: [],
      replayBytes: 0,
      conflictReported: false,
    }
    this.sessions.set(sessionId, session)
    this.spawnChild(session)
    return { sessionId, generation: session.generation }
  }

  /** 释放会话：写 release（controller）、正常回收子进程。 */
  release(sessionId: string, reason?: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || s.state === 'closed') return Promise.resolve()
    if (s.state !== 'closing') {
      s.state = 'closing'
      this.emit(s, { type: 'closed', sessionId, reason })
    }
    return this.reap(s, { sendRelease: s.mode === 'control' })
  }

  /** 释放所有会话并终止子进程（插件 dispose）。 */
  dispose(): void {
    for (const s of [...this.sessions.values()]) {
      void this.reap(s, { sendRelease: s.mode === 'control' })
    }
    this.sessions.clear()
    this.controllers.clear()
  }

  /** 注册全局帧监听器（/herdr-events 单流转发），返回退订函数。 */
  addGlobalListener(cb: GlobalFrameListener): () => void {
    this.globalListeners.add(cb)
    return () => { this.globalListeners.delete(cb) }
  }

  /** 全局客户端（/herdr-events 单流）接入：取消所有会话挂起的断开宽限回收。 */
  onGlobalClientConnect(): void {
    for (const s of this.sessions.values()) {
      if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = undefined }
    }
  }

  /** 最后一个全局客户端断开：所有 live 会话进入断开宽限期（web 端不再持有
   *  per-session SSE，浏览器关页不会逐会话通知，必须由单流断开统一兜底回收）。 */
  onGlobalClientDisconnect(): void {
    for (const s of [...this.sessions.values()]) this.onClientDisconnect(s.sessionId)
  }

  /** 当前 live 会话清单（/herdr-events 新连接回放基线用）。 */
  liveSessions(): Array<{ sessionId: string; paneId: string; mode: TerminalSessionMode; generation: number }> {
    const out: Array<{ sessionId: string; paneId: string; mode: TerminalSessionMode; generation: number }> = []
    for (const s of this.sessions.values()) {
      if (s.state === 'live' && s.fullArmed) {
        out.push({ sessionId: s.sessionId, paneId: s.paneId, mode: s.mode, generation: s.generation })
      }
    }
    return out
  }

  /** 最新 full 帧（generation 内基线），供 /herdr-events 新连接补齐重连缺口。 */
  replayLatestFull(sessionId: string): Extract<BrowserTerminalEvent, { type: 'frame' }> | null {
    const s = this.sessions.get(sessionId)
    if (!s || s.state !== 'live' || !s.fullArmed) return null
    for (let i = s.replay.length - 1; i >= 0; i--) {
      if (s.replay[i]!.event.full) return s.replay[i]!.event
    }
    return null
  }

  /** 订阅 session 事件流，返回退订函数。v1 以单订阅方为主。 */
  subscribe(sessionId: string, cursor: AttachCursor, cb: Subscriber): () => void {
    const s = this.sessions.get(sessionId)
    if (!s || s.state === 'closed') {
      queueMicrotask(() => cb({ type: 'error', sessionId, code: 'terminal_session_not_found', message: 'session 不存在', retryable: false }))
      return () => {}
    }
    s.subscribers.add(cb)
    // 客户端已回来：取消挂起的断开宽限期回收（否则重连成功仍会被 grace 定时器删除 session）
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = undefined }
    this.scheduleIdleReset(s)
    this.handleAttach(s, cb, cursor)
    return () => {
      s.subscribers.delete(cb)
      s.readyBySub.delete(cb)
    }
  }

  /** 订阅方写回 backpressure：阻塞则暂停 child stdout，解除后恢复。 */
  setBlocked(sessionId: string, blocked: boolean): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const out = s.child?.stdout
    if (!out || blocked === out.isPaused()) return
    if (blocked) out.pause()
    else out.resume()
  }

  /** 写 stdin 命令；resize 允许 observe/control，input/scroll 仅 control。 */
  writeCommand(sessionId: string, payload: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.state === 'closed') throw new TerminalSessionError('terminal_session_not_found', 'session 不存在')
    const isResize = payload.includes('"terminal.resize"')
    if (s.mode !== 'control' && !isResize) throw new TerminalSessionError('terminal_session_forbidden', 'controller-only 命令')
    const input = s.child?.stdin
    if (!input || !input.writable || s.child!.exitCode !== null) {
      throw new TerminalSessionError('terminal_session_process_exited', 'controller 子进程已退出')
    }
    // Herdr control CLI 用 stdin.lines() 读取——每条命令必须以单个换行终止，
    // 否则下一条命令会与上一条拼成非法 JSON（输入/resize/scroll 不执行）。
    input.write(payload + '\n')
    this.touch(s)
  }

  /** 浏览器连接断开：observer 与 controller 都保留一段宽限期，供浏览器重连在这个窗口内续传。 */
  onClientDisconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.state !== 'live') return
    // observer 也保留宽限期：否则 events 断开即刻删 session，浏览器重连回拿到 not_found。
    const grace = this.deps.config.disconnectGraceMs
    if (grace > 0) {
      s.graceTimer = setTimeout(() => { void this.release(sessionId, 'disconnect grace') }, grace)
      s.graceTimer.unref?.()
    } else {
      void this.release(sessionId, 'client disconnected')
    }
  }

  // -------- 内部 --------

  private randomId(): string {
    // 不透明安全 token：command/release 路由以 sessionId 为主要授权凭据，
    // 必须用密码学随机；测试通过 deps.randomId 注入确定性 id。
    const buf = new Uint8Array(16)
    randomFillSync(buf)
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
  }

  private spawnChild(s: Session): void {
    const bin = this.deps.binPath ?? resolveHerdrBin({ env: this.deps.env })
    if (!bin) {
      this.failClosed(s, new TerminalSessionError('terminal_session_unavailable', '无法定位 herdr 二进制'))
      return
    }
    const child = (this.deps.spawnChild ?? spawnTerminalSession)(
      bin,
      { mode: s.mode, paneId: s.paneId, cols: s.cols, rows: s.rows, takeover: s.takeover },
      this.deps.socketPath,
      this.deps.session,
      this.deps.env,
    )
    s.child = child
    s.state = 'live'
    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(s, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    let stderrTail = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      const c = chunk.toString('utf8')
      stderrTail = (stderrTail + c).slice(-8192)
      this.maybeDetectConflict(s, stderrTail)
    })
    child.on('exit', (code, signal) => {
      // 只有仍是当前 child 才处理（重建后旧 child 退出不归本会话）
      if (s.child !== child) return
      if (s.state === 'live') {
        this.failClosed(s, new TerminalSessionError('terminal_session_process_exited', `子进程退出: ${code ?? signal ?? '?'}`, { retryable: true }))
      } else {
        // closing/closed → 由 release 已 emit closed；这里只清理注册
        this.sessions.delete(s.sessionId)
      }
    })
  }

  /** 重建：generation++ 并重启 child，等待新的 full 基线。 */
  private async rebuild(s: Session, reason: string): Promise<void> {
    if (!this.sessionAlive(s)) return
    s.generation += 1
    s.lastSeq = 0
    s.fullArmed = false
    s.replay = []
    s.replayBytes = 0
    s.parser = new NDJSONParser(this.maxLine) // 重建边界：清掉旧流残余 buffer
    // 既有订阅方仍有效，重新标记待接收新 generation 的 ready
    for (const sub of s.subscribers) s.readyBySub.set(sub, false)
    const old = s.child
    let oldWaited: Promise<void> = Promise.resolve()
    if (old) {
      // 先摘除旧 child 的监听，避免其退出时被当成"当前 child 意外退出"而 failClosed
      old.removeAllListeners('exit')
      old.stdout?.removeAllListeners('data')
      old.stderr?.removeAllListeners('data')
      old.stdout?.pause()
      oldWaited = waitChildExit(old, REBUILD_WAIT_MS)
      old.kill()
    }
    this.emit(s, { type: 'error', sessionId: s.sessionId, code: 'terminal_session_frame_gap', message: reason, retryable: true })
    // controller 重建必须等旧 owner 完全退出（释放 ownership/resize lock），否则新进程会 conflict。
    await oldWaited
    if (!this.sessionAlive(s)) return
    this.spawnChild(s)
  }

  /** 会话是否仍存活（重建/回收 await 期间 s.state 可能被修改，用方法绕过 TS 收窄）。 */
  private sessionAlive(s: Session): boolean {
    return s.state !== 'closed' && s.state !== 'closing'
  }

  private onStdout(s: Session, chunk: Buffer): void {
    if (s.state === 'closed' || s.state === 'closing') return
    const lines = s.parser.push(chunk)
    if (s.parser.exceeded()) {
      this.failClosed(s, new TerminalSessionError('terminal_session_protocol_error', 'stdout 单行超过上限'))
      return
    }
    for (const line of lines) {
      let obj: unknown
      try {
        obj = JSON.parse(line.trim())
      } catch {
        this.failClosed(s, protocolError('非法 JSON 行'))
        return
      }
      if (isClosedEvent(obj)) {
        this.emit(s, { type: 'closed', sessionId: s.sessionId, reason: obj.reason })
        void this.reap(s, { sendRelease: false })
        return
      }
      let frame: TerminalFrame
      try {
        frame = parseFrame(obj, { maxDecodedFrameBytes: this.maxDecoded })
      } catch (err) {
        this.failClosed(s, err instanceof Error ? err : protocolError(String(err)))
        return
      }
      this.onFrame(s, frame)
    }
  }

  private onFrame(s: Session, frame: TerminalFrame): void {
    const firstFull = !s.fullArmed
    if (firstFull) {
      if (!frame.full) {
        this.failClosed(s, protocolError('当前 generation 首帧不是 full'))
        return
      }
      s.fullArmed = true
    }
    if (frame.seq !== s.lastSeq + 1) {
      void this.rebuild(s, `seq 缺口: 期望 ${s.lastSeq + 1}，收到 ${frame.seq}`)
      return
    }
    s.lastSeq = frame.seq
    const ev: Extract<BrowserTerminalEvent, { type: 'frame' }> = {
      type: 'frame',
      generation: s.generation,
      seq: frame.seq,
      full: frame.full,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes.toString('base64'),
    }
    this.enqueueReplay(s, ev)
    if (firstFull) {
      // 等待该 generation ready 的订阅方先收 ready，再收首个 full
      const ready: BrowserTerminalEvent = { type: 'ready', sessionId: s.sessionId, mode: s.mode, generation: s.generation, resumed: false, afterSeq: 0 }
      for (const sub of s.subscribers) {
        if (s.readyBySub.get(sub) === false) {
          this.sendReady(s, sub, false, 0)
          s.readyBySub.set(sub, true)
          sub(ev)
        }
      }
      // 全局单流监听者无 per-session 订阅，ready + 首帧在此单独转发
      this.emitGlobal(s, ready)
      this.emitGlobal(s, ev)
    } else {
      this.emit(s, ev)
    }
  }

  private enqueueReplay(s: Session, frame: Extract<BrowserTerminalEvent, { type: 'frame' }>): void {
    s.replay.push({ seq: frame.seq, event: frame })
    s.replayBytes += frame.bytes.length
    while (s.replay.length > 0 && s.replayBytes > this.replayCap) {
      const dropped = s.replay.shift()
      if (dropped) s.replayBytes -= dropped.event.bytes.length
    }
  }

  private handleAttach(s: Session, cb: Subscriber, cursor: AttachCursor): void {
    if (cursor.generation === s.generation && s.fullArmed) {
      const idx = s.replay.findIndex(r => r.seq > cursor.afterSeq)
      if (idx >= 0) {
        this.sendReady(s, cb, true, cursor.afterSeq)
        for (let i = idx; i < s.replay.length; i++) cb(s.replay[i].event)
        s.readyBySub.set(cb, true)
        return
      }
      // afterSeq 落在 replay 之外（含 afterSeq 紧跟最新帧）→ 无法用 diff 续传，重建
      void this.rebuild(s, 'replay buffer 无法覆盖所需 cursor')
      return
    }
    if (cursor.generation !== s.generation && s.fullArmed) {
      void this.rebuild(s, 'generation 不匹配，重建')
      return
    }
    // 未 full（或 generation 已匹配但还没首个 full）：等该 generation 的 ready
    s.readyBySub.set(cb, false)
  }

  private sendReady(s: Session, sub: Subscriber, resumed: boolean, afterSeq: number): void {
    sub({ type: 'ready', sessionId: s.sessionId, mode: s.mode, generation: s.generation, resumed, afterSeq })
  }

  private emit(s: Session, ev: BrowserTerminalEvent): void {
    for (const sub of s.subscribers) {
      try { sub(ev) } catch { /* 路由层写回失败由其自处理 */ }
    }
    this.emitGlobal(s, ev)
  }

  /** 全局转发（/herdr-events 单流）：不依赖 per-session 订阅方存在。 */
  private emitGlobal(s: Session, ev: BrowserTerminalEvent): void {
    if (this.globalListeners.size === 0) return
    for (const cb of this.globalListeners) {
      try { cb(s.sessionId, s.paneId, ev) } catch { /* 路由层容错 */ }
    }
  }

  private maybeDetectConflict(s: Session, stderrTail: string): void {
    if (s.mode !== 'control' || s.conflictReported) return
    if (/\b(already|currently|occupied|conflict)\b/i.test(stderrTail)) {
      s.conflictReported = true
      this.emit(s, { type: 'conflict', sessionId: s.sessionId, message: stderrTail.trim().slice(0, 200) })
    }
  }

  private scheduleIdleReset(s: Session): void {
    if (s.mode !== 'control') return
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => { void this.release(s.sessionId, 'idle timeout') }, this.deps.config.controllerIdleMs)
    s.idleTimer.unref?.()
  }

  private touch(s: Session): void {
    this.scheduleIdleReset(s)
  }

  private failClosed(s: Session, err: Error): void {
    const code = err instanceof TerminalSessionError ? err.code : 'terminal_session_protocol_error'
    const retryable = err instanceof TerminalSessionError ? err.retryable : false
    this.emit(s, { type: 'error', sessionId: s.sessionId, code, message: err.message, retryable })
    void this.reap(s, { sendRelease: false })
  }

  private reap(s: Session, opts: { sendRelease: boolean }): Promise<void> {
    return new Promise<void>(resolveReap => {
      if (s.state === 'closed') { resolveReap(); return }
      s.state = 'closed'
      if (s.graceTimer) clearTimeout(s.graceTimer)
      if (s.idleTimer) clearTimeout(s.idleTimer)
      if (s.mode === 'control') this.controllers.delete(s.paneId)
      const child = s.child
      if (!child) {
        this.sessions.delete(s.sessionId)
        resolveReap()
        return
      }
      const cleanup = (): void => {
        if (child.exitCode === null) {
          try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        }
        this.sessions.delete(s.sessionId)
        resolveReap()
      }
      if (opts.sendRelease && child.stdin?.writable && child.exitCode === null) {
        try {
          // 先注册 exit 监听再写 release + EOF：真实 CLI 收到 release 且 stdin 关闭后即退出，
          // 退出路径必须能捕获（含同步退出），避免只能依赖下面的 unref'd 兜底定时器
          // （unref 定时器在事件循环耗尽时不保证点火，Node 22 测试运行器会报 pending promise）。
          const timer = setTimeout(cleanup, 1000)
          timer.unref?.()
          child.once('exit', () => { clearTimeout(timer); cleanup() })
          child.stdin.write('{"type":"terminal.release"}\n')
          child.stdin.end()
          return
        } catch { /* 写入失败 → 走普通回收 */ }
      }
      cleanup()
    })
  }
}
