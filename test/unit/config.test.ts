import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveSocketPath, resolveSession, resolveTerminalSessionConfig, type TerminalSessionConfig } from '../../src/config.ts'

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

// T05：projectRoot（看板目录过滤）配置项
test('T05: projectRoot absent by default, configurable via config', () => {
  const value = (Config['~standard'].validate({}) as { value: { projectRoot?: string } }).value
  assert.equal(value.projectRoot, undefined, 'projectRoot 是可选配置，缺省不设值')
  const withRoot = (Config['~standard'].validate({ projectRoot: '/repo' }) as { value: { projectRoot: string } }).value
  assert.equal(withRoot.projectRoot, '/repo')
})

// ——— Pane 终端 Observer/Controller（design: pane-terminal-session-state-machine §6.2）———

const tsValidate = (input: unknown): { value: { terminalSession?: Partial<TerminalSessionConfig> }; issues?: unknown[] } =>
  Config['~standard'].validate(input) as unknown as { value: { terminalSession?: Partial<TerminalSessionConfig> }; issues?: unknown[] }

/** 校验是否失败：olen issues 非空或抛异常（部分非法值走 throw 而非 issues）。 */
const validationFails = (input: unknown): boolean => {
  try {
    return (tsValidate(input).issues?.length ?? 0) > 0
  } catch {
    return true
  }
}

test('TS-X-1: terminalSession materializes full defaults when absent', () => {
  const { value } = tsValidate({})
  const ts = value.terminalSession as TerminalSessionConfig
  // binPath 缺省为 undefined 时 schema 不含该 key（deepEqual 不含 undefined 键）
  assert.equal(ts.enabled, true)
  assert.equal(ts.maxObservers, 8)
  assert.equal(ts.maxControllers, 4)
  assert.equal(ts.maxProcesses, 32)
  assert.equal(ts.controllerIdleMs, 600_000)
  assert.equal(ts.disconnectGraceMs, 5_000)
  assert.equal(ts.maxDecodedFrameBytes, 8_388_608)
  assert.equal(ts.maxNdjsonLineBytes, 12_582_912)
  assert.equal(ts.replayBufferBytes, 8_388_608)
})

test('TS-X-1: partial terminalSession override merges over defaults', () => {
  const { value, issues } = tsValidate({ terminalSession: { maxControllers: 2, enabled: false } })
  assert.equal(issues?.length ?? 0, 0)
  assert.equal(value.terminalSession?.enabled, false)
  assert.equal(value.terminalSession?.maxControllers, 2)
  assert.equal(value.terminalSession?.maxObservers, 8)
  assert.equal(value.terminalSession?.maxProcesses, 32)
})

test('TS-X-1: bounds enforced (out-of-range fails at load)', () => {
  assert.ok(validationFails({ terminalSession: { maxObservers: 999 } }), 'maxObservers > 64 fails')
  assert.ok(validationFails({ terminalSession: { maxDecodedFrameBytes: 1 } }), 'decoded below min fails')
  assert.ok(validationFails({ terminalSession: { replayBufferBytes: Number.MAX_SAFE_INTEGER } }), 'replay overflow fails')
  // boundary-legal values pass
  assert.ok(!validationFails({ terminalSession: { maxDecodedFrameBytes: 33_554_432 } }))
  assert.ok(!validationFails({ terminalSession: { maxNdjsonLineBytes: 50_331_648 } }))
})

test('TS-X-1: resolveTerminalSessionConfig coalesces defaults + overrides', () => {
  const cfg = (ts?: Partial<TerminalSessionConfig>) => ({ terminalSession: ts })
  // absent -> full defaults
  const absent = resolveTerminalSessionConfig(cfg())
  assert.equal(absent.enabled, true)
  assert.equal(absent.maxControllers, 4)
  assert.equal(absent.replayBufferBytes, 8_388_608)
  // partial merge
  const merged = resolveTerminalSessionConfig(cfg({ enabled: false, binPath: '/x/herdr' }))
  assert.equal(merged.enabled, false)
  assert.equal(merged.binPath, '/x/herdr')
  assert.equal(merged.maxControllers, 4)
  assert.equal(merged.maxDecodedFrameBytes, 8_388_608)
  // no cross-call mutation
  const a = resolveTerminalSessionConfig(cfg({ maxControllers: 1 }))
  assert.equal(a.maxControllers, 1)
  assert.equal(resolveTerminalSessionConfig(cfg()).maxControllers, 4)
})
