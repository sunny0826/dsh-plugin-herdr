import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerWorkspaceCreate } from '../../src/tools/workspace-create.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'

// MG-54：herdr 模式一个会话一个专属 workspace——拒绝创建新 workspace

function makeHarness() {
  const defs: ToolDefinition[] = []
  const ctx = new Context()
  ctx.provide('tools', { register: (def: ToolDefinition) => { defs.push(def); return () => {} } })
  ctx.provide('herdr', { workspaceCreate: async (req: Record<string, unknown>) => req })
  registerWorkspaceCreate(ctx)
  return { ctx, defs }
}

const agentExec = { signal: new AbortController().signal, agent: { id: 'sess-A' } } as never

test('workspace-create: herdr 模式（有绑定）拒绝创建新 workspace', async () => {
  const { defs } = makeHarness()
  getBindingRegistry().set('sess-A', { pane_id: 'w1:p1', created: true, workspace_id: 'w1' })
  try {
    const run = defs.find(d => d.name === 'herdr_workspace_create')!
    await assert.rejects(() => run.execute({ label: 'x' }, agentExec), /already owns a dedicated workspace/)
  } finally {
    getBindingRegistry().delete('sess-A')
  }
})

test('workspace-create: 无绑定（非 herdr 会话）保持原行为', async () => {
  const { defs } = makeHarness()
  const run = defs.find(d => d.name === 'herdr_workspace_create')!
  const res = await run.execute({ label: 'x', cwd: '/proj' }, agentExec)
  assert.equal((res as { label: string }).label, 'x')
  assert.equal((res as { cwd: string }).cwd, '/proj')
})
