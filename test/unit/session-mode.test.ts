import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as sessionMode from '../../src/session-mode.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'

// 注：测试直接调用 apply（与 state-report 测试一致）。真实 dsh 环境由 loader
// 挂载组合（standing scope），事件经 scope 载体过滤后到达监听器。
// bind 语义（MG-50 修复轮）：会话启动时在项目目录创建专属 workspace（root pane
// 即绑定 pane），本会话产出的 pane 都归于此 workspace；会话结束关闭整个 workspace。

interface Call {
  pane_id?: string
  workspace_id?: string
  source?: string
  agent?: string
  state?: string
  message?: string
  cwd?: string
  [key: string]: unknown
}

type MarkedPane = { pane_id: string; workspace_id?: string; tokens?: { [key: string]: string } | null }

function makeHarness(markedPanes: MarkedPane[] = [], wsPane: string | null = 'wN:p1') {
  const calls = {
    snapshots: 0,
    wsCreates: [] as Call[],
    splits: [] as Call[],
    reports: [] as Call[],
    clears: [] as Call[],
    closes: [] as string[],
    wsCloses: [] as string[],
    renames: [] as Call[],
    metadata: [] as Call[],
  }
  const herdr = {
    snapshot: async () => {
      calls.snapshots += 1
      return { focused_pane_id: 'w1:p1', panes: markedPanes }
    },
    reportMetadata: async (req: Call) => {
      calls.metadata.push(req)
    },
    // 专属 workspace 语义：bind 不再 split 焦点 pane
    paneSplit: async (req: Call) => {
      calls.splits.push(req)
      throw new Error('paneSplit must not be used by bind (dedicated workspace)')
    },
    workspaceCreate: async (req: Call) => {
      calls.wsCreates.push(req)
      // 每次创建独立 workspace/pane（区分各 agent 的绑定）
      const n = calls.wsCreates.length
      return wsPane === null
        ? { workspace_id: 'wN' + n }
        : { workspace_id: 'wN' + n, pane_id: 'wN' + n + ':p1' }
    },
    paneRename: async (paneId: string, label: string | null) => {
      calls.renames.push({ pane_id: paneId, label })
    },
    reportAgent: async (req: Call) => {
      calls.reports.push(req)
    },
    clearAgentAuthority: async (req: Call) => {
      calls.clears.push(req)
    },
    paneClose: async (paneId: string) => {
      calls.closes.push(paneId)
    },
    workspaceClose: async (workspaceId: string) => {
      calls.wsCloses.push(workspaceId)
    },
  }
  const ctx = new Context()
  ctx.provide('herdr', herdr)
  sessionMode.apply(ctx, { paneId: '', source: 'dsh:test', label: '' })
  return { ctx, calls }
}

const flush = () => new Promise(res => setImmediate(res))

test('session-mode: agent/created creates a dedicated workspace (project cwd) with display labels', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', {
    agent: { id: 'sess-A', session: { header: { cwd: '/proj/dsh-plugin' } } },
  })
  await flush()
  assert.equal(calls.wsCreates.length, 1, 'dedicated workspace created')
  assert.equal(calls.splits.length, 0, 'no split — dedicated workspace instead')
  // 显示名与内部标记分离（MG-55）：label = dsh:<项目名>-<会话短 id>
  assert.equal(calls.wsCreates[0].label, 'dsh:dsh-plugin-sess-A', 'workspace label is dsh:<project>-<short session id>')
  assert.equal(calls.wsCreates[0].cwd, '/proj/dsh-plugin', 'workspace created in project cwd')
  assert.deepEqual(calls.renames[0], { pane_id: 'wN1:p1', label: 'dsh:dsh-plugin-sess-A' }, 'pane label is the display name')
  // 内部标记走 tokens（ttl=null 永久），不在 label 里暴露 session id
  assert.deepEqual(calls.metadata[0], {
    pane_id: 'wN1:p1',
    source: 'dsh:test',
    agent: 'dsh',
    tokens: { dsh_session: 'sess-A' },
    ttl_ms: null,
  }, 'internal marker stored in pane tokens')
  assert.equal(calls.reports.length, 1)
  assert.equal(calls.reports[0].state, 'idle')
  assert.equal(calls.reports[0].pane_id, 'wN1:p1')
  assert.equal(calls.reports[0].agent, 'dsh')
  void ctx.fiber.dispose()
})

