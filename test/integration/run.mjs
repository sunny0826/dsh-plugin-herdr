// M1 集成测试：需要本机已启动的 herdr server（herdr status 显示 running）。
// 运行：node test/integration/run.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../lib/index.mjs'
import { apply as applyClient } from '../../lib/client-entry.mjs'
import { assertPreflight } from './preflight.mjs'

// CA-009：前置条件（herdr CLI + lib 构建 + server running）；不满足 → 明确 SKIP
assertPreflight()

const CONFIG = {
  cliPath: 'herdr',
  transport: 'cli',
  timeoutMs: 15000,
  allowBackground: false,
  events: { enabled: false, maxReconnectMs: 30000 },
  reportState: true,
}

const ctx = new Context()
ctx.provide('tools', { register: () => () => {} })
ctx.provide('jobs', { start: () => 'herdr-1' })
// 提供者先加载（ctx.herdr），消费者后加载（工具）
const clientFiber = await ctx.plugin({ name: 'dsh-plugin-herdr-client', apply: applyClient, inject: [] }, CONFIG)
const fiber = await ctx.plugin({ name: 'dsh-plugin-herdr', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)

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

// 测试创建的 pane，finally 里清理
const createdPanes = new Set()
const closePane = (id) => {
  try { execFileSync('herdr', ['pane', 'close', id], { encoding: 'utf8' }) } catch { /* ignore */ }
}

try {
  // 1) snapshot：返回非空 workspace 列表（§14.2 第 1 项）
  const snap = await ctx.herdr.snapshot()
  await check('snapshot returns workspaces', () => {
    assert.ok(Array.isArray(snap.workspaces), 'workspaces should be an array')
    assert.ok(snap.workspaces.length >= 1, `expected >=1 workspace, got ${snap.workspaces.length}`)
    assert.equal(snap.protocol, 19)
  })

  // 2) pane run：echo 输出可见（§14.2 第 2 项）
  await check('pane run echoes output', async () => {
    const res = await ctx.herdr.runCommand(
      { command: 'echo hello-herdr-integration', wait_ms: 8000 },
      new AbortController().signal,
    )
    assert.equal(res.kind, 'completed')
    if (res.kind === 'completed') {
      createdPanes.add(res.pane_id)
      // 窄 pane 中输出可能被终端折行，去掉换行后匹配
      const flat = res.output.replace(/\n/g, '')
      assert.ok(flat.includes('hello-herdr-integration'), `output missing marker: ${JSON.stringify(res.output)}`)
      assert.equal(res.timed_out, false)
    }
  })

  // 3) agent list：可解析（当前可能为空）
  await check('agent list is an array', async () => {
    const agents = await ctx.herdr.listAgents()
    assert.ok(Array.isArray(agents))
  })

  // 4) agent wait：不存在的目标 → not_found 规范值（不得抛错）
  await check('agent wait not_found', async () => {
    const target = 'w8:p-does-not-exist'
    const w = await ctx.herdr.waitAgent(
      { target, until: ['done'], timeout_ms: 2000 },
      new AbortController().signal,
    )
    assert.deepEqual(w, { kind: 'not_found', target })
  })

  // 5) pane run 复用已有 pane：不新建 split
  await check('pane run reuses existing pane', async () => {
    const first = (await ctx.herdr.snapshot()).panes[0]
    assert.ok(first?.pane_id, 'need at least one pane')
    const panesBefore = (await ctx.herdr.snapshot()).panes.length
    const reuse = await ctx.herdr.runCommand(
      { command: 'echo reuse-works', pane_id: first.pane_id, wait_ms: 8000 },
      new AbortController().signal,
    )
    const panesAfter = (await ctx.herdr.snapshot()).panes.length
    assert.equal(reuse.kind, 'completed')
    assert.equal(panesAfter, panesBefore, 'no new pane should be created')
  })
} finally {
  for (const id of createdPanes) closePane(id)
  await fiber.dispose()
  await clientFiber.dispose()
  console.log(failures === 0 ? 'ALL INTEGRATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
