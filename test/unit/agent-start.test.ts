import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerAgentStart } from '../../src/tools/agent-start.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'

// MG-53：herdr_agent_start —— 开启 agent 执行任务的正确定路径（缺省在本会话
// 专属 workspace 的绑定 pane 旁 split 启动）。

function makeHarness(herdr: Record<string, unknown>, snapAgents: Array<{ agent?: string | null }> = []) {
  herdr.snapshot = herdr.snapshot ?? (async () => ({ agents: snapAgents, panes: [] }))
  const defs: ToolDefinition[] = []
  const ctx = new Context()
  ctx.provide('tools', { register: (def: ToolDefinition) => { defs.push(def); return () => {} } })
  ctx.provide('herdr', herdr)
  registerAgentStart(ctx)
  return { ctx, defs }
}

const agentExec = { signal: new AbortController().signal, agent: { id: 'sess-A' } } as never

test('agent-start: omitted pane_id splits off the bound pane (session workspace)', async () => {
  const calls: Array<Record<string, unknown>> = []
  const { defs } = makeHarness({
    paneSplit: async (req: Record<string, unknown>) => {
      assert.equal(req.pane_id, 'w1:p5', 'split targets the bound pane')
      return { pane_id: 'w1:p9' }
    },
    agentStart: async (req: Record<string, unknown>) => {
      calls.push(req)
      return { pane_id: 'w1:p9', workspace_id: 'w1', agent: 'pi', agent_status: 'idle' }
    },
  })
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p5', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_agent_start')!
    const res = await run.execute({ kind: 'pi' }, agentExec)
    assert.deepEqual(calls[0], { name: 'pi-1', kind: 'pi', pane_id: 'w1:p9', args: undefined, timeout_ms: undefined }, 'name auto-generates <kind>-<n>')
    assert.equal((res as { pane_id: string }).pane_id, 'w1:p9')
    assert.equal((res as { status: string }).status, 'idle')
  } finally {
    getBindingRegistry().delete('sess-A')
  }
})

test('agent-start: explicit pane_id starts directly without split', async () => {
  const { defs } = makeHarness({
    paneSplit: async () => { throw new Error('no split when pane_id given') },
    agentStart: async (req: Record<string, unknown>) => {
      assert.equal(req.pane_id, 'w3:p2')
      assert.equal(req.name, 'reviewer')
      return { pane_id: 'w3:p2', agent: 'codex', agent_status: 'working' }
    },
  })
  const run = defs.find(d => d.name === 'herdr_agent_start')!
  const res = await run.execute({ kind: 'codex', name: 'reviewer', pane_id: 'w3:p2' }, agentExec)
  assert.equal((res as { agent: string }).agent, 'codex')
})

test('agent-start: no bound pane and no pane_id → rejects with clear message', async () => {
  const { defs } = makeHarness({})
  const run = defs.find(d => d.name === 'herdr_agent_start')!
  await assert.rejects(() => run.execute({ kind: 'pi' }, agentExec), /no pane_id given/)
})

test('agent-start: rejects out-of-range timeout_ms', async () => {
  const { defs } = makeHarness({})
  const run = defs.find(d => d.name === 'herdr_agent_start')!
  await assert.rejects(() => run.execute({ kind: 'pi', pane_id: 'w1:p1', timeout_ms: 1000 }, agentExec), /timeout_ms must be > 3000/)
})

test('agent-start: retries agent_pane_busy until the fresh pane shell is ready', async () => {
  const { defs } = makeHarness({
    paneSplit: async () => ({ pane_id: 'w1:p9' }),
    agentStart: async (req: Record<string, unknown>) => {
      if (req.pane_id === 'w1:p9' && !(globalThis as { __piRetried?: boolean }).__piRetried) {
        ;(globalThis as { __piRetried?: boolean }).__piRetried = true
        const { HerdrError } = await import('../../src/client/error.ts')
        throw new HerdrError('HERDR_ERROR', 'agent_pane_busy: target pane not available', 'agent_pane_busy')
      }
      return { pane_id: 'w1:p9', agent: 'pi', agent_status: 'idle' }
    },
  })
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p5', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_agent_start')!
    const res = await run.execute({ kind: 'pi', timeout_ms: 10000 }, agentExec)
    assert.equal((res as { status: string }).status, 'idle', 'succeeded after busy retry')
  } finally {
    delete (globalThis as { __piRetried?: boolean }).__piRetried
    getBindingRegistry().delete('sess-A')
  }
})

test('agent-start: non-busy errors still fail immediately', async () => {
  const { defs } = makeHarness({
    paneSplit: async () => ({ pane_id: 'w1:p9' }),
    agentStart: async () => {
      const { HerdrError } = await import('../../src/client/error.ts')
      throw new HerdrError('HERDR_ERROR', 'agent_not_found: no such kind', 'agent_not_found')
    },
  })
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p5', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_agent_start')!
    await assert.rejects(() => run.execute({ kind: 'nope', timeout_ms: 5000 }, agentExec), /agent_not_found/)
  } finally {
    getBindingRegistry().delete('sess-A')
  }
})
