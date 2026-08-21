// TerminalSessionManager 逻辑测试（design §11.2 Fake CLI 场景；spawn 注入 fake child）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalSessionManager } from '../../src/terminal-session/manager.ts'
import type { BrowserTerminalEvent, TerminalSessionStartRequest } from '../../src/terminal-session/types.ts'
import type { TerminalSessionConfig } from '../../src/config.ts'

class FakeStream extends EventEmitter {
  private paused = false
  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  isPaused(): boolean { return this.paused }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream()
  stderr = new FakeStream()
  stdin = {
    writable: true,
    written: [] as string[],
    ended: false,
    // 箭头函数使 this 指向 FakeChild 实例（对象字面量方法中的 this 是 stdin 自身）
    write: (s: string): boolean => { this.stdin.written.push(s); return true },
    // 模拟真实 CLI：收到 release 且 stdin 关闭（EOF）后进程退出。
    // 异步触发 exit，让 reap 的 once('exit')（在 end() 之后注册）能捕获，
    // 从而 release 的 promise 经 exit 事件 resolve，而非依赖 unref'd 兜底定时器。
    end: (): void => { this.stdin.ended = true; setImmediate(() => this.exit(0)) },
  }
  exitCode: number | null = null
  // 模拟真实 kill→exit：重建时 waitChildExit 依赖 exit 事件才能推进
  kill(): void { this.exit(0) }
  exit(code: number): void { this.exitCode = code; this.emit('exit', code) }
  emitFrame(f: { seq: number; full?: boolean; width?: number; height?: number; bytes?: string }): void {
    const obj = { type: 'terminal.frame', seq: f.seq, full: f.full ?? false, width: f.width ?? 80, height: f.height ?? 24, bytes: f.bytes ?? Buffer.from('x').toString('base64') }
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  }
  emitStderr(s: string): void { this.stderr.emit('data', Buffer.from(s)) }
}

const cfg = (partial: Partial<TerminalSessionConfig> = {}): TerminalSessionConfig => ({
  enabled: true,
  binPath: '/fake/herdr',
  maxObservers: 8,
  maxControllers: 4,
  maxProcesses: 8,
  controllerIdleMs: 600_000,
  disconnectGraceMs: 5_000,
  maxDecodedFrameBytes: 1_048_576,
  maxNdjsonLineBytes: 1_048_576,
  replayBufferBytes: 1_048_576,
  ...partial,
})

function setup(partial: Partial<TerminalSessionConfig> = {}) {
  let id = 0
  const children: FakeChild[] = []
  const manager = new TerminalSessionManager({
    config: cfg(partial),
    socketPath: '/tmp/x.sock',
    randomId: () => `s${++id}`,
    spawnChild: (() => {
      const c = new FakeChild()
      children.push(c)
      return c as unknown as ReturnType<typeof import('../../src/terminal-session/process.ts').spawnTerminalSession>
    }) as never,
  })
  return { manager, children }
}

function collect(manager: TerminalSessionManager, sessionId: string, cursor: { generation: number; afterSeq: number }) {
  const evs: BrowserTerminalEvent[] = []
  manager.subscribe(sessionId, cursor, ev => evs.push(ev))
  return evs
}

const OBSERVE: TerminalSessionStartRequest = { pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 }

test('manager: first full frame -> subscriber gets ready(resumed=false) then full frame', () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: true, width: 80, height: 24 })
  assert.equal(evs[0].type, 'ready')
  if (evs[0].type === 'ready') {
    assert.equal(evs[0].resumed, false)
    assert.equal(evs[0].afterSeq, 0)
  }
  assert.equal(evs[1].type, 'frame')
  if (evs[1].type === 'frame') assert.equal(evs[1].full, true)
})

test('manager: diffs broadcast in seq order', () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: true })
  children[0].emitFrame({ seq: 2 })
  children[0].emitFrame({ seq: 3 })
  const frames = evs.filter(e => e.type === 'frame')
  assert.deepEqual(frames.map(f => (f as Extract<BrowserTerminalEvent, { type: 'frame' }>).seq), [1, 2, 3])
})

