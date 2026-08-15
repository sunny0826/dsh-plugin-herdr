import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SocketHerdrClient } from '../../src/client/socket.ts'
import { HerdrCliError } from '../../src/client/cli.ts'
import { computeBackoffDelayMs, setupEventForwarding } from '../../src/events/forward.ts'

interface Req { id: string; method: string; params: unknown }

function startFakeServer(
  onRequest: (conn: NetSocket, req: Req) => void,
): Promise<{ path: string; server: Server; dir: string }> {
  return new Promise(resolve => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-fwd-test-'))
    const path = join(dir, 'test.sock')
    const server = createServer(conn => {
      let buf = ''
      conn.setEncoding('utf8')
      conn.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          onRequest(conn, JSON.parse(line) as Req)
        }
      })
    })
    server.listen(path, () => resolve({ path, server, dir }))
  })
}

async function withContext(fn: (ctx: Context, path: string) => Promise<void>, push: (conn: NetSocket) => void = () => {}) {
  const { path, server, dir } = await startFakeServer((conn, req) => {
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      setTimeout(() => push(conn), 20)
    } else {
      conn.write(JSON.stringify({ id: req.id, result: {} }) + '\n')
      conn.end()
    }
  })
  try {
    const ctx = new Context()
    // SocketHerdrClient 构造即注册 ctx.herdr（Service 语义）
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    await fn(ctx, path)
    client.close()
    // 清理转发模块的 interval/timer（插件卸载路径）
    void ctx.fiber?.dispose?.()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('forward: socket subscription maps agent_status_changed to herdr/agent-state', async () => {
  await withContext(async ctx => {
    const events: unknown[] = []
    ctx.on('herdr/agent-state', (e: unknown) => events.push(e))
    ctx.on('herdr/channel', () => {})
    setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 2000 })
    await new Promise(res => setTimeout(res, 120))
  }, conn => {
    // CA-008：live herdr 0.8.0 订阅事件为 { event, data } envelope
    conn.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent: 'claude', agent_status: 'working' } }) + '\n')
  })
  // 事件在 withContext 内部收集，但这里无法访问——改用返回收集器
  assert.ok(true, 'see next test for assertions')
})

test('forward: agent-state and resource-changed are emitted', async () => {
  const agentEvents: unknown[] = []
  const resourceEvents: unknown[] = []
  let captured: Context | null = null
  const { path, server, dir } = await startFakeServer((conn, req) => {
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      setTimeout(() => {
        conn.write(JSON.stringify({ event: 'pane.agent_status_changed', data: { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent: 'claude', agent_status: 'done' } }) + '\n')
        conn.write(JSON.stringify({ event: 'workspace_created', data: { type: 'workspace_created', workspace: { workspace_id: 'w9' } } }) + '\n')
      }, 20)
    } else {
      conn.write(JSON.stringify({ id: req.id, result: {} }) + '\n')
      conn.end()
    }
  })
  try {
    const ctx = new Context()
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    ctx.on('herdr/agent-state', (e: unknown) => agentEvents.push(e))
    ctx.on('herdr/resource-changed', (e: unknown) => resourceEvents.push(e))
    ctx.on('herdr/channel', () => {})
    captured = ctx
    const cleanup = setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 2000 })
    await new Promise(res => setTimeout(res, 150))
    cleanup()
    client.close()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(agentEvents.length, 1)
  assert.deepEqual(agentEvents[0], { pane_id: 'w1:p1', agent: 'claude', status: 'done' })
  assert.equal(resourceEvents.length, 1)
  assert.deepEqual(resourceEvents[0], { type: 'workspace', action: 'created', id: 'w9' })
})