test('session-mode: no project cwd → label falls back to dsh:<short session id>', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.wsCreates[0].label, 'dsh:sess-A', 'fallback label uses short id')
  assert.equal(calls.renames[0].label, 'dsh:sess-A')
  void ctx.fiber.dispose()
})

test('session-mode: request → working, turn-stopping → idle, keyed per agent', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-B' } })
  await flush()
  // 每个 agent 独立专属 workspace（无跨会话共享）
  assert.equal(calls.wsCreates.length, 2)

  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  assert.equal(resolved, 'cfg', 'waterfall chain passes through next()')
  await ctx.serial({} as any, 'agent/turn-stopping', { agent: { id: 'sess-A' } })

  // A 绑定 wN1:p1（第一个 workspace），B 绑定 wN2:p1（第二个）
  const aStates = calls.reports.filter(r => r.pane_id === 'wN1:p1').map(s => s.state)
  assert.deepEqual(aStates, ['idle', 'working', 'idle'], 'A: idle → working → idle')
  const bStates = calls.reports.filter(r => r.pane_id === 'wN2:p1').map(s => s.state)
  assert.deepEqual(bStates, ['idle'], 'B: only its own idle — no cross-talk')
  void ctx.fiber.dispose()
})

test('session-mode: fixed paneId binds every agent to the configured pane without workspace', async () => {
  const ctx = new Context()
  const calls = { splits: 0, wsCreates: 0, reports: [] as Call[] }
  const herdr = {
    snapshot: async () => { throw new Error('snapshot must not be called') },
    paneSplit: async () => { calls.splits += 1; return { pane_id: 'x' } },
    workspaceCreate: async () => { calls.wsCreates += 1; return { workspace_id: 'x', pane_id: 'x:p1' } },
    reportAgent: async (req: Call) => { calls.reports.push(req) },
    clearAgentAuthority: async () => {},
  }
  ctx.provide('herdr', herdr)
  sessionMode.apply(ctx, { paneId: 'w5:p1', source: 'dsh:test', label: 'dsh' })
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.splits, 0)
  assert.equal(calls.wsCreates, 0)
  assert.equal(calls.reports[0].pane_id, 'w5:p1')
  void ctx.fiber.dispose()
})

test('session-mode: bind failure degrades silently (no pane, no crash)', async () => {
  const { ctx, calls } = makeHarness([], null)
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.reports.length, 0, 'no report without a bound pane')
  // 事件链仍工作：request 不抛错
  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  assert.equal(resolved, 'cfg')
  void ctx.fiber.dispose()
})

test('session-mode: agent/disposed closes the dedicated workspace and clears binding', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-A' } })
  await flush()
  assert.deepEqual(calls.wsCloses, ['wN1'], 'dedicated workspace closed on dispose')
  assert.equal(calls.closes.length, 0, 'no paneClose — workspace close covers it')
  assert.equal(calls.clears.length, 0, 'no release-agent for a closed pane')
  // 释放后该 agent 的状态不再上报
  const before = calls.reports.length
  await ctx.serial({} as any, 'agent/turn-stopping', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.reports.length, before, 'no report after dispose')
  void ctx.fiber.dispose()
})

test('session-mode: fixed pane is released (not closed) on dispose', async () => {
  const ctx = new Context()
  const calls = { closes: [] as string[], wsCloses: [] as string[], clears: [] as Call[], reports: [] as Call[] }
  const herdr = {
    snapshot: async () => { throw new Error('must not snapshot') },
    paneSplit: async () => { throw new Error('must not split') },
    workspaceCreate: async () => { throw new Error('must not create') },
    workspaceClose: async (workspaceId: string) => { calls.wsCloses.push(workspaceId) },
    reportAgent: async (req: Call) => { calls.reports.push(req) },
    clearAgentAuthority: async (req: Call) => { calls.clears.push(req) },
    paneClose: async (paneId: string) => { calls.closes.push(paneId) },
  }
  ctx.provide('herdr', herdr)
  sessionMode.apply(ctx, { paneId: 'w5:p1', source: 'dsh:test', label: 'dsh' })
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-A' } })
  await flush()
  assert.deepEqual(calls.closes, [], 'fixed pane not closed')
  assert.deepEqual(calls.wsCloses, [], 'no workspace to close')
  assert.equal(calls.clears.length, 1, 'fixed pane releases authority')
  assert.equal(calls.clears[0].pane_id, 'w5:p1')
  void ctx.fiber.dispose()
})

