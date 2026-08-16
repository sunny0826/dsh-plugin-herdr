import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import {
  CliHerdrClient,
  HerdrCliError,
  killProcessTree,
  MAX_CLI_OUTPUT_BYTES,
  type SpawnFn,
} from '../../src/client/cli.ts'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill = () => { this.killed = true; return true }
  // CA-002：哨兵 pid —— 大于任何真实 pid_max（macOS 99999 / Linux 默认 4M），
  // 使 killProcessTree 的进程组杀（process.kill(-pid)）必然 ESRCH，不会误杀真实进程
  pid = 2_147_483_646
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

test('agent wait: success envelope -> completed (agent_info branch, live-verified shape)', async () => {
  // CA-004：实测 CLI 与 raw socket 的 agent.wait 成功路径都返回 agent_info 分支
  // （{ agent: AgentInfo, type: 'agent_info' }），状态字段为 agent.agent_status
  const client = makeAdapter([
    (c) => emitJson(c, {
      id: 'w',
      result: {
        type: 'agent_info',
        agent: { agent: 'claude', agent_status: 'done', pane_id: 'w9:p1', name: 'claude' },
      },
    }),
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'] }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.equal(res.status, 'done')
    assert.equal(res.agent, 'claude')
    assert.equal(res.pane_id, 'w9:p1')
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

// ---------------------------------------------------------------------------
// T04：workspace/pane close 与 rename（envelope 模式；T01-E/F 实测语义）
// ---------------------------------------------------------------------------

test('workspaceClose success envelope resolves void', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'c', result: { type: 'ok' } }) },
  ])
  await client.workspaceClose('wB')
  assert.deepEqual(seen[0], ['workspace', 'close', 'wB'])
})

test('workspaceClose error envelope (exit 1, stdout) throws with workspace_not_found', async () => {
  // T01-E：close 错误 envelope 在 stdout、exit 1；envelope 模式须把错误码带给工具层
  const client = makeAdapter([
    (c) => {
      c.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'c', error: { code: 'workspace_not_found', message: 'workspace wZzz not found' } })))
      c.emit('close', 1, null)
    },
  ])
  await assert.rejects(() => client.workspaceClose('wZzz'), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ERROR')
    assert.match(err.message, /workspace close/)
    assert.match(err.message, /workspace_not_found/)
    return true
  })
})

test('paneClose now surfaces pane_not_found from a stdout error envelope (T04 envelope mode)', async () => {
  // T01-E：已关闭 pane 再次 close → pane_not_found、exit 1；rawText 本会丢码
  const client = makeAdapter([
    (c) => {
      c.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'c', error: { code: 'pane_not_found', message: 'pane w1:p9 not found' } })))
      c.emit('close', 1, null)
    },
  ])
  await assert.rejects(() => client.paneClose('w1:p9'), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ERROR')
    assert.match(err.message, /pane close/)
    assert.match(err.message, /pane_not_found/)
    return true
  })
})

test('workspaceRename splits multi-word label into positional args', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'r', result: { type: 'workspace_info', workspace: { workspace_id: 'wB' } } }) },
  ])
  await client.workspaceRename('wB', 'my probe ws')
  assert.deepEqual(seen[0], ['workspace', 'rename', 'wB', 'my', 'probe', 'ws'])
})

test('paneRename null label emits --clear after pane_id', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'r', result: { type: 'pane_info', pane: { pane_id: 'wB:p1' } } }) },
  ])
  await client.paneRename('wB:p1', null)
  assert.deepEqual(seen[0], ['pane', 'rename', 'wB:p1', '--clear'])
})

test('paneRename blank label also emits --clear (pane_id kept, before --clear)', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'r', result: { type: 'pane_info', pane: { pane_id: 'wB:p2' } } }) },
  ])
  await client.paneRename('wB:p2', '   ')
  assert.deepEqual(seen[0], ['pane', 'rename', 'wB:p2', '--clear'])
})

test('paneRename splits non-empty label into positional words', async () => {
  const seen: string[][] = []
  const client = makeAdapter([
    (c, _cmd, args) => { seen.push(args); emitJson(c, { id: 'r', result: { type: 'pane_info', pane: { pane_id: 'wB:p1' } } }) },
  ])
  await client.paneRename('wB:p1', 'my agent demo')
  assert.deepEqual(seen[0], ['pane', 'rename', 'wB:p1', 'my', 'agent', 'demo'])
})

