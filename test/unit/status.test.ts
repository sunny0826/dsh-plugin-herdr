import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePaneId, probeCli, probeServer, startHerdrServer, type ExecFileFn, type HerdrServerInfo, type ServerProbeFn, type SpawnFn } from '../../src/status.ts'

test('comparePaneId: natural order (p2 < p10)', () => {
  const ids = ['w8:p10', 'w8:p2', 'w8:p1', 'w9:p1', 'w8:p11']
  ids.sort(comparePaneId)
  assert.deepEqual(ids, ['w8:p1', 'w8:p2', 'w8:p10', 'w8:p11', 'w9:p1'])
})

test('comparePaneId: same pane equals', () => {
  assert.equal(comparePaneId('w8:p1', 'w8:p1'), 0)
})

test('probeCli: installed binary reports available with version', async () => {
  const info = await probeCli('herdr')
  assert.equal(info.available, true)
  assert.match(info.version ?? '', /\d+\.\d+\.\d+/, 'version should contain 0.8.0')
})

test('probeCli: missing binary reports unavailable', async () => {
  const info = await probeCli('/nonexistent/herdr-bin-xyz')
  assert.equal(info.available, false)
  assert.equal(info.path, '/nonexistent/herdr-bin-xyz')
})

// ---------------------------------------------------------------------------
// probeServer / startHerdrServer（M7 启动看板）
// ---------------------------------------------------------------------------

const RUNNING_JSON = JSON.stringify({
  status: 'running', running: true, version: '0.8.0', protocol: 19,
  socket: '/x/herdr.sock', session: 'work', restart_needed: false,
})
const STOPPED_JSON = JSON.stringify({
  status: 'not_running', running: false, version: null, protocol: null,
  socket: '/x/herdr.sock', session: null, restart_needed: false,
})

function fakeExec(out: string): ExecFileFn {
  return (_cmd, _args, _opts, cb) => cb(null, out)
}

test('probeServer: parses running JSON', async () => {
  const info = await probeServer('herdr', fakeExec(RUNNING_JSON))
  assert.equal(info.running, true)
  assert.equal(info.status, 'running')
  assert.equal(info.version, '0.8.0')
  assert.equal(info.session, 'work')
})

test('probeServer: parses not_running JSON', async () => {
  const info = await probeServer('herdr', fakeExec(STOPPED_JSON))
  assert.equal(info.running, false)
  assert.equal(info.status, 'not_running')
})

test('probeServer: exec failure degrades to unknown', async () => {
  const info = await probeServer('herdr', (_c, _a, _o, cb) => cb(new Error('ENOENT'), ''))
  assert.equal(info.running, false)
  assert.equal(info.status, 'unknown')
})

test('probeServer: garbage stdout degrades to unknown', async () => {
  const info = await probeServer('herdr', fakeExec('not json at all'))
  assert.equal(info.running, false)
  assert.equal(info.status, 'unknown')
})

test('startHerdrServer: already running returns immediately without spawn', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'running', running: true, version: '0.8.0', protocol: 19, socket: null, session: null, checked_at: 0 })
  let spawned = false
  const spawn: SpawnFn = () => {
    spawned = true
    return { unref() {}, on() { return undefined } }
  }
  const info = await startHerdrServer('herdr', { timeoutMs: 200, spawnFn: spawn, probe })
  assert.equal(info.running, true)
  assert.equal(spawned, false, 'no spawn when already running')
})

test('startHerdrServer: spawns and polls until running', async () => {
  const events = [
    { t: 1, running: false, status: 'not_running' },
    { t: 2, running: false, status: 'not_running' },
    { t: 3, running: true, status: 'running' },
  ]
  let spawned = 0
  const probe: ServerProbeFn = async () => {
    if (events.length === 0) return { status: 'running', running: true, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
    const ev = events.shift()!
    return { status: ev.status, running: ev.running, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
  }
  const spawn: SpawnFn = () => {
    spawned += 1
    return { unref() {}, on() { return undefined } }
  }
  const info = await startHerdrServer('herdr', { timeoutMs: 5000, spawnFn: spawn, probe })
  assert.equal(info.running, true)
  assert.equal(spawned, 1, 'spawned exactly once')
})

test('startHerdrServer: spawn error rejects', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'not_running', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 })
  const spawn: SpawnFn = () => {
    return {
      unref() {},
      on(_event, listener) {
        const l = listener as (err: Error) => void
        setImmediate(() => l(new Error('ENOENT')))
        return undefined
      },
    }
  }
  await assert.rejects(
    startHerdrServer('herdr', { timeoutMs: 5000, spawnFn: spawn, probe }),
    /spawn failed/,
  )
})

test('startHerdrServer: timeout returns last probe (not running)', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'not_running', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 })
  const spawn: SpawnFn = () => ({ unref() {}, on() { return undefined } })
  const started = Date.now()
  const info = await startHerdrServer('herdr', { timeoutMs: 60, spawnFn: spawn, probe })
  assert.equal(info.running, false)
  assert.ok(Date.now() - started >= 490, 'at least one poll interval elapsed (clock-jitter tolerant)')
})

