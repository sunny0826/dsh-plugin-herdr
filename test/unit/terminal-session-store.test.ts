// BrowserTerminalSessionStore 逻辑（design §6.4；transport 注入 fake，Node 单测）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserTerminalSessionStore, type EventsHandle, type TerminalSessionTransport, type TerminalStoreSignal } from '../../src/web/terminal-session.ts'
import type { BrowserTerminalCommand, BrowserTerminalEvent, TerminalSessionStartRequest } from '../../src/terminal-session/types.ts'

interface Slot {
  sessionId: string
  generation: number
  afterSeq: number
  cb: (ev: BrowserTerminalEvent) => void
  handle: EventsHandle
}

class FakeTransport implements TerminalSessionTransport {
  starts: TerminalSessionStartRequest[] = []
  slots: Slot[] = []
  releases: string[] = []
  commands: Array<{ sid: string; cmd: BrowserTerminalCommand }> = []
  private seq = 0
  async start(req: TerminalSessionStartRequest) {
    this.starts.push(req)
    // 每个 start 生成唯一 id（模拟真实 session），使 #2 能区分旧流与新流
    return { sessionId: `sid-${req.pane_id}-${++this.seq}`, generation: 1 }
  }
  async openEvents(sessionId: string, generation: number, afterSeq: number, cb: (ev: BrowserTerminalEvent) => void): Promise<EventsHandle> {
    let closed = false
    const handle = { get closed() { return closed }, close() { closed = true } }
    this.slots.push({ sessionId, generation, afterSeq, cb, handle })
    return handle
  }
  async sendCommand(sid: string, cmd: BrowserTerminalCommand): Promise<void> { this.commands.push({ sid, cmd }) }
  async release(sid: string): Promise<void> { this.releases.push(sid) }
}

function collectFrameSignals(sig: TerminalStoreSignal[]): Array<Extract<TerminalStoreSignal, { type: 'frame' }>> {
  return sig.filter((s): s is Extract<TerminalStoreSignal, { type: 'frame' }> => s.type === 'frame')
}

test('store: acquireObserver transitions starting->observing and delivers frames', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts[0]?.mode, 'observe')
  // #4：start 成功后不得立即宣告 live；只有收到 ready（基线确认）才 observing
  assert.ok(!sig.some(s => s.type === 'status' && s.status === 'observing'), 'not live before ready')
  // push ready + full frame then a diff
  const slot = t.slots[0]!
  slot.cb({ type: 'ready', sessionId: slot.sessionId, mode: 'observe', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'observing'), 'live after ready')
  slot.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  slot.cb({ type: 'frame', generation: 1, seq: 2, full: false, width: 80, height: 24, bytes: 'eA==' })
  const frames = collectFrameSignals(sig)
  assert.deepEqual(frames.map(f => f.seq), [1, 2])
  assert.equal(frames[0]?.full, true)
})

test('store: confirmFrame advances cursor used for resume', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'observe', generation: 1, resumed: false, afterSeq: 0 })
  t.slots[0]!.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  t.slots[0]!.cb({ type: 'frame', generation: 1, seq: 2, full: false, width: 80, height: 24, bytes: 'eA==' })
  store.confirmFrame('w1:p1', 2)
  assert.deepEqual(store.cursor('w1:p1'), { generation: 1, afterSeq: 2 })
})

test('store: stale generation frame is dropped', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'observe', generation: 1, resumed: false, afterSeq: 0 })
  t.slots[0]!.cb({ type: 'frame', generation: 99, seq: 5, full: true, width: 80, height: 24, bytes: 'aGk=' }) // stale gen
  assert.equal(collectFrameSignals(sig).length, 0)
})

test('store: ready resumed=false resets cursor baseline', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'observe', generation: 1, resumed: false, afterSeq: 0 })
  t.slots[0]!.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  store.confirmFrame('w1:p1', 1)
  // server rebuilds -> ready resumed=false resets
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'observe', generation: 2, resumed: false, afterSeq: 0 })
  assert.equal(store.cursor('w1:p1').afterSeq, 0)
})

test('store: error event -> status error', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'error', sessionId: t.slots[0]!.sessionId, code: 'terminal_session_protocol_error', message: 'bad', retryable: false })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'error'))
})

test('store: release to refcount 0 (graceMs=0) closes handle and status closed', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 0 })
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  const handle = t.slots[0]!.handle
  await store.release('w1:p1')
  assert.equal((handle as unknown as { closed: boolean }).closed, true)
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'closed'))
})

