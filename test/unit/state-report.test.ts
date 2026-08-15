import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { setupStateReporting } from '../../src/events/state-report.ts'

const ORIG_ENV = { ...process.env }

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HERDR_')) delete process.env[k]
  }
})

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HERDR_')) delete process.env[k]
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (k.startsWith('HERDR_')) process.env[k] = v
  }
})

function makeContext() {
  const reports: Array<{ state: string; message?: string }> = []
  const clears: Array<{ pane_id: string; source?: string }> = []
  const ctx = new Context()
  ctx.provide('herdr', {
    reportAgent: async (req: { state: string; message?: string }) => { reports.push(req) },
    clearAgentAuthority: async (req: { pane_id: string; source?: string }) => { clears.push(req) },
  })
  return { ctx, reports, clears }
}

test('disabled when reportState is false', () => {
  const { ctx, reports } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: false, source: 'dsh:test' })
  cleanup()
  assert.equal(reports.length, 0)
})

test('disabled outside Herdr environment (logs, no listeners)', () => {
  const { ctx, reports } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test' })
  cleanup()
  assert.equal(reports.length, 0, 'no report outside HERDR_ENV')
})

test('initial idle report on activation', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, reports, clears } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test' })
  await new Promise(res => setImmediate(res))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].state, 'idle')
  assert.ok(reports[0].message)
  cleanup()
  await new Promise(res => setImmediate(res))
  assert.equal(clears.length, 1, 'cleanup should release authority')
})

test('agent/request maps to working (waterfall next is called)', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, reports } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test' })
  await new Promise(res => setImmediate(res))
  const payload = { agent: {} as never, turn: 1, step: 2, signal: new AbortController().signal }
  let nextCalled = false
  await ctx.events.waterfall('agent/request' as never, payload, async () => { nextCalled = true; return {} })
  await new Promise(res => setImmediate(res))
  const working = reports.filter(r => r.state === 'working')
  assert.equal(working.length, 1, 'should report working once')
  assert.equal(nextCalled, true, 'waterfall next must be called')
  cleanup()
})

test('agent/turn-stopping maps to idle (PaneAgentState has no done)', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, reports } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test' })
  await new Promise(res => setImmediate(res))
  await ctx.events.serial('agent/turn-stopping' as never, { agent: {} as never, turn: 1, signal: new AbortController().signal })
  await new Promise(res => setImmediate(res))
  const idle = reports.filter(r => r.state === 'idle')
  assert.ok(idle.length >= 2, 'initial + turn-stopping reports')
  cleanup()
})