// ---------------------------------------------------------------------------
// CA-001：CLI 超时 / Abort / 退出码处理
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** spawn 剧本：子进程永不响应，捕获 child 供断言。 */
function makeHangingAdapter(timeoutMs = 60_000) {
  const children: FakeChild[] = []
  const spawnImpl = ((_cmd: string, _args: string[], _opts: unknown) => {
    const child = new FakeChild()
    children.push(child)
    setImmediate(() => { /* 永不响应 */ })
    return child as never
  }) as unknown as SpawnFn
  const client = new CliHerdrClient(new Context(), { cliPath: 'herdr', timeoutMs, session: undefined }, spawnImpl)
  return { client, children }
}

test('CA-001: every CLI call defaults to config timeout and kills the child on HERDR_TIMEOUT', async () => {
  // 配置 timeoutMs=60：runCli 未显式传 spawnTimeoutMs，必须使用配置默认值
  const { client, children } = makeHangingAdapter(60)
  await assert.rejects(() => client.snapshot(), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_TIMEOUT')
    return true
  })
  assert.equal(children.length, 1)
  assert.equal(children[0].killed, true, 'timeout kills the child process')
})

test('CA-001: explicit spawnTimeoutMs overrides config default timeout', async () => {
  // waitAgent 用 timeout_ms + 10s 作为 spawn 上限，远小于配置默认 60s；
  // 若默认值生效会挂 60s，因此此用例同时验证“显式优先”。
  const { client, children } = makeHangingAdapter(60_000)
  await assert.rejects(
    () => client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 30 }, new AbortController().signal),
    (err: Error) => {
      assert.ok(err instanceof HerdrCliError)
      assert.equal(err.code, 'HERDR_TIMEOUT')
      return true
    },
  )
  assert.equal(children[0].killed, true)
})

test('CA-001: abort kills the child and rejects HERDR_ABORTED', async () => {
  const { client, children } = makeHangingAdapter()
  const ac = new AbortController()
  const p = client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 100 }, ac.signal)
  await sleep(20) // 确保子进程已 spawn
  ac.abort()
  await assert.rejects(() => p, (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ABORTED')
    return true
  })
  assert.equal(children.length, 1)
  assert.equal(children[0].killed, true, 'abort kills the child process')
})

test('CA-001: pre-aborted signal rejects HERDR_ABORTED without spawning', async () => {
  let spawns = 0
  const spawnImpl = ((_cmd: string, _args: string[], _opts: unknown) => {
    spawns++
    return new FakeChild() as never
  }) as unknown as SpawnFn
  const client = new CliHerdrClient(new Context(), { cliPath: 'herdr', timeoutMs: 60_000, session: undefined }, spawnImpl)
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => client.waitAgent({ target: 'w9:p1', until: ['done'] }, ac.signal), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ABORTED')
    return true
  })
  assert.equal(spawns, 0, 'no child process spawned for an already-aborted call')
})

test('CA-001: runCommand abort propagates to CLI subprocesses (pane run killed)', async () => {
  const children: FakeChild[] = []
  const spawnImpl = ((_cmd: string, _args: string[], _opts: unknown) => {
    const child = new FakeChild()
    children.push(child)
    const idx = children.length - 1
    setImmediate(() => {
      if (idx === 0) emitJson(child, { id: 's', result: { type: 'pane_info', pane: { pane_id: 'w9:p9' } } })
      if (idx === 1) emitText(child, '') // baseline read
      if (idx === 2) { /* pane run 永不响应 */ }
    })
    return child as never
  }) as unknown as SpawnFn
  const client = new CliHerdrClient(new Context(), { cliPath: 'herdr', timeoutMs: 60_000, session: undefined }, spawnImpl)
  const ac = new AbortController()
  const p = client.runCommand({ command: 'sleep 100', wait_ms: 10_000 }, ac.signal)
  await sleep(30) // 等待 split + baseline 完成、pane run 发出
  ac.abort()
  await assert.rejects(() => p, (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ABORTED')
    return true
  })
  assert.ok(children.length >= 3, 'split, baseline read, pane run spawned')
  assert.equal(children[2].killed, true, 'pane run child killed on abort')
})