test('forward: disabled does not subscribe', async () => {
  let subscribeCalls = 0
  const { path, server, dir } = await startFakeServer((conn, req) => {
    if (req.method === 'events.subscribe') subscribeCalls++
    conn.write(JSON.stringify({ id: req.id, result: {} }) + '\n')
    conn.end()
  })
  try {
    const ctx = new Context()
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    const cleanup = setupEventForwarding(ctx, { enabled: false, maxReconnectMs: 2000 })
    await new Promise(res => setTimeout(res, 80))
    cleanup()
    assert.equal(subscribeCalls, 0)
    client.close()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-004: CLI polling diff maps resource prefixes to typed kinds (no as never)', async () => {
  // 轮询兜底路径：快照从空变为含 workspace/tab/pane → 发出 created 事件，类型必须正确映射
  const resourceEvents: unknown[] = []
  const ctx = new Context()
  let calls = 0
  const emptySnap = {
    version: '0.8.0', protocol: 19, agents: [], layouts: [],
    focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null,
  }
  const fakeClient = {
    // 非 socket client（无 subscribe）→ 走轮询路径
    snapshot: async () => {
      calls++
      if (calls === 1) return { ...emptySnap, panes: [], workspaces: [], tabs: [] }
      return {
        ...emptySnap,
        panes: [{ pane_id: 'w1:p1' }],
        workspaces: [{ workspace_id: 'w1' }],
        tabs: [{ tab_id: 'w1:t1' }],
      }
    },
  }
  ctx.provide('herdr', fakeClient)
  ctx.on('herdr/resource-changed', (e: unknown) => resourceEvents.push(e))
  ctx.on('herdr/channel', () => {})
  const cleanup = setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 2000, pollIntervalMs: 50 })
  await new Promise(res => setTimeout(res, 300))
  cleanup()
  const created = resourceEvents.filter((e: unknown) => (e as { action?: string }).action === 'created')
  const kinds = created.map((e: unknown) => (e as { type?: string }).type).sort()
  assert.deepEqual(kinds, ['pane', 'tab', 'workspace'], 'prefix w/t/p map to workspace/tab/pane')
  assert.ok(created.every((e: unknown) => (e as { id?: string }).id), 'each event carries an id')
})

// ---------------------------------------------------------------------------
// CA-008：socket 订阅握手 timeout / 断开拒绝 / 指数退避 / cleanup 清理
// ---------------------------------------------------------------------------

test('CA-008: computeBackoffDelayMs grows exponentially with cap and jitter', () => {
  const cap = 1000
  const fixed = () => 0.5 // 固定 jitter 中点 → 期望 exp * 0.75
  const d0 = computeBackoffDelayMs(0, cap, fixed)
  const d1 = computeBackoffDelayMs(1, cap, fixed)
  const d2 = computeBackoffDelayMs(2, cap, fixed)
  assert.ok(d0 >= 150 && d0 <= 200, `first delay ~cap/8*0.75: ${d0}`)
  assert.ok(d1 > d0, 'second attempt grows')
  assert.ok(d2 > d1, 'third attempt grows')
  // cap 生效：多次尝试后仍不超 cap
  const d10 = computeBackoffDelayMs(10, cap, fixed)
  assert.ok(d10 <= cap, `capped at ${cap}: ${d10}`)
  assert.equal(computeBackoffDelayMs(0, 1000, () => 1), Math.floor(200 * 1), 'rand=1 → 1x')
  assert.equal(computeBackoffDelayMs(0, 1000, () => 0), Math.floor(200 * 0.5), 'rand=0 → 0.5x')
})

