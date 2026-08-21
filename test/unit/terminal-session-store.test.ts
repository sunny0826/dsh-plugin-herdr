// BrowserTerminalSessionStore 逻辑（design §6.4；transport 注入 fake，Node 单测）
// 观察模式已移除：全部会话均为 controller（requestControl 是唯一入口）。
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

test('store: requestControl transitions starting->controlling and delivers frames', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts[0]?.mode, 'control')
  assert.equal(t.starts[0]?.takeover, false)
  // #4：start 成功后不得立即宣告 live；只有收到 ready（基线确认）才 controlling
  assert.ok(!sig.some(s => s.type === 'status' && s.status === 'controlling'), 'not live before ready')
  // push ready + full frame then a diff
  const slot = t.slots[0]!
  slot.cb({ type: 'ready', sessionId: slot.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'controlling'), 'live after ready')
  slot.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  slot.cb({ type: 'frame', generation: 1, seq: 2, full: false, width: 80, height: 24, bytes: 'eA==' })
  const frames = collectFrameSignals(sig)
  assert.deepEqual(frames.map(f => f.seq), [1, 2])
  assert.equal(frames[0]?.full, true)
})

test('store: confirmFrame advances cursor used for resume', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
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
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  t.slots[0]!.cb({ type: 'frame', generation: 99, seq: 5, full: true, width: 80, height: 24, bytes: 'aGk=' }) // stale gen
  assert.equal(collectFrameSignals(sig).length, 0)
})

test('store: ready resumed=false resets cursor baseline', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  t.slots[0]!.cb({ type: 'frame', generation: 1, seq: 1, full: true, width: 80, height: 24, bytes: 'aGk=' })
  store.confirmFrame('w1:p1', 1)
  // server rebuilds -> ready resumed=false resets
  t.slots[0]!.cb({ type: 'ready', sessionId: t.slots[0]!.sessionId, mode: 'control', generation: 2, resumed: false, afterSeq: 0 })
  assert.equal(store.cursor('w1:p1').afterSeq, 0)
})

test('store: error event -> status error', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'error', sessionId: t.slots[0]!.sessionId, code: 'terminal_session_protocol_error', message: 'bad', retryable: false })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'error'))
})

test('store: release to refcount 0 (graceMs=0) closes handle and status closed', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 0 })
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  const handle = t.slots[0]!.handle
  await store.release('w1:p1')
  assert.equal((handle as unknown as { closed: boolean }).closed, true)
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'closed'))
})

test('store: release enters grace; re-request reuses same session (no new start)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 100 })
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1)
  await store.release('w1:p1')
  // re-request before grace expiry -> reuse, no second start, no handle close
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1, 're-request must not start a new session')
  const handle = t.slots[0]!.handle
  assert.equal((handle as unknown as { closed: boolean }).closed, false)
  // back to 0 and let grace expire to clean up
  await store.release('w1:p1')
  await new Promise(r => setTimeout(r, 160))
  assert.equal(store.getPane('w1:p1'), undefined)
})

test('store: release grace expires -> handles closed and pane removed', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 20 })
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  const handle = t.slots[0]!.handle
  await store.release('w1:p1')
  assert.equal((handle as unknown as { closed: boolean }).closed, false, 'held during grace')
  await new Promise(r => setTimeout(r, 60))
  assert.equal((handle as unknown as { closed: boolean }).closed, true, 'closed after grace')
  assert.equal(store.getPane('w1:p1'), undefined)
})

test('store: requestControl is refcounted (多组件共享同一会话，不重复 start)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 0 })
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1, 'no second start for same pane')
  assert.equal(t.slots.length, 1)
  // 一个组件卸载不关闭共享会话；归零才关闭并释放服务端 session
  await store.release('w1:p1')
  assert.equal(t.releases.length, 0, 'shared session survives first unmount')
  assert.ok(store.getPane('w1:p1'))
  await store.release('w1:p1')
  assert.equal(t.releases.length, 1, 'server session released at refcount 0')
  assert.equal(store.getPane('w1:p1'), undefined)
})

test('store: requestControl with takeover passes takeover flag and always restarts', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  // takeover 即使已有 live 会话也必须全新 start（踢出对方）
  await store.requestControl('w1:p1', { cols: 80, rows: 24 }, true)
  assert.equal(t.starts.length, 2)
  assert.equal(t.starts[1]?.takeover, true)
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

test('store: sendInput/resize refused before ready（starting 不发命令）', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  store.sendInput('w1:p1', new TextEncoder().encode('x'))
  store.resize('w1:p1', { cols: 100, rows: 30 })
  assert.equal(t.commands.length, 0, 'must not send commands before controlling')
})