test('CA-001: non-zero exit with envelope error on stderr maps to domain error (agent_not_found)', async () => {
  // env-findings §8.2：不存在的 pane 等部分错误把 envelope 输出到 stderr 且 exit 1
  const client = makeAdapter([
    (c) => {
      c.stderr.emit('data', Buffer.from(JSON.stringify({ id: 'w', error: { code: 'agent_not_found', message: 'no such pane' } })))
      c.emit('close', 1, null)
    },
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'] }, new AbortController().signal)
  assert.deepEqual(res, { kind: 'not_found', target: 'w9:p1' })
})

test('CA-001: non-zero exit with unparseable output throws stable HERDR_ERROR', async () => {
  const client = makeAdapter([
    (c) => { c.stdout.emit('data', Buffer.from('boom')); c.emit('close', 1, null) },
  ])
  await assert.rejects(() => client.snapshot(), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ERROR')
    assert.match(err.message, /exit/)
    return true
  })
})

test('CA-001: rawText command with non-zero exit throws instead of reporting success', async () => {
  // send-keys/run 等 rawText 命令此前非零退出被当作成功（CA-001 P0）
  // （paneClose 已于 T04 改为 envelope 模式，故此处用 paneSendKeys 验证 rawText 路径）
  const client = makeAdapter([
    (c) => { c.stderr.emit('data', Buffer.from('pane not found')); c.emit('close', 1, null) },
  ])
  await assert.rejects(() => client.paneSendKeys({ pane_id: 'w9:p9', keys: ['x'] }), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ERROR')
    assert.match(err.message, /send-keys/)
    assert.match(err.message, /exit 1/)
    return true
  })
})

test('CA-001: non-zero exit with a result envelope still throws HERDR_ERROR', async () => {
  const client = makeAdapter([
    (c) => {
      c.stdout.emit('data', Buffer.from(JSON.stringify({ id: 'x', result: { agents: [] } })))
      c.emit('close', 1, null)
    },
  ])
  await assert.rejects(() => client.listAgents(), (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ERROR')
    return true
  })
})

test('CA-001: exit 0 with error envelope still returns domain error (unchanged)', async () => {
  // env-findings §8.1：多数命令错误时退出码仍为 0，错误在 envelope error 字段
  const client = makeAdapter([
    (c) => emitJson(c, { id: 'w', error: { code: 'timeout', message: 'timed out' } }),
  ])
  const res = await client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 500 }, new AbortController().signal)
  assert.equal(res.kind, 'timeout')
})

// ---------------------------------------------------------------------------
// CA-002：CLI 输出上限与进程树终止
// ---------------------------------------------------------------------------

test('CA-002: stdout is capped at MAX_CLI_OUTPUT_BYTES and reported truncated', async () => {
  const chunk = 'x'.repeat(600_000)
  const client = makeAdapter([
    (c) => {
      c.stdout.emit('data', Buffer.from(chunk))
      c.stdout.emit('data', Buffer.from(chunk))
      c.emit('close', 0, null)
    },
  ])
  const res = await client.paneRead({ pane_id: 'w9:p9' })
  assert.equal(res.text.length, MAX_CLI_OUTPUT_BYTES, 'output accumulated up to the cap')
  assert.equal(res.truncated, true, 'truncation is reported')
})

test('CR: non-ASCII output is capped by UTF-8 bytes, not UTF-16 code units', async () => {
  // 每个“中”= 3 UTF-8 字节（2 UTF-16 码元）：旧实现按 length 累计会虚高
  const chunk = '中'.repeat(400_000) // 1.2MB UTF-8 / 0.8M 码元
  const client = makeAdapter([
    (c) => {
      c.stdout.emit('data', Buffer.from(chunk, 'utf8'))
      c.stdout.emit('data', Buffer.from(chunk, 'utf8'))
      c.emit('close', 0, null)
    },
  ])
  const res = await client.paneRead({ pane_id: 'w9:p9' })
  assert.equal(res.truncated, true)
  assert.ok(Buffer.byteLength(res.text, 'utf8') <= MAX_CLI_OUTPUT_BYTES, `bytes=${Buffer.byteLength(res.text)}`)
  assert.ok(Buffer.byteLength(res.text, 'utf8') > MAX_CLI_OUTPUT_BYTES - 64, 'capped near the limit (not far under)')
})

