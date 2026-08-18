// TerminalSession HTTP 路由契约（design: pane-terminal-session-state-machine §6.3）
// 使用真实 manager + 注入 fake child，校验 /start /events /command /release 参数、所有权、capability 与 SSE。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalSessionManager } from '../../src/terminal-session/manager.ts'
import { registerTerminalSessionRoutes, type TerminalSessionRoutesDeps } from '../../src/terminal-session/routes.ts'
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
    // 箭头函数使 this 指向 FakeChild 实例
    write: (s: string) => { this.stdin.written.push(s); return true },
    // 模拟真实 CLI：stdin EOF 后退出，避免 dispose/release 依赖 unref'd 兜底定时器
    end: () => { setImmediate(() => this.exit(0)) },
  }
  exitCode: number | null = null
  kill(): void {}
  exit(code: number): void { this.exitCode = code; this.emit('exit', code) }
  emitFrame(f: { seq: number; full?: boolean; bytes?: string }): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'terminal.frame', seq: f.seq, full: f.full ?? false,
      width: 80, height: 24, bytes: f.bytes ?? Buffer.from('x').toString('base64'),
    }) + '\n'))
  }
}

const cfg: TerminalSessionConfig = {
  enabled: true, binPath: '/fake/herdr', maxObservers: 8, maxControllers: 4, maxProcesses: 8,
  controllerIdleMs: 600_000, disconnectGraceMs: 5_000,
  maxDecodedFrameBytes: 1_048_576, maxNdjsonLineBytes: 1_048_576, replayBufferBytes: 1_048_576,
}

interface Wire {
  handlers: Map<string, (req: unknown, res: unknown) => void | Promise<void>>
  results: string[]
  status: number
  headers: Record<string, string>
  chunks: string[]
}

function setup(opts: { available?: boolean; ownership?: boolean } = {}) {
  const { available = true, ownership = true } = opts
  let id = 0
  const children: FakeChild[] = []
  const manager = new TerminalSessionManager({
    config: cfg, socketPath: '/tmp/x.sock', randomId: () => `s${++id}`,
    spawnChild: (() => { const c = new FakeChild(); children.push(c); return c }) as never,
  })
  const wire: Wire = { handlers: new Map(), results: [], status: 200, headers: {}, chunks: [] }
  const res = {
    writeHead: (c: number, h: Record<string, string>) => { wire.status = c; wire.headers = h },
    flushHeaders: () => {},
    write: (s: string): boolean => { wire.chunks.push(s); return true },
    once: (_ev: string, _cb: () => void) => {},
    end: (_b?: string) => {},
    destroyed: false,
  }
  const deps: TerminalSessionRoutesDeps = {
    manager,
    ensureAvailable: async () => available,
    checkOwnership: async () => ownership,
    guard: () => true,
    reject: (res2, status, message) => { wire.results.push(`R:${status}`); (res2 as typeof res).writeHead(status, { 'content-type': 'application/json' }); (res2 as typeof res).end(JSON.stringify({ ok: false, error: message })) },
    sendJson: (res2, status, obj) => { wire.results.push(`S:${status}`); (res2 as typeof res).writeHead(status, { 'content-type': 'application/json' }); (res2 as typeof res).end(JSON.stringify(obj)) },
  }
  const off = registerTerminalSessionRoutes((r) => { wire.handlers.set(r.path, r.handler); return () => {} }, deps)
  return { manager, children, wire, res, off }
}

const invoke = async (wire: Wire, path: string, res: unknown, req: unknown) => {
  const handler = wire.handlers.get(path)!
  await handler(req, res)
}

test('routes: /start observe success -> 200 (ownership checked)', async () => {
  const { wire, res } = setup({ ownership: true })
  await invoke(wire, '/herdr-terminal-session/start', res, { body: { pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 } })
  assert.ok(wire.results.some(r => r.startsWith('S:200')))
  assert.equal(wire.status, 200)
})

test('routes: /start invalid mode -> 400', async () => {
  const { wire, res } = setup()
  await invoke(wire, '/herdr-terminal-session/start', res, { body: { pane_id: 'w1:p1', mode: 'evil', cols: 80, rows: 24 } })
  assert.ok(wire.results.some(r => r === 'R:400'))
})