test('store: conflict event -> status conflict；重复 requestControl 复用并重发冲突状态', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'conflict', sessionId: t.slots[0]!.sessionId, message: 'already controlled' })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'conflict'))
  // 另一组件挂载：复用 conflict 会话（不重新 start），新订阅者立刻收到 conflict
  const sig2: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig2.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 1, 'conflicted session is reused, not restarted')
  assert.ok(sig2.some(s => s.type === 'status' && s.status === 'conflict'))
})

test('store: stale old-stream closed must not close the new controller (#2)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  const old = t.slots[0]!
  const oldSid = old.sessionId
  // takeover 重建：新 session + 新 events 流
  await store.requestControl('w1:p1', { cols: 80, rows: 24 }, true)
  const ctl = t.slots[1]!
  // 建立 controlling 基线
  ctl.cb({ type: 'ready', sessionId: ctl.sessionId, mode: 'control', generation: 1, resumed: false, afterSeq: 0 })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'controlling'))
  // 旧流的 reader.cancel finally 发出 closed（带旧 sessionId）→ 必须被忽略
  old.cb({ type: 'closed', sessionId: oldSid, reason: 'detached' })
  const closedNow = sig.some(s => s.type === 'status' && s.status === 'closed')
  assert.equal(closedNow, false, 'old stream closed must not close the new controller')
  assert.equal(store.getPane('w1:p1')?.status, 'controlling')
})

test('store: not_found error event -> status closed (fall back to snapshot, not stale error)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'error', sessionId: t.slots[0]!.sessionId, code: 'terminal_session_not_found', message: 'session 不存在', retryable: false })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'closed'), 'not_found must surface as closed')
  assert.ok(!sig.some(s => s.type === 'status' && s.status === 'error'), 'not_found must not surface as error')
})

test('store: process_exited error event -> status closed (agent 任务结束子进程退出)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'error', sessionId: t.slots[0]!.sessionId, code: 'terminal_session_process_exited', message: '子进程退出', retryable: true })
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'closed'))
})

test('store: requestControl after error restarts a fresh session (不复用 stale error)', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t)
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  t.slots[0]!.cb({ type: 'error', sessionId: t.slots[0]!.sessionId, code: 'terminal_session_protocol_error', message: 'bad', retryable: false })
  assert.equal(store.getPane('w1:p1')?.status, 'error')
  // 再次 request → 全新 start（starts 递增），状态回 starting
  const sig: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(t.starts.length, 2, 'must start a fresh session after error')
  assert.equal(store.getPane('w1:p1')?.status, 'starting')
  assert.ok(sig.some(s => s.type === 'status' && s.status === 'starting'))
})

test('store: 会话 refcount 归零回收时显式 release（共享单流无 SSE 断连回收）', async () => {
  const t = new FakeTransport()
  const store = new BrowserTerminalSessionStore(t, { graceMs: 0 })
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  await store.release('w1:p1')
  assert.deepEqual(t.releases, [t.slots[0]!.sessionId], 'session must be released server-side on close')
})

test('store: start 不可用失败进入冷却，其余 pane 冷却期内不再 start', async () => {
  const t = new FakeTransport()
  let startCalls = 0
  t.start = async () => { startCalls++; throw new Error('terminal session 不可用') }
  const store = new BrowserTerminalSessionStore(t, { graceMs: 0 })
  const sig1: TerminalStoreSignal[] = []
  store.subscribe('w1:p1', s => sig1.push(s))
  await store.requestControl('w1:p1', { cols: 80, rows: 24 })
  assert.equal(startCalls, 1)
  assert.ok(sig1.some(s => s.type === 'status' && s.status === 'error'))
  // 冷却期：另一 pane requestControl 直接报错回退快照，不再打 start
  const sig2: TerminalStoreSignal[] = []
  store.subscribe('w1:p2', s => sig2.push(s))
  await store.requestControl('w1:p2', { cols: 80, rows: 24 })
  assert.equal(startCalls, 1, 'cooldown must suppress further start attempts')
  assert.ok(sig2.some(s => s.type === 'status' && s.status === 'error' && s.message?.includes('冷却')))
  assert.ok(!store.getPane('w1:p2')?.sessionId)
})
