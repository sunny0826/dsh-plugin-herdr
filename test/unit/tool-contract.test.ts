// CA-003：工具输出契约测试 —— 每个工具的 execute 返回值必须通过其声明的 output.schema。
// 覆盖 18 个工具（含 layout_apply）的 completed/background 分支，
// 以及 herdr 抛错时 execute 的 error 路径（toToolError 归一化）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { HerdrError } from '../../src/client/error.ts'
import { registerSnapshot } from '../../src/tools/snapshot.ts'
import { registerAgentList } from '../../src/tools/agent-list.ts'
import { registerPaneRun } from '../../src/tools/pane-run.ts'
import { registerAgentWait } from '../../src/tools/agent-wait.ts'
import { registerWorkspaceCreate } from '../../src/tools/workspace-create.ts'
import { registerPaneSplit } from '../../src/tools/pane-split.ts'
import { registerPaneSendKeys } from '../../src/tools/pane-send-keys.ts'
import { registerPaneRead } from '../../src/tools/pane-read.ts'
import { registerPaneLayout } from '../../src/tools/pane-layout.ts'
import { registerLayoutApply } from '../../src/tools/layout-apply.ts'
import { registerAgentPrompt } from '../../src/tools/agent-prompt.ts'
import { registerAgentExplain } from '../../src/tools/agent-explain.ts'
import { registerAgentSendKeys } from '../../src/tools/agent-send-keys.ts'
import { registerNotification } from '../../src/tools/notification.ts'
import { registerWorkspaceClose } from '../../src/tools/workspace-close.ts'
import { registerPaneClose } from '../../src/tools/pane-close.ts'
import { registerWorkspaceRename } from '../../src/tools/workspace-rename.ts'
import { registerPaneRename } from '../../src/tools/pane-rename.ts'

/** 基于 env-findings / socket 单测的 herdr 服务 fixture（socket 传输形状）。 */
function makeHerdr() {
  return {
    snapshot: async () => ({
      version: '0.8.0',
      protocol: 19,
      workspaces: [{ workspace_id: 'w1', label: 'demo', pane_count: 1 }],
      agents: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', status: 'done', message: 'ok' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }],
      tabs: [],
      layouts: [],
      focused_pane_id: 'w1:p1',
      focused_tab_id: null,
      focused_workspace_id: 'w1',
    }),
    listAgents: async () => [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', status: 'done', message: 'ok', tab_id: 't1' },
    ],
    waitAgent: async () => ({ kind: 'completed', status: 'done', agent: 'claude', message: 'ok', waited_ms: 100 }),
    agentPrompt: async () => ({ submitted: true, status: 'idle', waited_ms: 100 }),
    runCommand: async () => ({
      kind: 'completed',
      pane_id: 'w1:p1',
      exit_code: 0,
      output: 'hello\n',
      truncated: false,
      timed_out: false,
    }),
    paneSplit: async () => ({ pane_id: 'w1:p2' }),
    paneSendKeys: async () => undefined,
    paneRead: async () => ({ text: 'hello', truncated: false }),
    paneLayout: async () => ({ type: 'layout', root: { type: 'pane' } }),
    layoutApply: async () => ({ applied: true }),
    showNotification: async () => undefined,
    agentSendKeys: async () => undefined,
    agentExplain: async () => ({ reason: 'detected via pane activity', agent: 'claude' }),
    workspaceCreate: async () => ({ workspace_id: 'w1', pane_id: 'w1:p1' }),
    workspaceClose: async (_id: string) => undefined,
    paneClose: async (_id: string) => undefined,
    workspaceRename: async (_id: string, _label: string) => undefined,
    paneRename: async (_id: string, _label: string | null) => undefined,
  }
}

interface RegisteredTool {
  name: string
  def: ToolDefinition
  args: Record<string, unknown>
}

