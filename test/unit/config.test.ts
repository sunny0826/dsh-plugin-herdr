import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveCliPath, resolveSocketPath, resolveSession } from '../../src/config.ts'

test('resolveCliPath: explicit config wins', () => {
  assert.equal(resolveCliPath({ cliPath: '/opt/herdr/bin/herdr' }, {}), '/opt/herdr/bin/herdr')
})

test('resolveCliPath: HERDR_BIN_PATH beats PATH default', () => {
  assert.equal(resolveCliPath({ cliPath: 'herdr' }, { HERDR_BIN_PATH: '/x/herdr' }), '/x/herdr')
  assert.equal(resolveCliPath({ cliPath: 'herdr' }, {}), 'herdr')
})

test('resolveSocketPath: explicit > env > default', () => {
  assert.equal(resolveSocketPath({ socketPath: '/s/custom.sock', session: undefined }, {}), '/s/custom.sock')
  assert.equal(
    resolveSocketPath({ socketPath: undefined, session: undefined }, { HERDR_SOCKET_PATH: '/e/herdr.sock' }),
    '/e/herdr.sock',
  )
})

test('resolveSocketPath: session-specific default path', () => {
  const p = resolveSocketPath({ socketPath: undefined, session: 'work' }, {})
  assert.ok(p && p.includes('sessions') && p.includes('work') && p.endsWith('herdr.sock'), String(p))
})

test('resolveSession: config > env > undefined', () => {
  assert.equal(resolveSession({ session: 'x' }, {}), 'x')
  assert.equal(resolveSession({ session: undefined }, { HERDR_SESSION: 'y' }), 'y')
  assert.equal(resolveSession({ session: undefined }, {}), undefined)
})

test('CA-014: config bounds — maxReconnectMs out of range fails at load', () => {
  // 非法值加载即失败（schema 校验）
  const tooSmall = Config['~standard'].validate({ events: { maxReconnectMs: 100 } }) as { issues: unknown[] }
  assert.ok(tooSmall.issues.length > 0, 'below min (1000) should fail')
  const tooBig = Config['~standard'].validate({ events: { maxReconnectMs: 700000 } }) as { issues: unknown[] }
  assert.ok(tooBig.issues.length > 0, 'above max (600000) should fail')
  // 合法值 + 默认值
  const ok = Config['~standard'].validate({}) as { value: { events: { maxReconnectMs: number } } }
  assert.equal(ok.value.events.maxReconnectMs, 30000)
  const edge = Config['~standard'].validate({ events: { maxReconnectMs: 600000 } }) as { value: { events: { maxReconnectMs: number } } }
  assert.equal(edge.value.events.maxReconnectMs, 600000)
})
