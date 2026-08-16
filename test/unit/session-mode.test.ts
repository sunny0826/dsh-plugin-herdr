import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as sessionMode from '../../src/session-mode.ts'

// 注：测试直接调用 apply（与 state-report 测试一致）。真实 dsh 环境由 loader
// 挂载组合（standing scope），事件经 scope 载体过滤后到达监听器。

interface Call {
  pane_id?: string
  source?: string
  agent?: string
  state?: string
  message?: string
  [key: string]: unknown
}

function makeHarness(focus: string | null = 'w1:p1', wsPane: string | null = 'wN:p1') {
  const calls = {
    snapshots: 0,
    splits: [] as Call[],
    wsCreates: [] as Call[],
    reports: [] as Call[],
    clears: [] as Call[],
    closes: [] as string[],
  }
  const herdr = {
    snapshot: async () => {
      calls.snapshots += 1
      return { focused_pane_id: focus }
    },
    paneSplit: async (req: Call) => {
      const n = calls.splits.length
      calls.splits.push(req)
      return { pane_id: 'w1:p' + String(3 + n) }
    },
    workspaceCreate: async (req: Call) => {
      calls.wsCreates.push(req)
      return wsPane === null ? { workspace_id: 'wN' } : { workspace_id: 'wN', pane_id: wsPane }
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
  }
  const ctx = new Context()
  ctx.provide('herdr', herdr)
  sessionMode.apply(ctx, { paneId: '', source: 'dsh:test', label: 'dsh' })
  return { ctx, calls }
}

const flush = () => new Promise(res => setImmediate(res))

test('session-mode: agent/created binds by splitting the focused pane and reports idle', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.splits.length, 1)
  assert.deepEqual(calls.splits[0], { pane_id: 'w1:p1', direction: 'right' })
  assert.equal(calls.wsCreates.length, 0, 'no workspace create when focus exists')
  assert.equal(calls.reports.length, 1)
  assert.equal(calls.reports[0].state, 'idle')
  assert.equal(calls.reports[0].pane_id, 'w1:p3')
  assert.equal(calls.reports[0].agent, 'dsh')
  void ctx.fiber.dispose()
})

test('session-mode: request → working, turn-stopping → idle, keyed per agent', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-B' } })
  await flush()
  // 每个 agent 独立 split 出 pane
  assert.equal(calls.splits.length, 2)

  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  assert.equal(resolved, 'cfg', 'waterfall chain passes through next()')
  await ctx.serial({} as any, 'agent/turn-stopping', { agent: { id: 'sess-A' } })

  // A 绑定 w1:p3（第一个 split），B 绑定 w1:p4
  const aStates = calls.reports.filter(r => r.pane_id === 'w1:p3').map(s => s.state)
  assert.deepEqual(aStates, ['idle', 'working', 'idle'], 'A: idle → working → idle')
  const bStates = calls.reports.filter(r => r.pane_id === 'w1:p4').map(s => s.state)
  assert.deepEqual(bStates, ['idle'], 'B: only its own idle — no cross-talk')
  void ctx.fiber.dispose()
})

test('session-mode: fixed paneId binds every agent to the configured pane without split', async () => {
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

test('session-mode: no focus → workspace.create root pane', async () => {
  const { ctx, calls } = makeHarness(null)
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.wsCreates.length, 1)
  assert.equal(calls.reports[0].pane_id, 'wN:p1')
  void ctx.fiber.dispose()
})

test('session-mode: bind failure degrades silently (no pane, no crash)', async () => {
  const { ctx, calls } = makeHarness(null, null)
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  assert.equal(calls.reports.length, 0, 'no report without a bound pane')
  // 事件链仍工作：request 不抛错
  const resolved = await ctx.waterfall({} as any, 'agent/request', { agent: { id: 'sess-A' } }, () => 'cfg')
  assert.equal(resolved, 'cfg')
  void ctx.fiber.dispose()
})

test('session-mode: agent/disposed closes the created pane and clears binding', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-A' } })
  await flush()
  assert.deepEqual(calls.closes, ['w1:p3'], 'created pane is closed on dispose')
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
  const calls = { closes: [] as string[], clears: [] as Call[], reports: [] as Call[] }
  const herdr = {
    snapshot: async () => { throw new Error('must not snapshot') },
    paneSplit: async () => { throw new Error('must not split') },
    workspaceCreate: async () => { throw new Error('must not create') },
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
  assert.equal(calls.clears.length, 1, 'fixed pane releases authority')
  assert.equal(calls.clears[0].pane_id, 'w5:p1')
  void ctx.fiber.dispose()
})

test('session-mode: context dispose closes created panes', async () => {
  const { ctx, calls } = makeHarness()
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-A' } })
  await flush()
  void ctx.fiber.dispose()
  await flush()
  assert.deepEqual(calls.closes, ['w1:p3'], 'created pane closed on context dispose')
  assert.equal(calls.clears.length, 0)
})

// ---------------------------------------------------------------------------
// CA-013：bind/dispose 竞态 + registry key 归属
// ---------------------------------------------------------------------------

import { getBindingRegistry } from '../../src/binding-registry.ts'

function makeSlowHarness(snapshotDelayMs = 80) {
  const calls = { splits: [] as Call[], wsCreates: [] as Call[], closes: [] as string[], reports: [] as Call[] }
  const herdr = {
    snapshot: async () => {
      await new Promise(r => setTimeout(r, snapshotDelayMs))
      return { focused_pane_id: 'w1:p1' }
    },
    paneSplit: async (req: Call) => { calls.splits.push(req); return { pane_id: 'w1:p9' } },
    workspaceCreate: async () => { calls.wsCreates.push({}); return { workspace_id: 'wN', pane_id: 'wN:p1' } },
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
  // split 创建了 pane，但立即被回收：不遗留 registry/绑定，不上报 idle
  assert.equal(calls.splits.length, 1, 'bind still ran to create the pane')
  assert.deepEqual(calls.closes, ['w1:p9'], 'pane created mid-race must be closed')
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
  assert.deepEqual(calls.closes, ['w1:p3'])
  assert.equal(registry.has('sess-A'), false)
  void ctx.fiber.dispose()
})

test('CR: dispose during bind clears the disposedAgents flag — session id reuse binds fresh', async () => {
  const registry = getBindingRegistry()
  const { ctx, calls } = makeSlowHarness()
  // 第一次：bind 在途时 dispose → pane 被回收，标记必须清除
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-reuse' } })
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-reuse' } })
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(calls.closes, ['w1:p9'], 'mid-race pane closed')
  assert.equal(registry.has('sess-reuse'), false)
  // 第二次：同一 session id 复用——必须正常绑定（新建 pane、不误关）
  ctx.emit({} as any, 'agent/created', { agent: { id: 'sess-reuse' } })
  await new Promise(r => setTimeout(r, 150)) // bind 是异步的（慢 snapshot 80ms）
  assert.equal(registry.has('sess-reuse'), true, 'reused session id binds again')
  assert.equal(calls.closes.length, 1, 'no spurious close for the reused binding')
  assert.equal(calls.splits.length, 2, 'second bind splits a fresh pane')
  // 正常 dispose 第二次绑定
  ctx.emit({} as any, 'agent/disposed', { agent: { id: 'sess-reuse' } })
  await flush()
  assert.deepEqual(calls.closes, ['w1:p9', 'w1:p9'], 'second binding closed on dispose')
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