import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerPaneRun } from '../../src/tools/pane-run.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'

// MG-50 修复轮：herdr_pane_run 默认复用本会话绑定 pane；显式新建时以绑定 pane
// 为 split target（新 pane 落在本会话专属 workspace）。

interface RunCall {
  command: string
  pane_id?: string
  workspace_id?: string
  direction?: string
  [key: string]: unknown
}

function makeHarness(herdr: Record<string, unknown>) {
  const defs: ToolDefinition[] = []
  const ctx = new Context()
  ctx.provide('tools', { register: (def: ToolDefinition) => { defs.push(def); return () => {} } })
  ctx.provide('herdr', herdr)
  registerPaneRun(ctx, { allowBackground: false })
  return { ctx, defs }
}

const agentExec = { signal: new AbortController().signal, agent: { id: 'sess-A' } } as never

test('pane-run: no pane_id reuses the session bound pane (no new pane)', async () => {
  const runs: RunCall[] = []
  const { defs } = makeHarness({
    runCommand: async (req: RunCall) => {
      runs.push(req)
      return { kind: 'completed', pane_id: req.pane_id, exit_code: 0, output: 'ok', truncated: false }
    },
    paneSplit: async () => { throw new Error('paneSplit must not be called when reusing') },
  })
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p5', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_pane_run')!
    const res = await run.execute({ command: 'echo hi' }, agentExec)
    assert.equal((res as { pane_id: string }).pane_id, 'w1:p5', 'ran in the bound pane')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].pane_id, 'w1:p5')
  } finally {
    getBindingRegistry().delete('sess-A')
  }
})

test('pane-run: explicit direction splits off the bound pane (stays in session workspace)', async () => {
  const runs: RunCall[] = []
  const splits: Array<Record<string, unknown>> = []
  const { defs } = makeHarness({
    runCommand: async (req: RunCall) => {
      runs.push(req)
      return { kind: 'completed', pane_id: req.pane_id, exit_code: 0, output: 'ok', truncated: false }
    },
    paneSplit: async (req: Record<string, unknown>) => {
      splits.push(req)
      return { pane_id: 'w1:p6' }
    },
  })
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p5', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_pane_run')!
    const res = await run.execute({ command: 'echo hi', direction: 'down' }, agentExec)
    assert.equal((res as { pane_id: string }).pane_id, 'w1:p6', 'new pane created')
    assert.deepEqual(splits[0], { pane_id: 'w1:p5', direction: 'down', ratio: undefined, cwd: undefined, env: undefined, workspace_id: undefined },
      'split targets the bound pane so the new pane lands in the session workspace')
    assert.equal(runs[0].pane_id, 'w1:p6')
  } finally {
    getBindingRegistry().delete('sess-A')
  }
})

test('pane-run: no binding (non-herdr session) keeps original create-split behavior', async () => {
  const runs: RunCall[] = []
  const { defs } = makeHarness({
    runCommand: async (req: RunCall) => {
      runs.push(req)
      return { kind: 'completed', pane_id: 'wX:p1', exit_code: 0, output: 'ok', truncated: false }
    },
    paneSplit: async () => { throw new Error('socket layer splits when pane_id absent') },
  })
  const run = defs.find(d => d.name === 'herdr_pane_run')!
  const res = await run.execute({ command: 'echo hi' }, agentExec)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].pane_id, undefined, 'no bound pane → socket split (original behavior)')
  assert.equal((res as { pane_id: string }).pane_id, 'wX:p1')
})
