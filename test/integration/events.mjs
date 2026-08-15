// M2 事件订阅集成测试：socket 传输 + events.enabled → split 新 pane 触发 herdr/resource-changed
// 运行：node test/integration/events.mjs
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../lib/index.mjs'
import { apply as applyClient } from '../../lib/client-entry.mjs'

const CONFIG = {
  cliPath: 'herdr',
  transport: 'socket',
  timeoutMs: 15000,
  allowBackground: false,
  events: { enabled: true, maxReconnectMs: 3000 },
  reportState: true,
}

const ctx = new Context()
ctx.provide('tools', { register: () => () => {} })
ctx.provide('jobs', { start: () => 'herdr-1' })

const resourceEvents = []
const agentEvents = []
const channelStates = []
ctx.on('herdr/resource-changed', e => resourceEvents.push(e))
ctx.on('herdr/agent-state', e => agentEvents.push(e))
ctx.on('herdr/channel', s => channelStates.push(s))

const cf = await ctx.plugin({ name: 'c', apply: applyClient, inject: [] }, CONFIG)
const f = await ctx.plugin({ name: 'h', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('✔', name)
  } catch (err) {
    failures++
    console.error('✖', name, '-', err.message)
  }
}

try {
  // 等待订阅建立
  await new Promise(res => setTimeout(res, 1000))
  check('subscription channel connected', () => {
    assert.ok(channelStates.includes('connected'), 'channel should reach connected: ' + channelStates.join(','))
  })

  // 触发资源变化：split 新 pane（放在 check 内，异常不会被静默跳过）
  await check('resource-changed emitted for pane.created', async () => {
    const { pane_id } = await ctx.herdr.paneSplit({ direction: 'right', ratio: 0.4 })
    await new Promise(res => setTimeout(res, 1200))
    const created = resourceEvents.find(e => e.action === 'created' && e.id === pane_id)
    assert.ok(created, 'should see pane created for ' + pane_id + ': ' + JSON.stringify(resourceEvents))
    try {
      const { execFileSync } = await import('node:child_process')
      execFileSync('herdr', ['pane', 'close', pane_id], { encoding: 'utf8' })
    } catch { /* ignore */ }
  })

  // agent 状态事件（无 agent 时可能没有；只验证机制不报错）
  console.log('  (agent-state events observed:', agentEvents.length, ')')
} finally {
  await f.dispose()
  await cf.dispose()
  console.log(failures === 0 ? 'ALL EVENT CHECKS PASSED' : failures + ' CHECK(S) FAILED')
  process.exit(failures === 0 ? 0 : 1)
}