test('store: release enters grace; re-acquire reuses same session (no new start)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 100 })
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1)
  await store.release('w1:p1')
  // re-acquire before grace expiry -> reuse, no second start, no handle close
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1, 're-acquire must not start a new session')
  const handle = t.slots[0]!.handle
  assert.equal((handle as unknown as { closed: boolean }).closed, false)
  // back to 0 and let grace expire to clean up
  await store.release('w1:p1')
  await new Promise(r => setTimeout(r, 160))
  assert.equal(store.getPane('w1:p1'), undefined)
})

test('store: observer->control switch closes the old observer events handle', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  const obsHandle = t.slots[0]!.handle
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.slots.length, 2, 'control session opened')
  assert.equal((obsHandle as unknown as { closed: boolean }).closed, true, 'old observer handle closed')
})

test('store: release grace expires -> handles closed and pane removed', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 20 })
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  const handle = t.slots[0]!.handle
  await store.release('w1:p1')
  assert.equal((handle as unknown as { closed: boolean }).closed, false, 'held during grace')
  await new Promise(r => setTimeout(r, 60))
  assert.equal((handle as unknown as { closed: boolean }).closed, true, 'closed after grace')
  assert.equal(store.getPane('w1:p1'), undefined)
})

test('store: acquireObserver is refcounted (second acquire no-op)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1, 'no second start for same pane')
  assert.equal(t.slots.length, 1)
})

test('store: requestControl starts control session and reaches controlling', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts[0]?.mode, 'control')
  assert.equal(t.starts[0]?.takeover, false)
  // #4：ready 前不得宣告 controlling
  assert.ok(!sig.some(s => s.type === 'status' && s.status === 'controlling'), 'not controlling before ready')
  // feed a frame → delivered
  const slot = t.slots[0]!
  slot.cb({ type: 'ready', sessionId: slot.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'controlling'), 'controlling after ready')
  slot.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  assert.equal(collectFrameSignals(sig).length, 1)
})

test('store: requestControl with takeover passes takeover flag', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 }, true)
  assert.equal(t.starts[0]?.takeover, true)
})

test('store: sendInput/resize send controller commands', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  const slot = t.slots[0]!
  slot.cb({ type: 'ready', sessionId: slot.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  store.sendInput('w1:p1', new TextEncoder().encode('hi'))
  store.resize('w1:p1', { cols: 100, rows: 30 })
  assert.equal(t.commands[0]?.cmd.type, 'input')
  assert.equal((t.commands[0]!.cmd as { type: 'input'; bytes: string }).bytes, 'aGk=')
  assert.deepEqual(t.commands[1]?.cmd, { type: 'resize', cols: 100, rows: 30 })
})

test('store: sendInput refused when not controlling (observer read-only)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  store.sendInput('w1:p1', new TextEncoder().encode('x'))
  assert.equal(t.commands.length, 0, 'observer must not send input')
})

test('store: conflict event -> status conflict', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'conflict', sessionId: t.slots[0]!.sessionId, message: 'already controlled' })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'conflict'))
})

test('store: releaseControl returns to observer and releases control session', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.releases.length, 0)
  await store.releaseControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.releases.length, 1, 'released control session')
  // back to observing: 需先发 ready 才宣告 observing（#4）
  const obsSlot = t.slots[t.slots.length - 1]!
  obsSlot.cb({ type: 'ready', sessionId: obsSlot.sessionId, mode: 'observe', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'observing'))
  assert.equal(t.starts.filter(x => x.mode === 'observe').length, 1)
})

test('store: stale old-stream closed must not close the new controller (#2)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.acquireObserver('w1:p1', { cols: 80, rows: 24 })
  const obs = t.slots[0]!
  const oldSid = obs.sessionId
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  const ctl = t.slots[1]!
  // 建立 controlling 基线
  ctl.cb({ type: 'ready', sessionId: ctl.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'controlling'))
  // 旧 observer 流的 reader.cancel finally 发出 closed（带旧 sessionId）→ 必须被忽略
  obs.cb({ type: 'closed', sessionId: oldSid, reason: 'detached' })
  const closedNow = sig.some(s => s.type === 'status' && s.status === 'closed')
  assert.equal(closedNow, false, 'old stream closed must not close the new controller')
  assert.equal(store.getPane('w1:p1')?.status, 'controlling')
})