test('manager: first frame NOT full -> protocol error + closed', () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: false })
  const error = evs.find(e => e.type === 'error') as Extract<BrowserTerminalEvent, { type: 'error' }>
  assert.ok(error, 'protocol error emitted')
  assert.equal(error.retryable, false)
})

test('manager: seq gap -> frame_gap error + rebuild on new child', async () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: true })
  children[0].emitFrame({ seq: 3 }) // gap: expects 2
  const err = evs.find(e => e.type === 'error') as Extract<BrowserTerminalEvent, { type: 'error' }>
  assert.equal(err.code, 'terminal_session_frame_gap')
  assert.equal(err.retryable, true)
  // rebuild 是异步（先摘除旧 child 监听、等其 exit 再 spawn 新 child）
  await new Promise(r => setTimeout(r, 0))
  assert.equal(children.length, 2)
  const evs2len = evs.length
  children[1].emitFrame({ seq: 1, full: true })
  const ready = evs.slice(evs2len).find(e => e.type === 'ready') as Extract<BrowserTerminalEvent, { type: 'ready' }>
  assert.ok(ready && ready.resumed === false)
})

test('manager: resume by afterSeq replays diffs (ready resumed=true)', () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: true })
  children[0].emitFrame({ seq: 2 })
  children[0].emitFrame({ seq: 3 })
  // new subscriber with afterSeq=1 while replay holds 2,3
  const evs2: BrowserTerminalEvent[] = []
  manager.subscribe(sessionId, { generation, afterSeq: 1 }, ev => evs2.push(ev))
  assert.equal(evs2[0].type, 'ready')
  if (evs2[0].type === 'ready') {
    assert.equal(evs2[0].resumed, true)
    assert.equal(evs2[0].afterSeq, 1)
  }
  const frames2 = evs2.filter(e => e.type === 'frame')
  assert.deepEqual(frames2.map(f => (f as Extract<BrowserTerminalEvent, { type: 'frame' }>).seq), [2, 3])
})

test('manager: stale generation attach after baseline -> rebuild (ready on new full)', async () => {
  const { manager, children } = setup()
  const { sessionId, generation } = manager.start(OBSERVE)
  // establish baseline first
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].emitFrame({ seq: 1, full: true })
  children[0].emitFrame({ seq: 2 })
  // attach with stale generation 99 (after a baseline exists) -> rebuild
  const evs2: BrowserTerminalEvent[] = []
  manager.subscribe(sessionId, { generation: 99, afterSeq: 0 }, ev => evs2.push(ev))
  // rebuild 是异步
  await new Promise(r => setTimeout(r, 0))
  assert.equal(children.length, 2, 'stale cursor triggers rebuild')
  children[1].emitFrame({ seq: 1, full: true })
  const errs = evs2.filter(e => e.type === 'error')
  const ready = evs2.find(e => e.type === 'ready') as Extract<BrowserTerminalEvent, { type: 'ready' }>
  assert.ok(errs.some(e => (e as Extract<BrowserTerminalEvent, { type: 'error' }>).code === 'terminal_session_frame_gap'))
  assert.ok(ready && ready.resumed === false)
})

test('manager: line overflow -> protocol error', () => {
  const { manager, children } = setup({ maxNdjsonLineBytes: 8 })
  const { sessionId, generation } = manager.start(OBSERVE)
  const evs = collect(manager, sessionId, { generation, afterSeq: 0 })
  children[0].stdout.emit('data', Buffer.concat([Buffer.alloc(64, 0x61), Buffer.from('\n')]))
  const err = evs.find(e => e.type === 'error') as Extract<BrowserTerminalEvent, { type: 'error' }>
  assert.equal(err.code, 'terminal_session_protocol_error')
})