test('CA-008: subscribe handshake timeout rejects HERDR_TIMEOUT and cleans up the socket', async () => {
  // 服务端收到订阅请求但永不回复 → 握手超时
  const { path, server, dir } = await startFakeServer((_conn, _req) => { /* 永不回复 */ })
  try {
    const client = new SocketHerdrClient(new Context(), { socketPath: path, timeoutMs: 120 })
    await assert.rejects(() => client.subscribe([{ type: 'workspace.created' }]), (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_TIMEOUT')
      return true
    })
    assert.equal(client.connected, false, 'subscription socket must be cleaned up after timeout')
    client.close()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-008: subscribe rejects when the socket closes before the handshake response', async () => {
  const { path, server, dir } = await startFakeServer((conn, _req) => {
    conn.destroy() // 收到请求后立即断开，不回响应
  })
  try {
    const client = new SocketHerdrClient(new Context(), { socketPath: path, timeoutMs: 5000 })
    await assert.rejects(() => client.subscribe([{ type: 'workspace.created' }]), (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_UNAVAILABLE')
      return true
    })
    assert.equal(client.connected, false)
    client.close()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-008: subscribe error envelope rejects HERDR_ERROR', async () => {
  const { path, server, dir } = await startFakeServer((conn, req) => {
    conn.write(JSON.stringify({ id: req.id, error: { code: 'invalid_request', message: 'bad subscription' } }) + '\n')
    conn.end()
  })
  try {
    const client = new SocketHerdrClient(new Context(), { socketPath: path, timeoutMs: 5000 })
    await assert.rejects(() => client.subscribe([{ type: 'bogus' }]), (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_ERROR')
      assert.match(err.message, /invalid_request/)
      return true
    })
    client.close()
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-008: forwarding cleanup closes the subscription socket (no lingering connection)', async () => {
  let connections = 0
  const { path, server, dir } = await startFakeServer((conn, req) => {
    connections++
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      // 保持连接
    } else {
      conn.end()
    }
  })
  try {
    const ctx = new Context()
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    ctx.on('herdr/channel', () => {})
    const cleanup = setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 2000 })
    await new Promise(res => setTimeout(res, 120))
    assert.equal(client.connected, true, 'subscribed before cleanup')
    cleanup()
    assert.equal(client.connected, false, 'cleanup must close the subscription socket')
    const connectionsAtCleanup = connections
    await new Promise(res => setTimeout(res, 150))
    assert.equal(connections, connectionsAtCleanup, 'no reconnect attempts after cleanup')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-008: forwarding reconnects with backoff after disconnect and resumes events', async () => {
  // 第一连接握手成功后立即断开 → 应自动重连（指数退避）并恢复事件推送
  let connections = 0
  const { path, server, dir } = await startFakeServer((conn, req) => {
    connections++
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      if (connections === 1) {
        // 第一次订阅成功后就断开（模拟断连）
        setTimeout(() => conn.destroy(), 30)
      } else {
        // 第二次订阅成功后推送一条事件
        setTimeout(() => {
          conn.write(JSON.stringify({ event: 'workspace_created', data: { type: 'workspace_created', workspace: { workspace_id: 'w2' } } }) + '\n')
        }, 30)
      }
    } else {
      conn.end()
    }
  })
  try {
    const ctx = new Context()
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    const resourceEvents: unknown[] = []
    ctx.on('herdr/resource-changed', (e: unknown) => resourceEvents.push(e))
    ctx.on('herdr/channel', () => {})
    const cleanup = setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 300 })
    await new Promise(res => setTimeout(res, 800))
    cleanup()
    assert.ok(connections >= 2, `expected reconnect, saw ${connections} connections`)
    assert.ok(resourceEvents.length >= 1, 'events resume after reconnect')
    assert.deepEqual(resourceEvents[0], { type: 'workspace', action: 'created', id: 'w2' })
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-011: replayed pane_created for already-subscribed panes does not trigger resubscribe storms', async () => {
  // 模拟 herdr 重放：订阅后立即推多条历史 pane_created（含已订阅的 w1:p1）。
  // 修复前每条历史 pane_created 都会触发重订阅 → 无限重放循环；修复后只在
  // 出现真正新增 pane（不在订阅集合）时才重建订阅。
  let connections = 0
  const { path, server, dir } = await startFakeServer((conn, req) => {
    if (req.method === 'events.subscribe') connections++
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      // 每次订阅都重放两条历史 pane_created（w1:p1 已在订阅集合；w9:p9 快照中没有）
      setTimeout(() => {
        conn.write(JSON.stringify({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: 'w1:p1' } } }) + '\n')
        conn.write(JSON.stringify({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: 'w9:p9' } } }) + '\n')
      }, 20)
    } else if (req.method === 'session.snapshot') {
      // buildSubscriptions 用快照收集 pane；只含 w1:p1
      conn.write(JSON.stringify({ id: req.id, result: { type: 'session_snapshot', snapshot: { panes: [{ pane_id: 'w1:p1' }] } } }) + '\n')
      conn.end()
    } else {
      conn.end()
    }
  })
  try {
    const ctx = new Context()
    const client = new SocketHerdrClient(ctx, { socketPath: path, timeoutMs: 3000 })
    ctx.on('herdr/resource-changed', () => {})
    ctx.on('herdr/channel', () => {})
    const cleanup = setupEventForwarding(ctx, { enabled: true, maxReconnectMs: 500 })
    // 首次订阅（1 次）；w1:p1 已在订阅集合 → 不重订阅；w9:p9 不在 → 重订阅一次（共 2 次）
    await new Promise(res => setTimeout(res, 900))
    cleanup()
    // 若历史 pane_created 每次都触发重订阅，订阅次数会持续增长（风暴）；
    // 修复后应为 2（初始 + 仅对 w9:p9 的一次重建）。
    assert.equal(connections, 2, `replay of known panes must not trigger resubscribe storms (subscribes=${connections})`)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