test('CA-002: runCommand result reports truncated when pane read exceeds the cap', async () => {
  const big = 'z'.repeat(MAX_CLI_OUTPUT_BYTES + 100)
  const readBig = (c: FakeChild) => { if (true) emitText(c, big) }
  const client = makeAdapter([
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, '') }, // baseline（pane_id 已给，无 split）
    (c, _cmd, args) => { if (args.includes('sh')) c.emit('close', 0, null) }, // pane run
    readBig, readBig, readBig, readBig, readBig, readBig, // poll reads（稳定判定需 5 次）
  ], 10000)
  const res = await client.runCommand({ command: 'cat huge', pane_id: 'w9:p9', wait_ms: 10000 }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.equal(res.truncated, true, 'truncated flag reaches the tool result')
    assert.ok(res.output.length <= MAX_CLI_OUTPUT_BYTES)
  }
})

test('CA-002 (POSIX): killProcessTree terminates the whole process group (no leftover)', { skip: process.platform === 'win32' }, async () => {
  // 真实 spawn：sh -c 派生子进程 sleep（同一进程组），验证整树终止、无残留
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pgid = child.pid!
  try {
    // detached spawn 后 child 是进程组 leader：负 pid 可寻址整个组
    assert.doesNotThrow(() => process.kill(-pgid, 0), 'process group exists after detached spawn')
    await sleep(150) // 等 sleep 子进程 fork 完成
    killProcessTree(child)
    // leader close 表示已被 reap（此后组内若还有成员即为残留）
    await Promise.race([
      new Promise<void>(res => child.once('close', () => res())),
      sleep(3000),
    ])
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try { process.kill(-pgid, 0); await sleep(50) } catch { break }
    }
    assert.throws(() => process.kill(-pgid, 0), /ESRCH/, 'entire process group must be gone (no leftover children)')
  } finally {
    killProcessTree(child)
  }
})

test('CA-002 (POSIX): abort via adapter kills the child (group-kill path is ESRCH-safe for fake pids)', async () => {
  const { client, children } = makeHangingAdapter()
  const ac = new AbortController()
  const p = client.waitAgent({ target: 'w9:p1', until: ['done'], timeout_ms: 100 }, ac.signal)
  await sleep(20)
  ac.abort()
  await assert.rejects(() => p, (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ABORTED')
    return true
  })
  assert.equal(children[0].killed, true, 'direct child killed on abort')
})

// ---------------------------------------------------------------------------
// CA-011：轮询期 abort → HERDR_ABORTED（不再伪装成 timed_out）
// ---------------------------------------------------------------------------

test('CA-011: runCommand abort during polling rejects HERDR_ABORTED (not timed_out)', async () => {
  const client = makeAdapter([
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, '') }, // baseline（pane_id 已给，无 split）
    (c, _cmd, args) => { if (args.includes('sh')) c.emit('close', 0, null) }, // pane run
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, 'out1') }, // 轮询第 1 读
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, 'out2') },
  ], 10000)
  const ac = new AbortController()
  const p = client.runCommand({ command: 'sleep 5', pane_id: 'w9:p9', wait_ms: 10000 }, ac.signal)
  await sleep(600) // 第 1 轮读已发出（interval 500ms），随后取消
  ac.abort()
  await assert.rejects(() => p, (err: Error) => {
    assert.ok(err instanceof HerdrCliError)
    assert.equal(err.code, 'HERDR_ABORTED')
    return true
  })
})

test('CA-011: runCommand completes normally with timed_out:false (regression)', async () => {
  const text = '\n❯ echo hi\nhi\n'
  const client = makeAdapter([
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, '') }, // baseline
    (c, _cmd, args) => { if (args.includes('sh')) c.emit('close', 0, null) }, // pane run
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
    (c, _cmd, args) => { if (args.includes('read')) emitText(c, text) },
  ], 10000)
  const res = await client.runCommand({ command: 'echo hi', pane_id: 'w9:p9', wait_ms: 10000 }, new AbortController().signal)
  assert.equal(res.kind, 'completed')
  if (res.kind === 'completed') {
    assert.equal(res.timed_out, false)
    assert.match(res.output, /hi/)
  }
})