test('manager: release(control) writes terminal.release, cleans session', async () => {
  const { manager, children } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 })
  const child = children[0]
  await manager.release('s1', 'user')
  assert.ok(child.stdin.written.some(w => w.includes('terminal.release')), 'release written to stdin')
  assert.equal(manager.processCount, 0)
  await manager.dispose()
})

test('manager: dispose kills children and clears sessions', async () => {
  const { manager, children } = setup()
  manager.start(OBSERVE)
  manager.start({ pane_id: 'w1:p2', mode: 'control', cols: 90, rows: 30 })
  assert.equal(children.length, 2)
  await manager.dispose()
  assert.equal(manager.processCount, 0)
  assert.equal(children[1].stdin.written.some(w => w.includes('terminal.release')), true, 'control child released')
})

test('manager: per-pane controller limit rejects second controller', () => {
  const { manager } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 })
  assert.throws(() => manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 }), /已有 controller/)
})

test('manager: maxProcesses limit rejects observer', () => {
  const { manager } = setup({ maxProcesses: 1 })
  manager.start(OBSERVE)
  assert.throws(() => manager.start({ pane_id: 'w1:p2', mode: 'observe', cols: 80, rows: 24 }), /进程数上限/)
})

test('manager: maxObservers cap rejects too many concurrent observers', () => {
  const { manager } = setup({ maxObservers: 1 })
  manager.start({ pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 })
  assert.throws(() => manager.start({ pane_id: 'w1:p2', mode: 'observe', cols: 80, rows: 24 }), /observer 上限/)
})

test('manager: report summarizes active sessions/counts/limits', async () => {
  const { manager } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 })
  manager.start({ pane_id: 'w1:p2', mode: 'control', cols: 90, rows: 30 })
  const r = manager.report()
  assert.equal(r.observers, 1)
  assert.equal(r.controllers, 1)
  assert.equal(r.activeProcesses, 2)
  assert.equal(r.sessions.length, 2)
  assert.equal(r.limits.maxObservers, 8)
  assert.ok(r.sessions.some(s => s.mode === 'control' && s.paneId === 'w1:p2'))
  await manager.dispose()
  assert.equal(manager.report().activeProcesses, 0)
})

test('manager: writeCommand refuses on observer (controller-only)', () => {
  const { manager } = setup()
  manager.start(OBSERVE)
  assert.throws(() => manager.writeCommand('s1', '{"type":"terminal.input","bytes":""}'), /controller-only/)
})

test('manager: setBlocked pauses/resumes child stdout', async () => {
  const { manager, children } = setup()
  const { sessionId } = manager.start(OBSERVE)
  manager.setBlocked(sessionId, true)
  assert.equal(children[0].stdout.isPaused(), true)
  manager.setBlocked(sessionId, false)
  assert.equal(children[0].stdout.isPaused(), false)
  await manager.dispose()
})

test('manager: writeCommand appends exactly one trailing newline (#1)', () => {
  const { manager, children } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 })
  manager.writeCommand('s1', '{"type":"terminal.input","bytes":"aGk="}')
  assert.deepEqual(children[0].stdin.written, ['{"type":"terminal.input","bytes":"aGk="}\n'], 'must end with exactly one \\n')
  manager.writeCommand('s1', '{"type":"terminal.resize","cols":100,"rows":30}')
  assert.deepEqual(children[0].stdin.written[1], '{"type":"terminal.resize","cols":100,"rows":30}\n')
  void manager.dispose()
})

test('manager: observer disconnect deferred by grace; re-subscribe cancels it (#3)', async () => {
  const { manager } = setup({ disconnectGraceMs: 50 })
  const { sessionId } = manager.start(OBSERVE)
  manager.onClientDisconnect(sessionId)
  assert.equal(manager.report().activeProcesses, 1, 'session kept during grace')
  // 客户端在宽限期内回来 → subscribe 应取消宽限定时器，不被回收
  manager.subscribe(sessionId, { generation: 1, afterSeq: 0 }, () => {})
  await new Promise(r => setTimeout(r, 90))
  assert.equal(manager.report().activeProcesses, 1, 're-subscribe must cancel disconnect grace')
  await manager.release(sessionId)
  assert.equal(manager.report().activeProcesses, 0)
})