// ---------------------------------------------------------------------------
// CA-012：tracker 轮询纪律（首次立即 tick / 单飞 / stop 取消 / stale 诊断）
// ---------------------------------------------------------------------------

import { Context } from '@deepseek-ai/cordis'
import { HerdrStatusTracker } from '../../src/status.ts'
import type { HerdrClient } from '../../src/client/index.ts'

const EMPTY_SNAP = {
  version: '0.8.0', protocol: 19,
  workspaces: [], tabs: [], panes: [], layouts: [], agents: [],
  focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null,
}

function makeTrackerClient(opts: { snapshotDelayMs?: number; snapshotError?: boolean } = {}) {
  const calls = { snapshot: 0, listAgents: 0, paneRead: 0 }
  const state = { snapshotError: opts.snapshotError === true }
  const client = {
    snapshot: async () => {
      calls.snapshot++
      if (opts.snapshotDelayMs) await new Promise(r => setTimeout(r, opts.snapshotDelayMs))
      if (state.snapshotError) throw new Error('boom')
      return EMPTY_SNAP
    },
    listAgents: async () => { calls.listAgents++; return [] },
    paneRead: async () => { calls.paneRead++; return { text: '', truncated: false } },
  } as unknown as HerdrClient
  return { client, calls, setSnapshotError: (v: boolean) => { state.snapshotError = v } }
}

const makeTracker = (client: HerdrClient, opts: { pollIntervalMs?: number; staleThresholdMs?: number; probeServerFn?: ServerProbeFn } = {}) =>
  new HerdrStatusTracker(new Context(), client, 'herdr', opts)

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

test('CA-012: first tick is immediate (poll happens before the first interval)', async () => {
  const { client, calls } = makeTrackerClient()
  const tracker = makeTracker(client, { pollIntervalMs: 60_000 })
  tracker.start()
  await sleepMs(100)
  tracker.stop()
  assert.ok(calls.snapshot >= 1, 'snapshot polled immediately without waiting 60s interval')
  assert.ok(calls.listAgents >= 1, 'agent polled immediately')
})

test('CA-012: single-flight guard skips overlapping cycles (bounded concurrency)', async () => {
  const { client, calls } = makeTrackerClient({ snapshotDelayMs: 300 })
  const tracker = makeTracker(client, { pollIntervalMs: 50 })
  tracker.start()
  await sleepMs(600)
  tracker.stop()
  // 无 guard：12 个 tick × 并发调用；单飞后每次周期 ~300ms → 约 2 次
  assert.ok(calls.snapshot >= 1, 'at least one cycle ran')
  assert.ok(calls.snapshot <= 3, `expected bounded cycles, got ${calls.snapshot}`)
})

test('CA-012: stop cancels in-flight cycle (no further calls, no state mutation)', async () => {
  const { client, calls } = makeTrackerClient({ snapshotDelayMs: 200 })
  const tracker = makeTracker(client, { pollIntervalMs: 50 })
  tracker.start()
  await sleepMs(80) // 首个周期在途（snapshot 200ms）
  tracker.stop()
  const atStop = { ...calls }
  await sleepMs(400)
  tracker.stop() // 幂等
  assert.deepEqual(calls, atStop, 'no client calls after stop (in-flight aborted)')
  assert.equal(tracker.snapshot().stale, true, 'never completed a clean cycle → stale')
})

test('CA-012: snapshot exposes last_error and stale diagnostics', async () => {
  const { client } = makeTrackerClient({ snapshotError: true })
  const tracker = makeTracker(client, { pollIntervalMs: 60_000, staleThresholdMs: 5000 })
  tracker.start()
  await sleepMs(150)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.match(snap.last_error ?? '', /topology poll failed: boom/)
  assert.equal(snap.stale, true, 'topology failed → last success never advanced → stale')
})

test('CA-012: healthy cycles report not stale', async () => {
  const { client } = makeTrackerClient()
  const tracker = makeTracker(client, { pollIntervalMs: 60_000, staleThresholdMs: 5000 })
  tracker.start()
  await sleepMs(150)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.equal(snap.last_error, null, 'no errors on healthy polls')
  assert.equal(snap.stale, false, 'clean cycle completed → not stale')
})

// codex review P2：失败后成功周期必须清空 last_error
test('CR: a successful cycle clears last_error from a previous failure', async () => {
  const { client, setSnapshotError } = makeTrackerClient({ snapshotError: true })
  const probe: ServerProbeFn = async () => ({ status: 'running', running: true, version: '0.8.0', protocol: 19, socket: null, session: null, checked_at: 0 })
  const tracker = makeTracker(client, { pollIntervalMs: 60_000, staleThresholdMs: 5000, probeServerFn: probe })
  tracker.start()
  await sleepMs(150)
  assert.match(tracker.snapshot().last_error ?? '', /topology poll failed/, 'failure recorded on first cycle')
  // 恢复：快照不再抛错，下一轮为干净周期
  setSnapshotError(false)
  tracker.stop()
  tracker.start() // 重启立即触发一轮成功周期
  await sleepMs(150)
  tracker.stop()
  assert.equal(tracker.snapshot().last_error, null, 'successful cycle must clear the old error')
  assert.equal(tracker.snapshot().stale, false, 'recovered → not stale')
})
