// CA-017：统一日志与高频错误限流（log.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter, errText } from '../../src/log.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('CA-017: rate limiter fires first call, throttles within window, refires after', async () => {
  const rateLimited = createRateLimiter(40)
  let calls = 0
  const fn = () => { calls++ }
  rateLimited('k', fn) // 首次触发
  rateLimited('k', fn) // 窗口内抑制
  rateLimited('k', fn)
  rateLimited('other', fn) // 不同 key 独立
  assert.equal(calls, 2, 'first + independent key')
  await sleep(60)
  rateLimited('k', fn)
  assert.equal(calls, 3, 'refires after the window')
})

test('CA-017: errText extracts stable messages', () => {
  assert.equal(errText(new Error('boom')), 'boom')
  assert.equal(errText('raw'), 'raw')
  assert.equal(errText(42), '42')
})