function registerAll(opts: { allowBackground?: boolean; herdr?: ReturnType<typeof makeHerdr> } = {}): RegisteredTool[] {
  const defs: ToolDefinition[] = []
  const ctx = {
    tools: { register: (def: ToolDefinition) => { defs.push(def); return () => {} } },
    jobs: { start: () => 'herdr-1' },
    herdr: opts.herdr ?? makeHerdr(),
  } as unknown as Context
  const bg = opts.allowBackground ?? false
  registerSnapshot(ctx)
  registerAgentList(ctx)
  registerPaneRun(ctx, { allowBackground: bg })
  registerAgentWait(ctx, { allowBackground: bg })
  registerWorkspaceCreate(ctx)
  registerPaneSplit(ctx)
  registerPaneSendKeys(ctx)
  registerPaneRead(ctx)
  registerPaneLayout(ctx)
  registerLayoutApply(ctx) // socket-only 工具也纳入契约（execute 直接可测）
  registerAgentPrompt(ctx)
  registerAgentExplain(ctx)
  registerAgentSendKeys(ctx)
  registerNotification(ctx)
  registerWorkspaceClose(ctx)
  registerPaneClose(ctx)
  registerWorkspaceRename(ctx)
  registerPaneRename(ctx)
  assert.equal(defs.length, 18, 'all 18 tools registered')
  return defs.map(def => ({
    name: def.name,
    def,
    args: (CONTRACT_CASES[def.name] ?? {}) as Record<string, unknown>,
  }))
}

const exec = { signal: new AbortController().signal, agent: 'tester' } as unknown as ToolRunContext

/** 每个工具的成功路径参数（与 herdr fixture 匹配）。 */
const CONTRACT_CASES: Record<string, Record<string, unknown>> = {
  herdr_snapshot: {},
  herdr_agent_list: { status: 'done' },
  herdr_agent_wait: { target: 'w1:p1', until: ['done'], timeout_ms: 1000 },
  herdr_agent_prompt: { target: 'w1:p1', text: 'say hi', wait: true, until: ['idle'], timeout_ms: 1000 },
  herdr_pane_run: { command: 'echo hi', pane_id: 'w1:p1', wait_ms: 1000 },
  herdr_pane_split: { direction: 'right', ratio: 0.5 },
  herdr_pane_send_keys: { pane_id: 'w1:p1', keys: ['enter'] },
  herdr_pane_read: { pane_id: 'w1:p1', source: 'recent', lines: 50 },
  herdr_pane_layout: { pane_id: 'w1:p1' },
  herdr_layout_apply: { root: { type: 'pane' }, workspace_id: 'w1', tab_label: 'demo' },
  herdr_notification: { title: 'hi', body: 'body', position: 'top-right' },
  herdr_agent_send_keys: { target: 'w1:p1', keys: ['ctrl+c'] },
  herdr_agent_explain: { target: 'w1:p1' },
  herdr_workspace_create: { label: 'demo', cwd: '/tmp' },
  herdr_workspace_close: { workspace_id: 'w1' },
  herdr_pane_close: { pane_id: 'w1:p1' },
  herdr_workspace_rename: { workspace_id: 'w1', label: 'renamed' },
  herdr_pane_rename: { pane_id: 'w1:p1', label: 'my pane' },
}

test('CA-003: all 18 tools\' completed outputs validate against their declared schema', async () => {
  const tools = registerAll()
  for (const { name, def, args } of tools) {
    const value = await def.execute(args, exec)
    const violations = validateJsonSchemaValue(def.output.schema, value)
    assert.deepEqual(violations, [], `${name} output should satisfy its declared schema`)
  }
})

test('CA-003: workspace_create schema accepts the real { workspace_id, pane_id } shape', async () => {
  const tools = registerAll()
  const ws = tools.find(t => t.name === 'herdr_workspace_create')!
  // CLI 实测 workspaceCreate 返回 root_pane.pane_id（CA-003 漂移点）
  const value = await ws.def.execute({ label: 'demo' }, exec)
  assert.deepEqual(value, { workspace_id: 'w1', pane_id: 'w1:p1' })
  assert.deepEqual(validateJsonSchemaValue(ws.def.output.schema, value), [])
  // pane_id 缺失（无 root pane 时）也必须通过
  assert.deepEqual(validateJsonSchemaValue(ws.def.output.schema, { workspace_id: 'w1' }), [])
})

test('CA-003: background branches (pane_run / agent_wait) validate against schema', async () => {
  const tools = registerAll({ allowBackground: true })
  const run = tools.find(t => t.name === 'herdr_pane_run')!
  const runBg = await run.def.execute({ command: 'sleep 5', run_in_background: true }, exec)
  assert.deepEqual(runBg, { kind: 'background', jobId: 'herdr-1' })
  assert.deepEqual(validateJsonSchemaValue(run.def.output.schema, runBg), [])

  const wait = tools.find(t => t.name === 'herdr_agent_wait')!
  const waitBg = await wait.def.execute({ target: 'w1:p1', until: ['done'], run_in_background: true }, exec)
  assert.deepEqual(waitBg, { kind: 'background', jobId: 'herdr-1' })
  assert.deepEqual(validateJsonSchemaValue(wait.def.output.schema, waitBg), [])
})

