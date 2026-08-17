// HerdrDashboardTracker 单测（design: dashboard §6 Step 1/2 —— 复用 status 快照、
// host 采集、进程探测 best-effort、DTO 装配/脱敏、单飞/abort、失败不覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  HerdrDashboardTracker,
  type HerdrDashboardProcess,
  type HerdrDashboardStatusSource,
} from '../../src/dashboard.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 状态源快照（HerdrStatusSnapshot 的最小结构）。 */
function statusSource(over: Partial<HerdrDashboardStatusSource> = {}): HerdrDashboardStatusSource {
  return {
    connected: true,
    stale: false,
    last_error: null,
    server: {
      status: 'running',
      running: true,
      version: '0.8.0',
      protocol: 19,
      socket: '/Users/alice/.config/herdr/herdr.sock',
      session: 'work',
      checked_at: 1000,
      installation: 'installed',
    },
    topology: {
      workspaces: [
        { workspace_id: 'w1', label: 'demo', checkout_path: '/Users/alice/work/demo' },
      ],
      tabs: [{ workspace_id: 'w1' }],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w1:p2', workspace_id: 'w1' },
      ],
    },
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', kind: 'codex', status: 'working' },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'pi', status: 'idle' },
    ],
    ...over,
  }
}

/** 进程样本（available）。 */
function processSample(over: Partial<HerdrDashboardProcess> = {}): HerdrDashboardProcess {
  return {
    available: true,
    pid: 4242,
    started_at: 900000,
    cpu_percent: 2.5,
    rss_bytes: 1048576,
    source: 'posix-pgrep-ps',
    sampled_at: 1000000,
    error: null,
    ...over,
  }
}

const HOST = { hostname: 'devbox', platform: 'darwin', arch: 'arm64', os_type: 'Darwin', os_release: '24.0.0', node_version: 'v22.0.0' }

function makeTracker(opts: {
  readStatus?: () => HerdrDashboardStatusSource
  probe?: (signal: AbortSignal) => Promise<HerdrDashboardProcess>
  pollIntervalMs?: number
  staleThresholdMs?: number
  probeIntervalMs?: number
} = {}) {
  const probes: number[] = []
  const tracker = new HerdrDashboardTracker(new Context(), {
    readStatus: opts.readStatus ?? (() => statusSource()),
    probeProcess: opts.probe ?? (async () => {
      probes.push(Date.now())
      return processSample()
    }),
    collectHost: () => HOST,
    pollIntervalMs: opts.pollIntervalMs ?? 60_000,
    staleThresholdMs: opts.staleThresholdMs ?? 5_000,
    probeIntervalMs: opts.probeIntervalMs ?? 15_000,
  })
  return { tracker, probes }
}

test('before any cycle: empty DTO has full structure with host available', () => {
  const { tracker } = makeTracker()
  const snap = tracker.snapshot()
  assert.equal(snap.updated_at, 0)
  assert.equal(snap.stale, true)
  assert.deepEqual(snap.host, HOST)
  assert.equal(snap.server.status, 'unknown')
  assert.equal(snap.process.available, false)
  assert.deepEqual(snap.workspaces, [])
  assert.deepEqual(snap.summary, { workspaces: 0, tabs: 0, panes: 0, agents: 0, agents_by_status: {} })
  assert.equal(snap.connection.collectors.host, true)
})

test('a clean cycle assembles the full DTO from the status source', async () => {
  const { tracker } = makeTracker()
  tracker.start()
  await sleep(120)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.equal(snap.stale, false)
  assert.ok(snap.updated_at > 0)
  assert.equal(snap.last_error, null)
  assert.equal(snap.server.version, '0.8.0')
  assert.equal(snap.server.protocol, 19)
  assert.equal(snap.server.session, 'work')
  // 脱敏：socket 绝对路径只保留 basename（决策 4）
  assert.equal(snap.server.socket, 'herdr.sock')
  assert.equal(snap.connection.connected, true)
  assert.equal(snap.connection.last_success_at, snap.updated_at)
  assert.equal(snap.connection.collectors.server, true)
  assert.equal(snap.connection.collectors.process, true)
  assert.deepEqual(snap.process, processSample())
  assert.equal(snap.summary.workspaces, 1)
  assert.equal(snap.summary.panes, 2)
  assert.equal(snap.summary.agents, 2)
  assert.deepEqual(snap.summary.agents_by_status, { working: 1, idle: 1 })
  assert.equal(snap.workspaces[0].checkout_path_base, 'demo')
})