test('session-mode: context dispose closes created workspaces', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  void ctx.fiber.dispose()
  await flush()
  assert.deepEqual(calls.wsCloses, ['wN1'], 'created workspace closed on context dispose')
  assert.equal(calls.clears.length, 0)
})

function makeSlowHarness(snapshotDelayMs = 80) {
  const calls = { wsCreates: [] as Call[], closes: [] as string[], wsCloses: [] as string[], reports: [] as Call[] }
  const herdr = {
    snapshot: async () => {
      await new Promise(r => setTimeout(r, snapshotDelayMs))
      return { focused_pane_id: 'w1:p1', panes: [] }
    },
    paneSplit: async () => { throw new Error('must not split') },
    workspaceCreate: async (req: Call) => { calls.wsCreates.push(req); return { workspace_id: 'wN', pane_id: 'wN:p1' } },
    paneRename: async () => {},
    reportMetadata: async () => {},
    workspaceClose: async (workspaceId: string) => { calls.wsCloses.push(workspaceId) },
    reportAgent: async (req: Call) => { calls.reports.push(req) },
    clearAgentAuthority: async () => {},
    paneClose: async (paneId: string) => { calls.closes.push(paneId) },
  }
  const ctx = new Context()
  ctx.provide('herdr', herdr)
  sessionMode.apply(ctx, { paneId: '', source: 'dsh:test', label: 'dsh' })
  return { ctx, calls }
}

test('CA-013: dispose before bind completes leaves no pane or registry entry', async () => {
  const registry = getBindingRegistry()
  const { ctx, calls } = makeSlowHarness()
  // agent/created 触发异步 bind（snapshot 80ms 在途）
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-race' } })
  // bind 完成前 agent 被 dispose
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-race' } })
  await new Promise(r => setTimeout(r, 200))
  // workspace 创建了，但立即被回收：不遗留 registry/绑定，不上报 idle
  assert.equal(calls.wsCreates.length, 1, 'bind still ran to create the workspace')
  assert.deepEqual(calls.wsCloses, ['wN'], 'workspace created mid-race must be closed')
  assert.equal(registry.has('sess-race'), false, 'no registry entry for disposed agent')
  assert.equal(calls.reports.length, 0, 'no idle report for a disposed agent')
  // 事件链不受影响
  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-race' } }, () => 'cfg')
  assert.equal(resolved, 'cfg')
  void ctx.fiber.dispose()
})

test('CA-013: dispose after bind completes still cleans up normally', async () => {
  const registry = getBindingRegistry()
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(registry.has('sess-A'), true)
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-A' } })
  await flush()
  assert.deepEqual(calls.wsCloses, ['wN1'])
  assert.equal(registry.has('sess-A'), false)
  void ctx.fiber.dispose()
})

test('CR: dispose during bind clears the disposedAgents flag — session id reuse binds fresh', async () => {
  const registry = getBindingRegistry()
  const { ctx, calls } = makeSlowHarness()
  // 第一次：bind 在途时 dispose → workspace 被回收，标记必须清除
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-reuse' } })
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-reuse' } })
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(calls.wsCloses, ['wN'], 'mid-race workspace closed')
  assert.equal(registry.has('sess-reuse'), false)
  // 第二次：同一 session id 复用——必须正常绑定（新建 workspace、不误关）
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-reuse' } })
  await new Promise(r => setTimeout(r, 150)) // bind 是异步的（慢 snapshot 80ms）
  assert.equal(registry.has('sess-reuse'), true, 'reused session id binds again')
  assert.equal(calls.wsCloses.length, 1, 'no spurious close for the reused binding')
  assert.equal(calls.wsCreates.length, 2, 'second bind creates a fresh workspace')
  // 正常 dispose 第二次绑定
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-reuse' } })
  await flush()
  assert.deepEqual(calls.wsCloses, ['wN', 'wN'], 'second binding closed on dispose')
  assert.equal(registry.has('sess-reuse'), false)
  void ctx.fiber.dispose()
})