test('CA-003: herdr errors surface as normalized tool errors (isError path)', async () => {
  const failingHerdr = makeHerdr()
  for (const key of Object.keys(failingHerdr) as Array<keyof ReturnType<typeof makeHerdr>>) {
    ;(failingHerdr[key] as () => Promise<unknown>) = async () => {
      throw new HerdrError('HERDR_UNAVAILABLE', 'herdr server not running')
    }
  }
  const tools = registerAll({ herdr: failingHerdr })
  for (const { name, def, args } of tools) {
    await assert.rejects(
      () => def.execute(args, exec),
      (err: Error) => {
        // toToolError：HerdrError → 带 code 前缀的普通 Error
        assert.ok(err instanceof Error)
        assert.match(err.message, /HERDR_UNAVAILABLE/)
        return true
      },
      `${name} should surface herdr failures as tool errors`,
    )
  }
})

test('CA-003: arg validation rejects invalid input before reaching herdr', async () => {
  const tools = registerAll()
  const run = tools.find(t => t.name === 'herdr_pane_run')!
  await assert.rejects(() => run.def.execute({ command: '   ' }, exec), /command must be a non-empty string/)
  const send = tools.find(t => t.name === 'herdr_pane_send_keys')!
  await assert.rejects(() => send.def.execute({ pane_id: 'w1:p1', keys: [] }, exec), /keys must be a non-empty array/)
})

test('CA-003: workspace_close returns closed_panes from snapshot count', async () => {
  const herdr = makeHerdr()
  let closedWs: string | null = null
  herdr.workspaceClose = async (id: string) => { closedWs = id }
  const tools = registerAll({ herdr })
  const ws = tools.find(t => t.name === 'herdr_workspace_close')!
  const value = await ws.def.execute({ workspace_id: 'w1' }, exec)
  // fixture snapshot 里 w1 有 1 个 pane
  assert.deepEqual(value, { ok: true, closed_panes: 1 })
  assert.equal(closedWs, 'w1')
})

test('CA-003: workspace_close falls back to closed_panes=0 when snapshot fails', async () => {
  const herdr = makeHerdr()
  herdr.snapshot = async () => { throw new HerdrError('HERDR_UNAVAILABLE', 'down') }
  const tools = registerAll({ herdr })
  const ws = tools.find(t => t.name === 'herdr_workspace_close')!
  // 快照失败不阻塞关闭，仍返回 ok:true + closed_panes:0
  const value = await ws.def.execute({ workspace_id: 'w1' }, exec)
  assert.deepEqual(value, { ok: true, closed_panes: 0 })
})

test('CA-003: pane_rename null/empty label calls paneRename clear path', async () => {
  const herdr = makeHerdr()
  let cleared: { pane: string; label: string | null } | null = null
  herdr.paneRename = async (pane: string, label: string | null) => { cleared = { pane, label } }
  const tools = registerAll({ herdr })
  const pr = tools.find(t => t.name === 'herdr_pane_rename')!
  await pr.def.execute({ pane_id: 'w1:p1', label: null }, exec)
  assert.deepEqual(cleared, { pane: 'w1:p1', label: null })
  await pr.def.execute({ pane_id: 'w1:p1', label: '' }, exec)
  // 空 label 归一为 null（走 --clear）
  assert.deepEqual(cleared, { pane: 'w1:p1', label: null })
})

test('CA-003: rename label length validation rejects >64 characters', async () => {
  const tools = registerAll()
  const wr = tools.find(t => t.name === 'herdr_workspace_rename')!
  await assert.rejects(() => wr.def.execute({ workspace_id: 'w1', label: 'x'.repeat(65) }, exec), /label must be at most 64 characters/)
  const pr = tools.find(t => t.name === 'herdr_pane_rename')!
  await assert.rejects(() => pr.def.execute({ pane_id: 'w1:p1', label: 'y'.repeat(65) }, exec), /label must be at most 64 characters/)
  // 64 恰好通过
  await wr.def.execute({ workspace_id: 'w1', label: 'x'.repeat(64) }, exec)
})
