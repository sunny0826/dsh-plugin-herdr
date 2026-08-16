import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePaneId, filterTopology, probeCli, probeServer, startHerdrServer, type ExecFileFn, type HerdrServerInfo, type ServerProbeFn, type SpawnFn } from '../../src/status.ts'

test('comparePaneId: natural order (p2 < p10)', () => {
  const ids = ['w8:p10', 'w8:p2', 'w8:p1', 'w9:p1', 'w8:p11']
  ids.sort(comparePaneId)
  assert.deepEqual(ids, ['w8:p1', 'w8:p2', 'w8:p10', 'w8:p11', 'w9:p1'])
})

test('comparePaneId: same pane equals', () => {
  assert.equal(comparePaneId('w8:p1', 'w8:p1'), 0)
})

test('probeCli: installed binary reports available with version', async () => {
  // 注入 execFn，避免依赖宿主机真实 herdr（CI runner 上没有 herdr）
  const execFn: ExecFileFn = (_cmd, _args, _opts, cb) => cb(null, 'herdr 0.8.0\n')
  const info = await probeCli('herdr', execFn)
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

function makeTrackerClient(opts: { snapshotDelayMs?: number; snapshotError?: boolean; snap?: unknown } = {}) {
  const calls = { snapshot: 0, listAgents: 0, paneRead: 0 }
  const state = { snapshotError: opts.snapshotError === true }
  const client = {
    snapshot: async () => {
      calls.snapshot++
      if (opts.snapshotDelayMs) await new Promise(r => setTimeout(r, opts.snapshotDelayMs))
      if (state.snapshotError) throw new Error('boom')
      return opts.snap ?? EMPTY_SNAP
    },
    listAgents: async () => { calls.listAgents++; return [] },
    paneRead: async () => { calls.paneRead++; return { text: '', truncated: false } },
  } as unknown as HerdrClient
  return { client, calls, setSnapshotError: (v: boolean) => { state.snapshotError = v } }
}

const makeTracker = (client: HerdrClient, opts: {
  pollIntervalMs?: number
  staleThresholdMs?: number
  probeServerFn?: ServerProbeFn
  projectRoot?: string
  getBoundPaneIds?: () => string[]
} = {}) =>
  new HerdrStatusTracker(new Context(), client, 'herdr', {
    // 默认注入 mock probe，避免依赖宿主机真实 herdr（CI runner 上没有 herdr）
    probeServerFn: async (): Promise<HerdrServerInfo> => ({
      status: 'running', running: true, version: '0.8.0', protocol: 19, socket: null, session: null, checked_at: 0,
    }),
    ...opts,
  })

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

// ---------------------------------------------------------------------------
// T05：目录过滤（filterTopology 纯函数）与 snapshot scope / filter 元数据
// 注：测试路径用不存在于磁盘的 /proj/... 前缀，isPathWithinProject 的 realpath
// 失败回退原值，前缀边界比较在原始字符串上仍然成立（跨平台确定性）。
// ---------------------------------------------------------------------------

import type { HerdrTopology } from '../../src/status.ts'

const PROJ = '/proj/repo'
const ROOT = PROJ + '/root'
const OUTSIDE = '/proj/other'

function topo(workspaces: { id: string; panes: { id: string; cwd?: string; fwd?: string }[] }[]): HerdrTopology {
  const ids = workspaces.map(w => w.id)
  const wsViews = ids.map(id => ({ workspace_id: id }))
  const tabs = ids.map(id => ({ tab_id: id + ':t1', workspace_id: id }))
  const panes = workspaces.flatMap(w =>
    w.panes.map(p => ({
      pane_id: p.id,
      workspace_id: w.id,
      tab_id: w.id + ':t1',
      cwd: p.cwd,
      foreground_cwd: p.fwd,
      focused: false,
    })),
  )
  return { workspaces: wsViews, tabs, panes } as unknown as HerdrTopology
}

test('T05: filterTopology keeps workspace whose pane cwd is inside project', () => {
  const t = topo([
    { id: 'w1', panes: [{ id: 'w1:p1', cwd: PROJ + '/src' }] },
    { id: 'w2', panes: [{ id: 'w2:p1', cwd: OUTSIDE }] },
  ])
  const { filtered, filterInfo } = filterTopology(t, PROJ, [])
  assert.deepEqual(filtered.workspaces.map(w => w.workspace_id), ['w1'], 'only in-project workspace kept')
  assert.deepEqual(filtered.panes.map(p => p.pane_id), ['w1:p1'], 'panes filtered with workspace')
  assert.equal(filterInfo.matched, 1)
  assert.equal(filterInfo.total, 2)
  assert.deepEqual(filterInfo.hidden_workspaces, ['w2'])
  assert.equal(filterInfo.project_root, PROJ)
})

test('T05: filterTopology prefix boundary — sibling prefix is not inside', () => {
  const t = topo([{ id: 'w1', panes: [{ id: 'w1:p1', cwd: PROJ + '_other/x' }] }])
  const { filtered, filterInfo } = filterTopology(t, PROJ, [])
  assert.equal(filtered.workspaces.length, 0, '/proj/repo_other is NOT under /proj/repo')
  assert.equal(filterInfo.matched, 0)
})

test('T05: filterTopology self-pane exemption keeps bound workspace unconditionally', () => {
  const t = topo([{ id: 'w1', panes: [{ id: 'w1:p1', cwd: OUTSIDE, fwd: OUTSIDE }] }])
  const { filtered, filterInfo } = filterTopology(t, PROJ, ['w1:p1'])
  assert.deepEqual(filtered.workspaces.map(w => w.workspace_id), ['w1'], 'bound pane workspace kept despite cwd outside')
  assert.equal(filterInfo.matched, 1)
  assert.equal(filterInfo.total, 1)
  assert.deepEqual(filterInfo.hidden_workspaces, [])
})

test('T05: filterTopology foreground_cwd hit counts', () => {
  const t = topo([{ id: 'w1', panes: [{ id: 'w1:p1', cwd: OUTSIDE, fwd: PROJ + '/x' }] }])
  const { filtered } = filterTopology(t, PROJ, [])
  assert.deepEqual(filtered.workspaces.map(w => w.workspace_id), ['w1'], 'foreground_cwd inside project matches')
})
test('T05: filterTopology workspaces with no panes match via checkout_path', () => {
  // workspace 无 pane（或 pane cwd 缺失）时，命中退化为 worktree.checkout_path（§7.2 第 1 判据）
  const t: HerdrTopology = {
    workspaces: [
      { workspace_id: 'w1', checkout_path: PROJ + '/x' },
      { workspace_id: 'w2', checkout_path: OUTSIDE },
    ],
    tabs: [],
    panes: [],
  }
  const { filtered, filterInfo } = filterTopology(t, PROJ, [])
  assert.deepEqual(filtered.workspaces.map(w => w.workspace_id), ['w1'])
  assert.deepEqual(filterInfo.hidden_workspaces, ['w2'])
})

test('T05: filterTopology empty projectRoot keeps everything (no filtering)', () => {
  const t = topo([
    { id: 'w1', panes: [{ id: 'w1:p1', cwd: OUTSIDE }] },
    { id: 'w2', panes: [{ id: 'w2:p1', cwd: OUTSIDE }] },
  ])
  const { filtered, filterInfo } = filterTopology(t, '', [])
  assert.equal(filtered.workspaces.length, 2)
  assert.equal(filterInfo.matched, 2)
  assert.equal(filterInfo.total, 2)
  assert.deepEqual(filterInfo.hidden_workspaces, [])
})

test('T05: snapshot scope defaults to filtered, scope=all returns full', async () => {
  const snap = {
    version: '0.8.0', protocol: 19,
    workspaces: [{ workspace_id: 'w1' }, { workspace_id: 'w2' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }, { tab_id: 'w2:t1', workspace_id: 'w2' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', cwd: PROJ + '/src' },
      { pane_id: 'w2:p1', workspace_id: 'w2', cwd: OUTSIDE },
    ],
    layouts: [], agents: [],
    focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null,
  }
  const { client } = makeTrackerClient({ snap })
  const tracker = makeTracker(client, { pollIntervalMs: 60_000, projectRoot: PROJ, getBoundPaneIds: () => [] })
  tracker.start()
  await sleepMs(150)
  tracker.stop()
  const proj = tracker.snapshot()
  assert.deepEqual(proj.topology.workspaces.map(w => w.workspace_id), ['w1'])
  assert.deepEqual(proj.filter.hidden_workspaces, ['w2'])
  assert.equal(proj.filter.matched, 1)
  assert.equal(proj.filter.total, 2)
  const all = tracker.snapshot('all')
  assert.deepEqual(all.topology.workspaces.map(w => w.workspace_id), ['w1', 'w2'])
  assert.equal(all.filter.matched, 1, 'filter 元数据与 scope 无关')
  assert.equal(all.filter.total, 2)
  assert.deepEqual(tracker.snapshot('project').topology.workspaces.map(w => w.workspace_id), ['w1'])
})

test('T05: pollTopology maps pane label from snapshot PaneInfo.label', async () => {
  const snap = {
    version: '0.8.0', protocol: 19,
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', cwd: PROJ + '/src', label: '我的 pane' },
      { pane_id: 'w1:p2', workspace_id: 'w1', cwd: PROJ + '/src' },
    ],
    layouts: [], agents: [],
    focused_pane_id: null, focused_tab_id: null, focused_workspace_id: null,
  }
  const { client } = makeTrackerClient({ snap })
  const tracker = makeTracker(client, { pollIntervalMs: 60_000, projectRoot: PROJ, getBoundPaneIds: () => [] })
  tracker.start()
  await sleepMs(150)
  tracker.stop()
  const panes = tracker.snapshot().topology.panes
  const p1 = panes.find(p => p.pane_id === 'w1:p1')
  const p2 = panes.find(p => p.pane_id === 'w1:p2')
  assert.equal(p1?.label, '我的 pane', 'label 字段映射自 snapshot')
  assert.equal(p2?.label, undefined, '无 label 的 pane 字段保持缺失')
})

