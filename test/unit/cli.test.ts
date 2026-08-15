import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { CliHerdrClient, HerdrCliError, type SpawnFn } from '../../src/client/cli.ts'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill = () => { this.killed = true; return true }
  pid = 4242
}

/** spawn 剧本：每个 step 接收 child 并决定其行为。 */
function makeAdapter(steps: Array<(child: FakeChild, cmd: string, args: string[]) => void>, timeoutMs = 5000, session?: string) {
  const spawnImpl = ((cmd: string, args: string[], _opts: unknown) => {
    const child = new FakeChild()
    const step = steps.shift()
    // 监听器在 spawn 返回后才注册；setImmediate 保证事件不丢失
    if (step) setImmediate(() => step(child, cmd, args))
    else setImmediate(() => child.emit('error', new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`)))
    return child as never
  }) as unknown as SpawnFn
  return new CliHerdrClient(new Context(), { cliPath: 'herdr', timeoutMs, session }, spawnImpl)
}

const emitJson = (child: FakeChild, obj: unknown) => {
  child.stdout.emit('data', Buffer.from(JSON.stringify(obj)))
  child.emit('close', 0, null)
}

const emitText = (child: FakeChild, text: string) => {
  child.stdout.emit('data', Buffer.from(text))
  child.emit('close', 0, null)
}

// ---------------------------------------------------------------------------

test('snapshot parses envelope result.snapshot', async () => {
  const client = makeAdapter([
    (c) => emitJson(c, { id: 'x', result: { type: 'snapshot', snapshot: { version: '0.8.0', protocol: 19, agents: [], panes: [], tabs: [], workspaces: [], layouts: [], focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null } } }),
  ])
  const snap = await client.snapshot()
  assert.equal(snap.version, '0.8.0')
  assert.equal(snap.protocol, 19)
})

test('snapshot missing result throws HERDR_PROTOCOL', async () => {
  const client = makeAdapter([(c) => emitJson(c, { id: 'x', result: {} })])
  await assert.rejects(() => client.snapshot(), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_PROTOCOL')
    return true
  })
})

test('listAgents parses agents and filters by workspace/status', async () => {
  const respond = (c: FakeChild) => emitJson(c, { id: 'x', result: { type: 'agent_list', agents: [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', status: 'working', message: 'refactor' },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', status: 'done' },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', status: 'done' },
  ] } })
  const client = makeAdapter([respond, respond, respond])
  const all = await client.listAgents()
  assert.equal(all.length, 3)
  const done = await client.listAgents({ status: 'done' })
  assert.equal(done.length, 2)
  const w1 = await client.listAgents({ workspace_id: 'w1', status: 'working' })
  assert.equal(w1.length, 1)
  assert.equal(w1[0].agent, 'claude')
})

test('listAgents retries once on HERDR_UNAVAILABLE (retryRead)', async () => {
  let calls = 0
  const client = makeAdapter([
    (c) => { calls++; c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) },
    (c) => { calls++; emitJson(c, { id: 'x', result: { agents: [] } }) },
  ])
  const agents = await client.listAgents()
  assert.equal(calls, 2)
  assert.deepEqual(agents, [])
})

test('ENOENT without retry throws HERDR_UNAVAILABLE', async () => {
  const client = makeAdapter([
    (c) => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  ])
  await assert.rejects(() => client.snapshot(), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_UNAVAILABLE')
    return true
  })
})

test('runCommand: split -> baseline read -> run -> poll read until stable', async () => {
  const seen: string[][] = []
  const text = '\n❯ echo hi\nhi\n'
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 's', result: { type: 'pane_info', pane: { pane_id: 'w9:p9' } } }) },
    (c, _cmd, args) => { seen.push(args); emitText(c, '') },
    (c, _cmd, args) => { seen.push(args); c.emit('close', 0, null) },
    (c, _cmd, args) => { seen.push(args); emitText(c, text) },
    (c, _cmd, args) => { seen.push(args); emitText(c, text) },
    (c, _cmd, args) => { seen.push(args); emitText(c, text) },
    (c, _cmd, args) => { seen.push(args); emitText(c, text) },
    (c, _cmd, args) => { seen.push(args); emitText(c, text) },
  ], 10000)
  const res = await client.runCommand({ command: 'echo hi', wait_ms: 10000 }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.equal(res.pane_id, 'w9:p9')
    assert.equal(res.timed_out, false)
    assert.match(res.output, /hi/)
  }
  // 调用序列：split(含 --direction right)、baseline read、run(含 sh -c)、多次 read
  assert.deepEqual(seen[0].slice(0, 2), ['pane', 'split'])
  assert.ok(seen[1].includes('read'), 'second call is the baseline read')
  assert.ok(seen[2].includes('sh'), 'third call is pane run')
  assert.ok(seen[3].includes('read'))
})

test('runCommand reuses existing pane_id (no split)', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitText(c, '') },
    (c, _cmd, args) => { seen.push(args); c.emit('close', 0, null) },
    (c, _cmd, args) => { seen.push(args); emitText(c, 'out1') },
    (c, _cmd, args) => { seen.push(args); emitText(c, 'out1') },
    (c, _cmd, args) => { seen.push(args); emitText(c, 'out1') },
    (c, _cmd, args) => { seen.push(args); emitText(c, 'out1') },
    (c, _cmd, args) => { seen.push(args); emitText(c, 'out1') },
  ], 10000)
  const res = await client.runCommand({ command: 'x', pane_id: 'w1:p1', wait_ms: 10000 }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  assert.ok(seen[0].includes('read'), 'first call is the baseline read')
  assert.ok(seen[1].includes('w1:p1'), 'second call should be pane run')
})

test('runCommand: baseline prefix is trimmed from output', async () => {
  const client = makeAdapter([
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~'),
    (c, _cmd, _args) => { c.emit('close', 0, null) },
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~\n❯ echo hi\nhi\n~'),
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~\n❯ echo hi\nhi\n~'),
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~\n❯ echo hi\nhi\n~'),
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~\n❯ echo hi\nhi\n~'),
    (c, _cmd, _args) => emitText(c, 'OLD-HEAD\n~\n❯ echo hi\nhi\n~'),
  ], 10000)
  const res = await client.runCommand({ command: 'echo hi', pane_id: 'w1:p1', wait_ms: 10000 }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.ok(!res.output.includes('OLD-HEAD'), 'history prefix trimmed')
    assert.match(res.output, /echo hi/)
    assert.match(res.output, /hi/)
  }
})

test('agentPrompt: parses agent_status envelope into lossless JSON result', async () => {
  const client = makeAdapter([
    (c, _cmd, _args) => emitJson(c, {
      id: 'p',
      result: { agent: { agent_status: 'idle', pane_id: 'w1:p1', agent: 'pi' }, type: 'agent_prompted' },
    }),
  ], 10000)
  const res = await client.agentPrompt({ target: 'pi', text: 'say hi', wait: true, until: ['idle'], timeout_ms: 5000 }, new AbortController().signal)
  assert.equal(res.submitted, true)
  assert.equal(res.status, 'idle')
  assert.equal(typeof res.waited_ms, 'number')
  // 关键回归：lossless JSON 不允许 undefined 字段
  assert.ok(!JSON.stringify(res).includes('undefined'), 'no undefined fields leak into output')
  assert.ok('status' in res, 'status present when known')
})

test('agent wait: agent_not_found -> not_found', async () => {
  const client = makeAdapter([
    (c) => emitJson(c, { id: 'w', error: { code: 'agent_not_found', message: 'agent target w9:p1 not found' } }),
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'] }, new AbortController().signal)
  assert.deepEqual(res, { kind: 'not_found', target: 'w9:p1' })
})

test('agent wait: timeout error -> timeout', async () => {
  const client = makeAdapter([
    (c) => emitJson(c, { id: 'w', error: { code: 'timeout', message: 'timed out' } }),
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 500 }, new AbortController().signal)
  assert.equal(res.kind, 'timeout')
})

test('agent wait: success envelope -> completed', async () => {
  const client = makeAdapter([
    (c) => emitJson(c, { id: 'w', result: { type: 'agent_wait', status: 'done', agent: 'claude', message: 'finished' } }),
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'] }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.equal(res.status, 'done')
    assert.equal(res.agent, 'claude')
  }
})

test('session is threaded through every command', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'x', result: { agents: [] } }) },
  ], 5000, 'work')
  await client.listAgents()
  assert.deepEqual(seen[0].slice(0, 3), ['--session', 'work', 'agent'])
})