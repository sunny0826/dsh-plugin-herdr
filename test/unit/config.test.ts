import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCliPath, resolveSocketPath, resolveSession } from '../../src/config.ts'

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
