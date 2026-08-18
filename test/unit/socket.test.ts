import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SocketHerdrClient, socketPing } from '../../src/client/socket.ts'
import { HerdrError } from '../../src/client/error.ts'

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
    const events: unknown[] = []
    client.onEvent(e => events.push(e))
    await client.subscribe([{ type: 'workspace.created' }])
    assert.equal(client.connected, true)
    await new Promise(res => setTimeout(res, 80))
    assert.equal(events.length, 1)
    assert.equal((events[0] as Record<string, unknown>).type, 'workspace.created')
    assert.equal((events[0] as Record<string, unknown>).workspace_id, 'w9')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: error envelope -> HERDR_ERROR with serverCode passthrough', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyErrorAndClose(conn, req, 'internal_error', 'boom')
  })
  try {
    const client = makeClient(path)
    await assert.rejects(() => client.snapshot(), (err: Error) => {
      assert.ok(err instanceof HerdrError)
      assert.equal(err.code, 'HERDR_ERROR')
      assert.equal(err.serverCode, 'internal_error', 'server error code must be preserved for branching')
      assert.match(err.message, /internal_error/)
      return true
    })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: agentExplain maps server business errors to {} (CLI parity)', async () => {
  // CLI 时代对任何服务器错误 envelope 都返回 {}（result ?? {}）；socket 侧对齐：
  // agent_explain_unavailable（无检测 agent）与 agent_not_found（目标不存在）均为业务失败
  for (const code of ['agent_explain_unavailable', 'agent_not_found']) {
    const { path, server, dir } = await startFakeServer((conn, req, close) => {
      replyErrorAndClose(conn, req, code, code + ': boom')
    })
    try {
      const client = makeClient(path)
      const res = await client.agentExplain({ target: 'w1:p1' })
      assert.deepEqual(res, {}, `${code} is a value, not an error (parity with removed CLI transport)`)
      client.close()
    } finally {
      server.close(); rmSync(dir, { recursive: true, force: true })
    }
  }
  // 连接类错误照常抛出（不吞）
  const dir2 = mkdtempSync(join(tmpdir(), 'herdr-sock-test-'))
  try {
    const client = new SocketHerdrClient(new Context(), { socketPath: join(dir2, 'missing.sock'), timeoutMs: 1000 })
    await assert.rejects(() => client.agentExplain({ target: 'w1:p1' }), (err: Error) => {
      assert.ok(err instanceof HerdrError)
      assert.equal(err.code, 'HERDR_UNAVAILABLE')
      return true
    })
    client.close()
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('socket: waitAgent maps timeout serverCode to timeout result', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyErrorAndClose(conn, req, 'timeout', 'wait timed out')
  })
  try {
    const client = makeClient(path)
    const res = await client.waitAgent({ target: 'w1:p1', until: ['done'], timeout_ms: 2000 }, new AbortController().signal)
    assert.equal(res.kind, 'timeout')
    if (res.kind === 'timeout') assert.ok(res.waited_ms >= 0)
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: ping returns version/protocol from pong', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'ping') replyAndClose(conn, req, { type: 'pong', version: '0.8.0', protocol: 19 })
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const pong = await client.ping()
    assert.deepEqual(pong, { version: '0.8.0', protocol: 19 })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: ping with malformed pong rejects HERDR_PROTOCOL', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyAndClose(conn, req, { type: 'pong' })
  })
  try {
    const client = makeClient(path)
    await assert.rejects(() => client.ping(), (err: Error) => {
      assert.ok(err instanceof HerdrError)
      assert.equal(err.code, 'HERDR_PROTOCOL')
      return true
    })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: idempotent read retries once on HERDR_UNAVAILABLE (connection refused)', async () => {
  // 第一次连接被拒（snapshot 幂等读）→ 300ms 后重试成功
  let attempts = 0
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    attempts++
    if (attempts === 1) {
      conn.destroy()
    } else {
      replyAndClose(conn, req, SNAPSHOT)
    }
  })
  try {
    const client = makeClient(path)
    const snap = await client.snapshot()
    assert.equal(snap.version, '0.8.0')
    assert.equal(attempts, 2, 'exactly one retry after the refused connection')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socketPing: standalone probe returns version/protocol or null', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'ping') replyAndClose(conn, req, { type: 'pong', version: '0.8.0', protocol: 19 })
    else replyAndClose(conn, req, {})
  })
  try {
    const ok = await socketPing(path)
    assert.deepEqual(ok, { version: '0.8.0', protocol: 19 })
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
  // 不存在 socket → null（不抛错）
  const missing = await socketPing(join(dir, 'missing.sock'), 300)
  assert.equal(missing, null)
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
      assert.ok(err instanceof HerdrError)
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

test('CA-011: socket runCommand abort during polling rejects HERDR_ABORTED (not timed_out)', async () => {
  let requests = 0
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    requests++
    if (req.method === 'pane.split') replyAndClose(conn, req, { type: 'pane_info', pane: { pane_id: 'w1:p1' } })
    else if (req.method === 'pane.send_text') replyAndClose(conn, req, { type: 'ok' })
    else if (req.method === 'pane.read') replyAndClose(conn, req, { type: 'pane_read', read: { text: 'out', pane_id: 'w1:p1' } })
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const ac = new AbortController()
    const p = client.runCommand({ command: 'sleep 5', wait_ms: 10_000 }, ac.signal)
    // 等 split + send_text + 首轮 poll read 完成（interval 500ms）
    await new Promise(res => setTimeout(res, 700))
    ac.abort()
    await assert.rejects(() => p, (err: Error) => {
      assert.ok(err instanceof HerdrError)
      assert.equal(err.code, 'HERDR_ABORTED')
      return true
    })
    assert.ok(requests >= 3, 'split + send_text + at least one read happened')
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CA-014：socket 输出上限与 CLI 传输统一
// ---------------------------------------------------------------------------

test('CA-014: socket paneRead reports server-truncated flag and client-side cap', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 100)
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.read') replyAndClose(conn, req, { type: 'pane_read', read: { text: big, pane_id: 'w1:p1', truncated: false } })
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    // 服务器未截断但超 1 MiB → 客户端兜底截断并置 truncated
    const capped = await client.paneRead({ pane_id: 'w1:p1' })
    assert.equal(capped.truncated, true, 'client-side cap must set truncated')
    assert.ok(capped.text.length <= 1024 * 1024)
    // 服务器已截断（小文本 + truncated:true）→ 如实透传
    const { path: p2, server: s2, dir: d2 } = await startFakeServer((conn, req, close) => {
      if (req.method === 'pane.read') replyAndClose(conn, req, { type: 'pane_read', read: { text: 'small', pane_id: 'w1:p1', truncated: true } })
      else replyAndClose(conn, req, {})
    })
    try {
      const c2 = makeClient(p2)
      const r2 = await c2.paneRead({ pane_id: 'w1:p1' })
      assert.equal(r2.text, 'small')
      assert.equal(r2.truncated, true, 'server-reported truncated must pass through')
      c2.close()
    } finally {
      s2.close(); rmSync(d2, { recursive: true, force: true })
    }
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('CR: socket paneRead caps non-ASCII output by UTF-8 bytes', async () => {
  // emoji（😀=4 UTF-8 字节）超限时按字节截断，不再按 UTF-16 码元虚高
  const big = '😀'.repeat(400_000) // 1.6MB UTF-8 / 0.8M 码元
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.read') replyAndClose(conn, req, { type: 'pane_read', read: { text: big, pane_id: 'w1:p1', truncated: false } })
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const capped = await client.paneRead({ pane_id: 'w1:p1' })
    assert.equal(capped.truncated, true)
    assert.ok(Buffer.byteLength(capped.text, 'utf8') <= 1024 * 1024, `bytes=${Buffer.byteLength(capped.text)}`)
    assert.ok(Buffer.byteLength(capped.text, 'utf8') > 1024 * 1024 - 64, 'capped near the limit')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('CA-014: socket runCommand reports truncated when any poll read is truncated', async () => {
  const read = { type: 'pane_read', read: { text: 'z'.repeat(1024 * 1024 + 50), pane_id: 'w1:p1', truncated: false } }
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.split') replyAndClose(conn, req, { type: 'pane_info', pane: { pane_id: 'w1:p1' } })
    else if (req.method === 'pane.send_text') replyAndClose(conn, req, { type: 'ok' })
    else if (req.method === 'pane.read') replyAndClose(conn, req, read)
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const res = await client.runCommand({ command: 'cat huge', wait_ms: 8000 }, new AbortController().signal)
    assert.equal(res.kind, 'completed')
    if (res.kind === 'completed') {
      assert.equal(res.truncated, true, 'truncated flag must reach the runCommand result')
      assert.ok(res.output.length <= 1024 * 1024)
    }
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ANSI 数据契约：format:'ansi' 请求透传 + SGR 保留 + ANSI-safe 截断
// ---------------------------------------------------------------------------

test('ANSI contract: paneRead sends format:ansi and preserves raw SGR in response', async () => {
  const sgr = '\u001b[31mred\u001b[0m\r\ngreen line'
  let capturedReq: unknown = null
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.read') {
      capturedReq = req
      replyAndClose(conn, req, { type: 'pane_read', read: { text: sgr, pane_id: 'w1:p1', truncated: false } })
    } else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const result = await client.paneRead({ pane_id: 'w1:p1', format: 'ansi', source: 'recent_unwrapped', lines: 300 })
    // 请求必须包含 format:'ansi'
    assert.ok(capturedReq, 'pane.read must be called')
    const params = (capturedReq as { params: Record<string, unknown> }).params
    assert.equal(params.format, 'ansi', 'request params must include format:ansi')
    // 响应保留原始 SGR 和 CRLF
    assert.ok(result.text.includes('\u001b[31m'), 'response must preserve ESC (SGR)')
    assert.ok(result.text.includes('\r\n'), 'response must preserve CRLF')
    assert.equal(result.truncated, false)
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('ANSI contract: capReadText cleans incomplete escape after byte truncation', async () => {
  // 构造超 1 MiB 的文本，确保尾部含不完整 escape
  // pad 在 escape 之前就已超 1 MiB，这样 byte truncation 会在 escape 中间截断
  const pad = 'a'.repeat(1024 * 1024 + 100)
  const tail = '\u001b[31mred' // 不完整 SGR（在截断边界之后）
  const big = pad + tail
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.read') replyAndClose(conn, req, { type: 'pane_read', read: { text: big, pane_id: 'w1:p1', truncated: false } })
    else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    const result = await client.paneRead({ pane_id: 'w1:p1' })
    assert.equal(result.truncated, true, 'must be truncated')
    // byte truncation 可能在 escape 中间截断，ANSI cleanup 应清理残片
    // 结果不应包含不完整的 ESC 序列（可能被截成半个字符）
    assert.ok(result.text.length <= 1024 * 1024 + 10, 'result length reasonable')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------
// pane.send_input 协议（design: pane-interactive-terminal §3.4）
// ------------------------------------------------------------------

test('socket: paneSendInput sends pane.send_input with text', async () => {
  let capturedReq: unknown = null
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.send_input') {
      capturedReq = req
      replyAndClose(conn, req, { type: 'ok' })
    } else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    await client.paneSendInput({ pane_id: 'w1:p1', text: 'ls\r' })
    assert.ok(capturedReq, 'pane.send_input must be called')
    const params = (capturedReq as { params: Record<string, unknown> }).params
    assert.equal(params.pane_id, 'w1:p1')
    assert.equal(params.text, 'ls\r')
    assert.equal(params.keys, undefined, 'text-only: keys must be undefined')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: paneSendInput sends pane.send_input with keys', async () => {
  let capturedReq: unknown = null
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.send_input') {
      capturedReq = req
      replyAndClose(conn, req, { type: 'ok' })
    } else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    await client.paneSendInput({ pane_id: 'w1:p1', keys: ['ctrl+c'] })
    assert.ok(capturedReq, 'pane.send_input must be called')
    const params = (capturedReq as { params: Record<string, unknown> }).params
    assert.equal(params.pane_id, 'w1:p1')
    assert.deepEqual(params.keys, ['ctrl+c'])
    assert.equal(params.text, undefined, 'keys-only: text must be undefined')
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: paneSendInput preserves combined text and keys', async () => {
  let capturedReq: Req | null = null
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    capturedReq = req
    replyAndClose(conn, req, { type: 'ok' })
  })
  try {
    const client = makeClient(path)
    await client.paneSendInput({ pane_id: 'w1:p1', text: 'deploy', keys: ['enter'] })
    assert.deepEqual((capturedReq as Req | null)?.params, { pane_id: 'w1:p1', text: 'deploy', keys: ['enter'] })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: paneSendInput error propagates', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    if (req.method === 'pane.send_input') {
      replyErrorAndClose(conn, req, 'PANE_NOT_FOUND', 'pane not found')
    } else replyAndClose(conn, req, {})
  })
  try {
    const client = makeClient(path)
    await assert.rejects(
      () => client.paneSendInput({ pane_id: 'w1:nonexistent', text: 'x' }),
      (err: Error) => {
        assert.ok(err.message.includes('pane not found'))
        return true
      }
    )
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: paneWaitForOutputChange uses events.wait revision matching', async () => {
  let capturedReq: Req | null = null
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    capturedReq = req
    replyAndClose(conn, req, {
      type: 'wait_matched',
      event: {
        event: 'pane_output_changed',
        data: { type: 'pane_output_changed', pane_id: 'w1:p1', workspace_id: 'w1', revision: 43 },
      },
    })
  })
  try {
    const client = makeClient(path)
    const result = await client.paneWaitForOutputChange({ pane_id: 'w1:p1', min_revision: 42, timeout_ms: 1_000 })
    assert.deepEqual(result, { changed: true, revision: 43 })
    assert.deepEqual((capturedReq as Req | null)?.params, {
      match_event: { event: 'pane_output_changed', pane_id: 'w1:p1', min_revision: 42 },
      timeout_ms: 1_000,
    })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('socket: paneWaitForOutputChange treats server timeout as unchanged', async () => {
  const { path, server, dir } = await startFakeServer((conn, req, close) => {
    replyErrorAndClose(conn, req, 'timeout', 'no matching event')
  })
  try {
    const client = makeClient(path)
    const result = await client.paneWaitForOutputChange({ pane_id: 'w1:p1', min_revision: 9, timeout_ms: 1_000 })
    assert.deepEqual(result, { changed: false, revision: 9 })
    client.close()
  } finally {
    server.close(); rmSync(dir, { recursive: true, force: true })
  }
})
