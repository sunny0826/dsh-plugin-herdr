import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SocketHerdrClient } from '../../src/client/socket.ts'
import { HerdrCliError } from '../../src/client/cli.ts'

interface Req { id: string; method: string; params: unknown }

/** 每个连接收到一个请求（模拟 Herdr：回复后关闭，订阅除外）。 */
function startFakeServer(
  onRequest: (conn: NetSocket, req: Req, close: () => void) => void,
): Promise<{ path: string; server: Server; dir: string }> {
  return new Promise(resolve => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-sock-test-'))
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
          const req = JSON.parse(line) as Req
          onRequest(conn, req, () => conn.end())
        }
      })
    })
    server.listen(path, () => resolve({ path, server, dir }))
  })
}

const replyAndClose = (conn: NetSocket, req: Req, result: unknown) => {
  conn.write(JSON.stringify({ id: req.id, result }) + '\n')
  conn.end()
}
const replyErrorAndClose = (conn: NetSocket, req: Req, code: string, message: string) => {
  conn.write(JSON.stringify({ id: req.id, error: { code, message } }) + '\n')
  conn.end()
}

const makeClient = (path: string) =>
  new SocketHerdrClient(new Context(), { socketPath: path, timeoutMs: 5000 })

const SNAPSHOT = { type: 'snapshot', snapshot: { version: '0.8.0', protocol: 19, agents: [], panes: [], tabs: [], workspaces: [], layouts: [], focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null } }

test('socket: one-shot request-response (connection closes per request)', async () => {
  let connections = 0
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    connections++
    replyAndClose(conn, req, SNAPSHOT)
  })
  try {
    const client = makeClient(path)
    const a = await client.snapshot()
    const b = await client.snapshot()
    assert.equal(a.version, '0.8.0')
    assert.equal(b.version, '0.8.0')
    assert.equal(connections, 2, 'each request should use a fresh connection')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: concurrent one-shot calls both succeed', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'agent.list') {
      replyAndClose(conn, req, { agents: [{ pane_id: 'w1:p1', status: 'working' }] })
    } else {
      replyAndClose(conn, req, SNAPSHOT)
    }
  })
  try {
    const client = makeClient(path)
    const [agents, snap] = await Promise.all([client.listAgents(), client.snapshot()])
    assert.equal(agents.length, 1)
    assert.equal(agents[0].pane_id, 'w1:p1')
    assert.equal(snap.version, '0.8.0')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: subscription keeps connection open and dispatches events', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
      setTimeout(() => conn.write(JSON.stringify({ type: 'workspace.created', workspace_id: 'w9' }) + '\n'), 20)
      // 保持连接（不 close）
    } else {
      replyAndClose(conn, req, {})
    }
  })
  try {
    const client = makeClient(path)
    const events: Record<string, unknown>[] = []
    client.onEvent(e => events.push(e))
    await client.subscribe([{ type: 'workspace.created' }])
    assert.equal(client.connected, true)
    await new Promise(res => setTimeout(res, 80))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'workspace.created')
    assert.equal(events[0].workspace_id, 'w9')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: error envelope -> HERDR_ERROR with code message', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyErrorAndClose(conn, req, 'internal_error', 'boom')
  })
  try {
    const client = makeClient(path)
    await assert.rejects(() => client.snapshot(), (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_ERROR')
      assert.match(err.message, /internal_error/)
      return true
    })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: waitAgent maps agent_not_found to not_found', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyErrorAndClose(conn, req, 'agent_not_found', 'agent target w9:p1 not found')
  })
  try {
    const client = makeClient(path)
    const res = await client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 2000 }, new AbortController().signal)
    assert.deepEqual(res, { kind: 'not_found', target: 'w9:p1' })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: connection refused -> HERDR_UNAVAILABLE with diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-sock-test-'))
  try {
    const client = new SocketHerdrClient(new Context(), { socketPath: join(dir, 'missing.sock'), timeoutMs: 1000 })
    await assert.rejects(() => client.snapshot(), (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_UNAVAILABLE')
      assert.match(err.message, /socket|server/i)
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: close() tears down the subscription connection', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'events.subscribe') {
      conn.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n')
    } else {
      replyAndClose(conn, req, {})
    }
  })
  try {
    const client = makeClient(path)
    await client.subscribe([{ type: 'workspace.created' }])
    assert.equal(client.connected, true)
    client.close()
    assert.equal(client.connected, false)
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})