test('CA-013: context dispose only removes its own registry keys (multi-instance/HMR)', async () => {
  const registry = getBindingRegistry()
  const a = makeHarness()
  const b = makeHarness()
  a.ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  b.ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-B' } })
  await flush()
  assert.equal(registry.has('sess-A'), true)
  assert.equal(registry.has('sess-B'), true)
  // 卸载实例 A（模拟 HMR 重叠）：只删 sess-A，sess-B 必须保留
  void a.ctx.fiber.dispose()
  await flush()
  assert.equal(registry.has('sess-A'), false, 'A cleans its own key')
  assert.equal(registry.has('sess-B'), true, 'B key untouched by A dispose')
  void b.ctx.fiber.dispose()
  await flush()
  assert.equal(registry.has('sess-B'), false)
})

// ── 验收问题修复回归（MG-50 系列） ─────────────────────────────────────
// 1) 会话启动在项目目录创建专属 workspace，本会话产出的 pane 都归于此；
// 2) 重复创建多个 pane → 防重入 + 标记 pane 复用；
// 3) 面板查不到本会话 pane → agent/request 兜底 bind（preset 切换不重建 agent）。

test('fix: no session cwd → workspace falls back to config/default (no cwd field)', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.wsCreates[0].label, 'dsh:sess-A', 'fallback label when no cwd')
  assert.equal(calls.wsCreates[0].cwd, undefined, 'no cwd when session has none')
  void ctx.fiber.dispose()
})

test('fix: concurrent agent/created for the same agent creates only one workspace', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.wsCreates.length, 1, 'in-flight bind guard prevents duplicate workspaces')
  assert.equal(calls.reports.length, 1, 'single idle report')
  void ctx.fiber.dispose()
})

test('fix: reuses pane already marked with dsh_session token (registry lost after restart)', async () => {
  const { ctx, calls } = makeHarness([{ pane_id: 'w9:p2', workspace_id: 'w9', tokens: { dsh_session: 'sess-A' } }])
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.wsCreates.length, 0, 'no new workspace when marked pane exists')
  assert.equal(calls.renames.length, 0, 'no re-mark needed for existing pane')
  assert.equal(calls.reports.length, 1)
  assert.equal(calls.reports[0].pane_id, 'w9:p2')
  // 复用的专属 workspace 随会话关闭
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-A' } })
  await flush()
  assert.deepEqual(calls.wsCloses, ['w9'], 'reused dedicated workspace closed on dispose')
  void ctx.fiber.dispose()
})

test('fix: agent/request fallback binds when agent/created never fired (preset switch)', async () => {
  const { ctx, calls } = makeHarness()
  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  assert.equal(resolved, 'cfg', 'waterfall chain unaffected by fallback bind')
  await flush()
  assert.equal(calls.wsCreates.length, 1, 'fallback bind creates workspace on first request')
  assert.deepEqual(calls.renames[0], { pane_id: 'wN1:p1', label: 'dsh:sess-A' })
  // 兜底路径不主动 report idle（状态由 request working 驱动）
  assert.deepEqual(calls.reports.map(r => r.state), ['working'])
  void ctx.fiber.dispose()
})

test('fix: request fallback is idempotent for an already-bound agent', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  const before = calls.wsCreates.length
  await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  await flush()
  assert.equal(calls.wsCreates.length, before, 'no second bind for already-bound agent')
  void ctx.fiber.dispose()
})

test('fix: request fallback passes session cwd to workspace create', async () => {
  const { ctx, calls } = makeHarness()
  await ctx.waterfall({} as any, 'agent/request', {
    agent: { id: 'sess-A', session: { header: { cwd: '/proj' } } },
  }, () => 'cfg')
  await flush()
  assert.deepEqual(calls.wsCreates[0], { label: 'dsh:proj-sess-A', cwd: '/proj' })
  void ctx.fiber.dispose()
})