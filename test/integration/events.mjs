// M2 事件订阅集成测试：socket 传输 + events.enabled → split 新 pane 触发 herdr/resource-changed
// 运行：node test/integration/events.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../lib/index.mjs'
import { apply as applyClient } from '../../lib/client-entry.mjs'
import { assertPreflight, ensureWorkspace } from './preflight.mjs'

const CONFIG = {
  cliPath: 'herdr',
  transport: 'socket',
  timeoutMs: 15000,
  allowBackground: false,
  events: { enabled: true, maxReconnectMs: 3000 },
  reportState: true,
}

// CA-009：前置条件（herdr CLI + lib 构建 + server running）；不满足 → 明确 SKIP
assertPreflight()

const ctx = new Context()
ctx.provide('tools', { register: () => () => {} })
ctx.provide('jobs', { start: () => 'herdr-1' })

const resourceEvents = []
const agentEvents = []
const channelStates = []
let lastEventAt = Date.now()
ctx.on('herdr/resource-changed', e => { resourceEvents.push(e); lastEventAt = Date.now() })
ctx.on('herdr/agent-state', e => agentEvents.push(e))
ctx.on('herdr/channel', s => channelStates.push(s))

const cf = await ctx.plugin({ name: 'c', apply: applyClient, inject: [] }, CONFIG)
const f = await ctx.plugin({ name: 'h', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)

let failures = 0
// CA-009：check 必须 async 并 await fn —— 此前同步 check 吞不掉 async 回调的
// rejection（Promise 不被 catch，错误静默丢失且误报成功）。
const check = async (name, fn) => {
  try {
    await fn()
    console.log('✔', name)
  } catch (err) {
    failures++
    console.error('✖', name, '-', err.message)
  }
}

let closeWorkspace = () => {}

try {
  // 全新 server 没有默认 workspace（CI runner 场景）：先确保存在，split 才有目标 pane
  closeWorkspace = await ensureWorkspace(ctx.herdr)

  // 等待订阅建立
  await new Promise(res => setTimeout(res, 1000))
  await check('subscription channel connected', () => {
    assert.ok(channelStates.includes('connected'), 'channel should reach connected: ' + channelStates.join(','))
  })

  // CA-009/CA-011：herdr 订阅会重放会话历史事件（事件量随历史增长，可达数百条）；
  // 先等重放平静（连续 600ms 无新事件）再 split，避免与重放/重订阅竞速。
  const waitForReplayQuiet = async () => {
    while (Date.now() - lastEventAt < 600) {
      await new Promise(res => setTimeout(res, 100))
    }
  }
  await waitForReplayQuiet()

  // 触发资源变化：split 新 pane（CA-009：pane 清理放 finally，断言失败也不残留）
  let splitPaneId = null
  try {
    await check('resource-changed emitted for pane.created', async () => {
      const { pane_id } = await ctx.herdr.paneSplit({ direction: 'right', ratio: 0.4 })
      splitPaneId = pane_id
      // 轮询等待目标 pane 的 created 事件（重放平静后新事件应在毫秒级到达；留 5s 余量）
      const deadline = Date.now() + 5000
      let created = null
      while (Date.now() < deadline && !created) {
        created = resourceEvents.find(e => e.action === 'created' && e.id === pane_id)
        if (!created) await new Promise(res => setTimeout(res, 100))
      }
      assert.ok(created, 'should see pane created for ' + pane_id + ' within 5s (events seen: ' + resourceEvents.length + ')')
    })
  } finally {
    if (splitPaneId) {
      try { execFileSync('herdr', ['pane', 'close', splitPaneId], { encoding: 'utf8' }) } catch { /* ignore */ }
    }
  }

  // agent 状态事件（无 agent 时可能没有；只验证机制不报错）
  console.log('  (agent-state events observed:', agentEvents.length, ')')
} finally {
  closeWorkspace()
  await f.dispose()
  await cf.dispose()
  console.log(failures === 0 ? 'ALL EVENT CHECKS PASSED' : failures + ' CHECK(S) FAILED')
  process.exit(failures === 0 ? 0 : 1)
}