test('probe failure → process unavailable with reason; topology intact; last_error set', async () => {
  const { tracker } = makeTracker({
    probe: async () => ({ available: false, pid: null, started_at: null, cpu_percent: null, rss_bytes: null, source: 'posix-pgrep-ps', sampled_at: 5, error: 'herdr server process not found (is the server running?)' }),
  })
  tracker.start()
  await sleep(120)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.equal(snap.process.available, false)
  assert.match(snap.process.error ?? '', /not found/)
  // 失败不覆盖最后一份有效拓扑：workspaces 仍完整
  assert.equal(snap.workspaces.length, 1)
  assert.equal(snap.summary.panes, 2)
  assert.equal(snap.connection.collectors.process, false)
  assert.match(snap.last_error ?? '', /not found/)
})

test('status source stale → dashboard stale; last_success_at stays 0', async () => {
  const { tracker } = makeTracker({
    readStatus: () => statusSource({ stale: true, connected: false }),
  })
  tracker.start()
  await sleep(120)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.equal(snap.stale, true)
  assert.equal(snap.updated_at, 0)
  assert.equal(snap.connection.last_success_at, 0)
  assert.equal(snap.connection.connected, false)
})

test('old-herdr missing fields degrade gracefully (server unknown/null, no crash)', async () => {
  const { tracker } = makeTracker({
    readStatus: () => statusSource({
      server: { status: 'unknown', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0, installation: 'unknown' },
      topology: { workspaces: [], tabs: [], panes: [] },
      agents: [],
    }),
  })
  tracker.start()
  await sleep(120)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.equal(snap.server.version, null)
  assert.equal(snap.server.socket, null)
  assert.equal(snap.connection.collectors.server, false)
  assert.deepEqual(snap.workspaces, [])
  assert.equal(snap.process.available, true, 'host/process 与 socket 数据解耦')
})

test('stop aborts in-flight cycle: no state written after stop', async () => {
  let resolveProbe: (v: HerdrDashboardProcess) => void = () => {}
  const { tracker } = makeTracker({
    probe: () => new Promise(resolve => { resolveProbe = resolve }),
  })
  tracker.start()
  await sleep(40) // 首个周期在途（probe 挂起）
  tracker.stop()
  resolveProbe(processSample()) // 迟到的结果
  await sleep(80)
  tracker.stop() // 幂等
  const snap = tracker.snapshot()
  assert.equal(snap.updated_at, 0, 'stop 后迟到结果不落盘')
  assert.equal(snap.stale, true)
})

test('single-flight: slow probe does not overlap cycles', async () => {
  let calls = 0
  const { tracker } = makeTracker({
    probe: async () => {
      calls += 1
      await sleep(150)
      return processSample()
    },
    pollIntervalMs: 30,
    probeIntervalMs: 10, // 节流窗口调小，保证单飞守卫本身被测到（而非被节流掩盖）
  })
  tracker.start()
  await sleep(450)
  tracker.stop()
  // 无单飞：~15 tick；单飞后每次周期 ≥150ms → 约 3 次
  assert.ok(calls >= 1, 'at least one probe ran')
  assert.ok(calls <= 4, `expected bounded probe calls, got ${calls}`)
})

test('P1-3: probe is throttled — reused sample inside window, no respawn', async () => {
  let calls = 0
  const { tracker } = makeTracker({
    probe: async () => {
      calls += 1
      return processSample({ sampled_at: 1_000_000 + calls })
    },
    pollIntervalMs: 20,
    probeIntervalMs: 300,
  })
  // 阶段 1：窗口内多个周期只探测一次（复用样本；宽窗口抗 CI 时序抖动）
  tracker.start()
  await sleep(100) // ~5 个周期，全部落在 300ms 窗口内
  tracker.stop()
  assert.equal(calls, 1, '窗口内复用上次样本，不重复 spawn ps/pgrep')
  // 复用样本原样返回（sampled_at 保持旧值，诚实标注采样时间）
  assert.equal(tracker.snapshot().process.sampled_at, 1_000_001)
  // 阶段 2：窗口过期后恢复探测
  await sleep(250) // 距首次探测 ≥350ms > 300ms 窗口
  tracker.start()
  await sleep(60)
  tracker.stop()
  assert.equal(calls, 2, '窗口过期后重新探测')
  assert.equal(tracker.snapshot().process.sampled_at, 1_000_002)
})

test('status last_error propagates into dashboard DTO', async () => {
  const { tracker } = makeTracker({
    readStatus: () => statusSource({ last_error: 'topology poll failed: boom' }),
  })
  tracker.start()
  await sleep(120)
  tracker.stop()
  assert.match(tracker.snapshot().last_error ?? '', /topology poll failed: boom/)
})