test('routes: /start ownership denied -> 403', async () => {
  const { wire, res } = setup({ ownership: false })
  await invoke(wire, '/herdr-terminal-session/start', res, { body: { pane_id: 'wX:p9', mode: 'observe', cols: 80, rows: 24 } })
  assert.ok(wire.results.some(r => r === 'R:403'))
})

test('routes: /start capability unavailable -> 503', async () => {
  const { wire, res } = setup({ available: false })
  await invoke(wire, '/herdr-terminal-session/start', res, { body: { pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 } })
  assert.ok(wire.results.some(r => r === 'R:503'))
})

test('routes: /release -> 200 ok', async () => {
  const { wire, res } = setup()
  await invoke(wire, '/herdr-terminal-session/release', res, { body: { session_id: 's1' } })
  assert.ok(wire.results.some(r => r === 'S:200'))
})

test('routes: /stats -> 200 with report', async () => {
  const { manager, wire, res } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 })
  await invoke(wire, '/herdr-terminal-session/stats', res, {})
  assert.ok(wire.results.some(r => r === 'S:200'))
  await manager.dispose()
})

test('routes: /command controller-only blocked on observer -> 403', async () => {
  const { manager, wire, res } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 } as TerminalSessionStartRequest)
  await invoke(wire, '/herdr-terminal-session/command', res, { body: { session_id: 's1', command: { type: 'input', bytes: 'aGk=' } } })
  assert.ok(wire.results.some(r => r === 'R:403'))
})

test('routes: /command input on controller -> 200 and writes to stdin', async () => {
  const { manager, children, wire, res } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 } as TerminalSessionStartRequest)
  await invoke(wire, '/herdr-terminal-session/command', res, { body: { session_id: 's1', command: { type: 'input', bytes: 'aGk=' } } })
  assert.ok(wire.results.some(r => r === 'S:200'))
  assert.ok(children[0].stdin.written.some(w => w.includes('terminal.input')))
})

test('routes: /command scroll valid on controller -> writes terminal.scroll payload', async () => {
  const { manager, children, wire, res } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 } as TerminalSessionStartRequest)
  await invoke(wire, '/herdr-terminal-session/command', res, { body: { session_id: 's1', command: { type: 'scroll', direction: 'up', lines: 5 } } })
  assert.ok(wire.results.some(r => r === 'S:200'))
  assert.ok(children[0].stdin.written.some(w => w.includes('terminal.scroll') && w.includes('"direction":"up"') && w.includes('"lines":5')))
})

test('routes: /command scroll invalid direction -> 400', async () => {
  const { manager, wire, res } = setup()
  manager.start({ pane_id: 'w1:p1', mode: 'control', cols: 80, rows: 24 } as TerminalSessionStartRequest)
  await invoke(wire, '/herdr-terminal-session/command', res, { body: { session_id: 's1', command: { type: 'scroll', direction: 'sideways', lines: 5 } } })
  assert.ok(wire.results.some(r => r === 'R:400'))
})

test('routes: /events missing session_id -> 400 (before SSE start)', async () => {
  const { wire, res } = setup()
  await invoke(wire, '/herdr-terminal-session/events', res, { url: '/herdr-terminal-session/events' })
  assert.ok(wire.results.some(r => r === 'R:400'))
})

test('routes: /events streams SSE frame after subscribe', async () => {
  const { manager, children, wire, res } = setup()
  const { sessionId, generation } = manager.start({ pane_id: 'w1:p1', mode: 'observe', cols: 80, rows: 24 } as TerminalSessionStartRequest)
  const qs = `?session_id=${sessionId}&generation=${generation}&after_seq=0`
  await invoke(wire, '/herdr-terminal-session/events', res, { url: `/herdr-terminal-session/events${qs}`, on: () => {} })
  assert.equal(wire.headers['content-type'], 'text/event-stream; charset=utf-8')
  children[0].emitFrame({ seq: 1, full: true })
  const dataLines = wire.chunks.filter(c => c.startsWith('data:'))
  assert.equal(dataLines.length >= 1, true)
  const first = JSON.parse(dataLines[0].slice(6))
  assert.equal(first.type, 'ready')
  assert.equal((first as { resumed?: boolean }).resumed, false)
})
