// CA-011：pollPaneUntilStable 完成语义（completed / timed_out / aborted 三分）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollPaneUntilStable } from '../../src/client/poll.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('CA-011: stable output completes with status completed (not timed_out)', async () => {
  const res = await pollPaneUntilStable(
    async () => 'same output',
    'w1:p1',
    10_000,
    new AbortController().signal,
    { intervalMs: 20, quietMs: 60 },
  )
  assert.equal(res.status, 'completed')
  assert.equal(res.output, 'same output')
})

test('CA-011: deadline exceeded returns timed_out (long-running boundary)', async () => {
  // 每次读取内容都不同 → 永不稳定 → 到 waitMs 上限
  let n = 0
  const res = await pollPaneUntilStable(
    async () => 'chunk-' + n++,
    'w1:p1',
    120,
    new AbortController().signal,
    { intervalMs: 30, quietMs: 60 },
  )
  assert.equal(res.status, 'timed_out')
})

test('CA-011: abort during polling returns status aborted (never timed_out)', async () => {
  const ac = new AbortController()
  const p = pollPaneUntilStable(
    async () => 'x',
    'w1:p1',
    10_000,
    ac.signal,
    { intervalMs: 50 },
  )
  await sleep(30) // 第一轮读已发出，随后 abort
  ac.abort()
  const res = await p
  assert.equal(res.status, 'aborted')
  // 输出为中止前最后一次读到内容（非伪造的 timed_out）
  assert.equal(res.output, 'x')
})

test('CA-011: abort before any read returns aborted with empty output', async () => {
  const ac = new AbortController()
  ac.abort()
  const res = await pollPaneUntilStable(async () => 'x', 'w1:p1', 10_000, ac.signal)
  assert.equal(res.status, 'aborted')
  assert.equal(res.output, '')
})
