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
  const metadata: Array<Record<string, unknown>> = []
  const clears: Array<{ pane_id: string; source?: string }> = []
  const ctx = new Context()
  ctx.provide('herdr', {
    reportAgent: async (req: { state: string; message?: string }) => { reports.push(req) },
    reportMetadata: async (req: Record<string, unknown>) => { metadata.push(req) },
    clearAgentAuthority: async (req: { pane_id: string; source?: string }) => { clears.push(req) },
  })
  return { ctx, reports, metadata, clears }
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

// ---------------------------------------------------------------------------
// CA-006：report_metadata（title/tokens/ttl）、TTL 刷新与 blocked/done 映射
// ---------------------------------------------------------------------------

test('CA-006: activation reports metadata with title, ttl_ms and model tokens', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, metadata } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:herdr-plugin', metadataTtlMs: 100 })
  await new Promise(res => setImmediate(res))
  assert.equal(metadata.length, 1, 'initial metadata report')
  assert.equal(metadata[0].title, 'dsh agent')
  assert.equal(metadata[0].ttl_ms, 100)
  assert.equal(metadata[0].source, 'dsh:herdr-plugin')
  assert.equal(metadata[0].pane_id, 'w1:p1')
  // 尚无模型名时不带 tokens
  assert.equal(metadata[0].tokens, undefined)
  cleanup()
})

test('CA-006: agent/request captures model into metadata tokens', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, metadata } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test', metadataTtlMs: 100 })
  await new Promise(res => setImmediate(res))
  const payload = {
    agent: { options: { model: 'claude-4' } } as never,
    turn: 1, step: 1, signal: new AbortController().signal,
  }
  await ctx.events.waterfall('agent/request' as never, payload, async () => ({}))
  await new Promise(res => setImmediate(res))
  const withTokens = metadata.filter(m => m.tokens !== undefined)
  assert.equal(withTokens.length, 1)
  assert.deepEqual(withTokens[0].tokens, { model: 'claude-4' })
  cleanup()
})

test('CA-006: TTL refresh re-reports metadata and cleanup stops it', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, metadata } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test', metadataTtlMs: 100 })
  await new Promise(res => setImmediate(res))
  await new Promise(res => setTimeout(res, 220)) // ttl/2=50ms 刷新周期 → 应有多次重报
  assert.ok(metadata.length >= 3, `expected periodic refresh, got ${metadata.length}`)
  const countAtCleanup = metadata.length
  cleanup()
  await new Promise(res => setTimeout(res, 150))
  assert.equal(metadata.length, countAtCleanup, 'no metadata reports after cleanup (TTL refresh stopped)')
})

test('CA-006: tools/pre-execute ask maps to blocked, allow maps back to working', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, reports } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test', metadataTtlMs: 10_000 })
  await new Promise(res => setImmediate(res))
  // ask → blocked
  const decision = await ctx.events.waterfall(
    'tools/pre-execute' as never,
    {} as never,
    async () => ({ kind: 'ask' as const, reason: 'needs approval' }),
  )
  await new Promise(res => setImmediate(res))
  const blocked = reports.filter(r => r.state === 'blocked')
  assert.equal(blocked.length, 1)
  assert.match(blocked[0].message ?? '', /approval/)
  // allow → working
  await ctx.events.waterfall('tools/pre-execute' as never, {} as never, async () => ({ kind: 'allow' as const }))
  await new Promise(res => setImmediate(res))
  const working = reports.filter(r => r.state === 'working')
  assert.ok(working.length >= 1, 'allow after ask reports working')
  assert.deepEqual(decision, { kind: 'ask', reason: 'needs approval' }, 'decision passes through unchanged')
  cleanup()
})

test('CA-006: cleanup is idempotent (single clearAgentAuthority)', async () => {
  process.env.HERDR_ENV = '1'
  process.env.HERDR_PANE_ID = 'w1:p1'
  const { ctx, clears } = makeContext()
  const cleanup = setupStateReporting(ctx, { reportState: true, source: 'dsh:test' })
  await new Promise(res => setImmediate(res))
  cleanup()
  cleanup()
  await new Promise(res => setImmediate(res))
  assert.equal(clears.length, 1, 'multiple cleanup calls must release authority exactly once')
})
