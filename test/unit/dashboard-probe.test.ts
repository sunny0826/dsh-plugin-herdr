// P2-2：probeHerdrProcess 的 ps/pgrep 输出解析纯函数单测（唯一原先无直接覆盖的解析逻辑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePgrepOutput, parsePsOutput } from '../../src/dashboard.ts'

// ---------------------------------------------------------------------------
// parsePgrepOutput
// ---------------------------------------------------------------------------

test('parsePgrepOutput: single and multiple pids, whitespace tolerant', () => {
  assert.deepEqual(parsePgrepOutput('1234'), [1234])
  assert.deepEqual(parsePgrepOutput('1234\n5678\n'), [1234, 5678])
  assert.deepEqual(parsePgrepOutput('  1234   5678\n  9012  '), [1234, 5678, 9012])
})

test('parsePgrepOutput: empty / no-match output returns []', () => {
  assert.deepEqual(parsePgrepOutput(''), [])
  assert.deepEqual(parsePgrepOutput('   \n  '), [])
})

test('parsePgrepOutput: non-numeric and non-positive lines are ignored', () => {
  assert.deepEqual(parsePgrepOutput('abc\n-5\n0\n123'), [123])
  assert.deepEqual(parsePgrepOutput('1234.5'), [], '非整数 pid 忽略')
})

// ---------------------------------------------------------------------------
// parsePsOutput（ps -o 'pid=,%cpu=,rss=,lstart='）
// ---------------------------------------------------------------------------

test('parsePsOutput: parses pid/cpu/rss/lstart line', () => {
  const line = '4242  2.5  5914624 Sat Aug 16 12:34:56 2026'
  const parsed = parsePsOutput(line)
  assert.deepEqual(parsed, { ps_pid: 4242, cpu_percent: 2.5, rss: 5914624, lstart: 'Sat Aug 16 12:34:56 2026' })
})

test('parsePsOutput: integer cpu and rss', () => {
  const parsed = parsePsOutput('42  0  2048 Mon Jan  1 00:00:00 2024')
  assert.deepEqual(parsed, { ps_pid: 42, cpu_percent: 0, rss: 2048, lstart: 'Mon Jan  1 00:00:00 2024' })
})

test('parsePsOutput: unparseable / malformed lines return null', () => {
  assert.equal(parsePsOutput(''), null)
  assert.equal(parsePsOutput('not a ps line'), null)
  assert.equal(parsePsOutput('4242  2.5'), null, '缺 lstart 列')
  assert.equal(parsePsOutput('abc  2.5  100 Sat Aug 16 12:34:56 2026'), null, 'pid 非数字')
  assert.equal(parsePsOutput('4242  xyz  100 Sat Aug 16 12:34:56 2026'), null, 'cpu 非数字')
  assert.equal(parsePsOutput('4242  2.5  xyz Sat Aug 16 12:34:56 2026'), null, 'rss 非数字')
})