test('manager: observer disconnect past grace reaps session', async () => {
  const { manager } = setup({ disconnectGraceMs: 30 })
  const { sessionId } = manager.start(OBSERVE)
  manager.onClientDisconnect(sessionId)
  await new Promise(r => setTimeout(r, 90))
  assert.equal(manager.report().activeProcesses, 0, 'session reaped after grace when no re-subscribe')
})

test('manager: global listener receives ready + frames without per-session subscribe', async () => {
  const { manager, children } = setup()
  const evs: Array<{ sid: string; pid: string; ev: BrowserTerminalEvent }> = []
  const off = manager.addGlobalListener((sid, pid, ev) => evs.push({ sid, pid, ev }))
  const { sessionId } = manager.start(OBSERVE)
  children[0]!.emitFrame({ seq: 1, full: true, width: 80, height: 24 })
  children[0]!.emitFrame({ seq: 2 })
  assert.equal(evs.length, 3, 'ready + first full + diff')
  assert.equal(evs[0]!.sid, sessionId)
  assert.equal(evs[0]!.pid, 'w1:p1')
  assert.equal(evs[0]!.ev.type, 'ready')
  assert.equal(evs[1]!.ev.type, 'frame')
  if (evs[1]!.ev.type === 'frame') assert.equal(evs[1]!.ev.full, true)
  // closed 也经全局转发（emit 路径）
  void manager.release(sessionId)
  assert.ok(evs.some(e => e.ev.type === 'closed'))
  // 退订后不再收到
  off()
  const n = evs.length
  const s2 = manager.start(OBSERVE)
  children[1]!.emitFrame({ seq: 1, full: true })
  assert.equal(evs.length, n, 'unsubscribed global listener must not fire')
  void manager.release(s2.sessionId)
})

test('manager: replayLatestFull returns latest full baseline; liveSessions lists armed sessions', () => {
  const { manager, children } = setup()
  const { sessionId } = manager.start(OBSERVE)
  assert.equal(manager.replayLatestFull(sessionId), null, 'no full yet')
  assert.deepEqual(manager.liveSessions(), [], 'not armed yet')
  children[0]!.emitFrame({ seq: 1, full: true })
  children[0]!.emitFrame({ seq: 2 })
  const full = manager.replayLatestFull(sessionId)
  assert.ok(full && full.type === 'frame' && full.full === true && full.seq === 1)
  const live = manager.liveSessions()
  assert.equal(live.length, 1)
  assert.equal(live[0]!.sessionId, sessionId)
  assert.equal(live[0]!.paneId, 'w1:p1')
  assert.equal(live[0]!.generation, 1)
})

test('manager: global client disconnect reaps sessions after grace; reconnect cancels', async () => {
  const { manager, children } = setup({ disconnectGraceMs: 30 })
  const { sessionId } = manager.start(OBSERVE)
  children[0]!.emitFrame({ seq: 1, full: true })
  // 全局客户端断开 → 宽限期后回收
  manager.onGlobalClientDisconnect()
  await new Promise(r => setTimeout(r, 80))
  assert.equal(manager.liveSessions().length, 0, 'session must be reaped after disconnect grace')
  // 再来一个会话：断开后宽限期内重连 → 取消回收
  const s2 = manager.start(OBSERVE)
  children[1]!.emitFrame({ seq: 1, full: true })
  manager.onGlobalClientDisconnect()
  manager.onGlobalClientConnect()
  await new Promise(r => setTimeout(r, 80))
  assert.equal(manager.liveSessions().length, 1, 'reconnect within grace must cancel reaping')
  assert.equal(manager.liveSessions()[0]!.sessionId, s2.sessionId)
})
