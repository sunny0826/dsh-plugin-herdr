// M2 扩展集成测试：真实 herdr + 扩展工具 + socket 传输
// 运行：node test/integration/extended.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../lib/index.mjs'
import { apply as applyClient } from '../../lib/client-entry.mjs'
import { assertPreflight, ensureWorkspace } from './preflight.mjs'

// CA-009：前置条件（herdr CLI + lib 构建 + server running）；不满足 → 明确 SKIP
assertPreflight()

// CA-009：不硬编码用户路径（原为 /Users/san3an）
const HOME = homedir()

const BASE_CONFIG = {
  cliPath: 'herdr',
  transport: 'cli',
  timeoutMs: 15000,
  allowBackground: false,
  events: { enabled: false, maxReconnectMs: 30000 },
  reportState: true,
}

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log('✔', name)
  } catch (err) {
    failures++
    console.error('✖', name, '-', err.message)
  }
}

const createdPanes = new Set()
const closePane = (id) => {
  try { execFileSync('herdr', ['pane', 'close', id], { encoding: 'utf8' }) } catch { /* ignore */ }
}

// ---- CLI 传输：扩展工具 ----
{
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('jobs', { start: () => 'herdr-1' })
  const cf = await ctx.plugin({ name: 'c', apply: applyClient, inject: [] }, BASE_CONFIG)
  const f = await ctx.plugin({ name: 'h', apply, inject: ['tools', 'herdr', 'jobs'] }, BASE_CONFIG)

  // 全新 server 没有默认 workspace（CI runner 场景）：先确保存在，
  // 否则下方 snapshot.panes 为空（首个 workspace create 检查会创建后立即关闭）
  let closeWorkspace = () => {}
  closeWorkspace = await ensureWorkspace(ctx.herdr)

  await check('workspace create', async () => {
    const r = await ctx.herdr.workspaceCreate({ label: 'dsh-m2-ext', cwd: HOME })
    assert.ok(r.workspace_id.startsWith('w'), r.workspace_id)
    try { execFileSync('herdr', ['workspace', 'close', r.workspace_id], { encoding: 'utf8' }) } catch { /* ignore */ }
  })

  await check('pane split', async () => {
    const snap = await ctx.herdr.snapshot()
    const first = snap.panes[0]
    assert.ok(first, 'need at least one pane')
    const r = await ctx.herdr.paneSplit({ pane_id: first.pane_id, direction: 'right', ratio: 0.5 })
    assert.ok(r.pane_id.startsWith('w'), r.pane_id)
    createdPanes.add(r.pane_id)
  })

  await check('pane send keys + read', async () => {
    // 不 split 焦点 pane（本机焦点是忙碌的 agent pane，其终端不响应键盘输入）；
    // 显式 split 一个无 agent 的普通 shell pane。
    const snap = await ctx.herdr.snapshot()
    const plain = snap.panes.find(p => !p.agent_status) ?? snap.panes[0]
    assert.ok(plain?.pane_id, 'need a plain pane to split')
    const { pane_id } = await ctx.herdr.paneSplit({ pane_id: plain.pane_id, direction: 'right', ratio: 0.5 })
    createdPanes.add(pane_id)
    // 本机实测：send-keys 每批首个键会丢失（zzz→zz）；前置一个可牺牲键，
    // 无论它是否丢失，回显都包含完整的 keyprobe。
    await new Promise(res => setTimeout(res, 1000))
    const keys = ['x', ...'keyprobe'].map(ch => ch)
    keys.push('enter')
    await ctx.herdr.paneSendKeys({ pane_id, keys })
    await new Promise(res => setTimeout(res, 800))
    const { text } = await ctx.herdr.paneRead({ pane_id, source: 'visible', lines: 60 })
    const flat = text.replace(/\n/g, '')
    assert.ok(flat.includes('keyprobe'), 'read should contain echoed keys: ' + flat.slice(-120))
  })

  await check('pane layout', async () => {
    const snap = await ctx.herdr.snapshot()
    const layout = await ctx.herdr.paneLayout({ pane_id: snap.panes[0].pane_id })
    assert.ok(layout && typeof layout === 'object', 'layout should be an object')
  })

  await check('agent explain', async () => {
    const snap = await ctx.herdr.snapshot()
    const target = snap.panes[0]?.pane_id
    assert.ok(target, 'need a pane to explain')
    const r = await ctx.herdr.agentExplain({ target })
    assert.ok(r && typeof r === 'object')
  })

  await check('notification show', async () => {
    await ctx.herdr.showNotification({ title: 'dsh-plugin-herdr test', body: 'integration check' })
  })

  for (const id of createdPanes) closePane(id)
  closeWorkspace()
  await f.dispose()
  await cf.dispose()
}

// ---- socket 传输：真实 socket ----
{
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('jobs', { start: () => 'herdr-1' })
  const config = { ...BASE_CONFIG, transport: 'socket' }
  let cf, f
  let socketPaneId = null
  try {
    cf = await ctx.plugin({ name: 'c', apply: applyClient, inject: [] }, config)
    f = await ctx.plugin({ name: 'h', apply, inject: ['tools', 'herdr', 'jobs'] }, config)
  } catch (err) {
    check('socket transport loads', () => { throw err })
    process.exit(failures === 0 ? 0 : 1)
  }

  // 全新 server 没有默认 workspace（CI runner 场景）：先确保存在，split 才有目标
  let closeWorkspace = () => {}
  closeWorkspace = await ensureWorkspace(ctx.herdr)

  await check('socket transport loads and snapshots', async () => {
    const snap = await ctx.herdr.snapshot()
    assert.ok(Array.isArray(snap.workspaces))
    assert.equal(snap.protocol, 19)
  })

  await check('socket agent list', async () => {
    const agents = await ctx.herdr.listAgents()
    assert.ok(Array.isArray(agents))
  })

  try {
    await check('socket pane split + run via send_text', async () => {
      const { pane_id } = await ctx.herdr.paneSplit({ direction: 'right', ratio: 0.5 })
      socketPaneId = pane_id
      const res = await ctx.herdr.runCommand({ command: 'echo socket-probe', pane_id, wait_ms: 8000 }, new AbortController().signal)
      assert.equal(res.kind, 'completed')
      if (res.kind === 'completed') {
        const flat = res.output.replace(/\n/g, '')
        assert.ok(flat.includes('socket-probe'), 'send_text should execute: ' + flat.slice(-120))
      }
    })
  } finally {
    // CA-009：清理本块创建的资源（原实现遗留 split pane）
    if (socketPaneId) {
      try { execFileSync('herdr', ['pane', 'close', socketPaneId], { encoding: 'utf8' }) } catch { /* ignore */ }
    }
  }

  closeWorkspace()
  await f.dispose()
  await cf.dispose()
}

console.log(failures === 0 ? 'ALL EXTENDED CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
