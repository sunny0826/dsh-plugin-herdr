// CA-004：协议生成契约 —— fixture 漂移检查可运行 + 生成幂等 + 生成范围覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GEN = join(root, 'scripts', 'gen-types.mjs')
const TYPES = join(root, 'src', 'client', 'types.ts')

function runGen(check: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [GEN, ...(check ? ['--check'] : [])],
      { cwd: root },
      (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr }),
    )
  })
}

test('CA-004: committed types.ts matches the fixture (drift check runnable)', async () => {
  // --check 退出码 0 = 无漂移；fixture 变化后未重新生成会以退出码 1 失败
  const check = await runGen(true)
  assert.equal(check.code, 0, `gen-types --check must pass (run: node scripts/gen-types.mjs): ${check.stderr}`)
})

test('CA-004: generation is idempotent (regenerating does not change the file)', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const before = readFileSync(TYPES, 'utf8')
  const gen = await runGen(false)
  assert.equal(gen.code, 0, gen.stderr)
  const after = readFileSync(TYPES, 'utf8')
  try {
    assert.equal(after, before, 'regeneration must be byte-identical (idempotent)')
  } finally {
    writeFileSync(TYPES, before) // 防测试静默改写已提交文件
  }
})

test('CA-004: generated types cover requests, results, errors and events', async () => {
  const { readFileSync } = await import('node:fs')
  const types = readFileSync(TYPES, 'utf8')
  // 请求映射
  assert.match(types, /export interface HerdrRequestMap/)
  // 响应结果分支映射（21 个方法全部有 result 类型）
  assert.match(types, /export interface HerdrResultMap/)
  assert.match(types, /'agent\.wait': AgentInfoResult/)
  assert.match(types, /'pane\.split': PaneInfoResult/)
  assert.match(types, /'workspace\.create': WorkspaceCreatedResult/)
  // 错误体
  assert.match(types, /export interface HerdrErrorBody/)
  // 事件与订阅事件
  assert.match(types, /export type HerdrEventKind = /)
  assert.match(types, /export type HerdrEventData = /)
  assert.match(types, /export interface HerdrEvent \{/)
  assert.match(types, /export type HerdrSubscriptionEventKind = /)
  assert.match(types, /export interface HerdrSubscriptionEvent \{/)
})

test('CA-004: HerdrEventData is a discriminated union on type', async () => {
  const { readFileSync } = await import('node:fs')
  const types = readFileSync(TYPES, 'utf8')
  const m = types.match(/export type HerdrEventData = ([\s\S]*?)\n\nexport interface HerdrEvent/)
  assert.ok(m, 'HerdrEventData union should exist')
  assert.match(m[1], /type: "workspace_created"/)
  assert.match(m[1], /type: "pane_agent_status_changed"/)
  assert.match(m[1], /type: "pane_exited"/)
})
