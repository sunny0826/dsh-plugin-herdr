import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  displayLabel,
  projectName,
  SESSION_TOKEN_KEY,
  sessionIdFromTokens,
  sessionShortId,
  sessionToken,
} from '../../src/binding-registry.ts'

// MG-55：workspace/pane 命名规范（显示名 = dsh:<项目名>；内部标记 = tokens.dsh_session）

test('MG-55: displayLabel uses project basename with dsh: prefix', () => {
  assert.equal(displayLabel('/Users/san3an/Documents/test', 'session-abc1234567890'), 'dsh:test')
  assert.equal(displayLabel('/proj/dsh-plugin/', 'session-x'), 'dsh:dsh-plugin')
  assert.equal(displayLabel('/x', 'session-abc1234567890'), 'dsh:x')
})

test('MG-55: displayLabel falls back to short session id without cwd', () => {
  assert.equal(displayLabel(undefined, 'session-0403d7f3e36e4819a90aa2f3fe477b04'), 'dsh:fe477b04')
  assert.equal(displayLabel('', 'session-abc1234567890'), 'dsh:34567890')
  assert.equal(displayLabel(undefined, 'short'), 'dsh:short')
})

test('MG-55: sessionShortId strips session- prefix and takes last 8 chars', () => {
  assert.equal(sessionShortId('session-0403d7f3e36e4819a90aa2f3fe477b04'), 'fe477b04')
  assert.equal(sessionShortId('session-abcdef'), 'abcdef')
  assert.equal(sessionShortId('plain'), 'plain')
})

test('MG-55: projectName extracts cwd basename', () => {
  assert.equal(projectName('/Users/san3an/Documents/dsh-plugin'), 'dsh-plugin')
  assert.equal(projectName('/proj/test/'), 'test')
  assert.equal(projectName(undefined), undefined)
  assert.equal(projectName(''), undefined)
})

test('MG-55: sessionToken / sessionIdFromTokens round-trip (key fits protocol pattern)', () => {
  const tokens = sessionToken('session-abc123')
  assert.deepEqual(tokens, { dsh_session: 'session-abc123' })
  assert.match(SESSION_TOKEN_KEY, /^[A-Za-z0-9_-]{1,32}$/, 'token key matches protocol ^[A-Za-z0-9_-]{1,32}$')
  assert.equal(sessionIdFromTokens(tokens), 'session-abc123')
  assert.equal(sessionIdFromTokens(undefined), undefined)
  assert.equal(sessionIdFromTokens({ other: 'x' }), undefined)
})