// Dashboard 纯聚合逻辑单测（design: dashboard §6 Step 5 —— DTO 归一化、计数、
// stale、缺失值、bytes/duration 格式化、路径脱敏；不依赖 React/DOM）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentKindCounts,
  agentStatusCounts,
  aggregateDashboardWorkspaces,
  buildDashboardSummary,
  collectDashboardAgents,
  deriveMarkerServerState,
  derivePaneNavState,
  deriveStale,
  formatBytes,
  formatDuration,
  normalizeAgentKind,
  pathBase,
  shouldProbeNow,
  sortedStatusCounts,
  type DashboardTopologyLike,
} from '../../src/client-logic.ts'

// ---------------------------------------------------------------------------
// agent 状态计数
// ---------------------------------------------------------------------------

test('agentStatusCounts: empty and missing-status inputs', () => {
  assert.deepEqual(agentStatusCounts([]), {})
  assert.deepEqual(agentStatusCounts([{ status: undefined }, { status: null }, {}]), { unknown: 3 })
  assert.deepEqual(agentStatusCounts([{ status: '' }]), { unknown: 1 })
})

test('agentStatusCounts: counts duplicates and mixed statuses', () => {
  const counts = agentStatusCounts([
    { status: 'working' },
    { status: 'working' },
    { status: 'idle' },
    { status: 'blocked' },
    { status: 'done' },
    { status: 'weird' },
  ])
  assert.deepEqual(counts, { working: 2, idle: 1, blocked: 1, done: 1, weird: 1 })
})

test('sortedStatusCounts: stable priority order, only >0, rest alphabetical', () => {
  const sorted = sortedStatusCounts({ done: 1, unknown: 2, working: 3, zzz: 1, aaa: 1 })
  assert.deepEqual(sorted, [['working', 3], ['done', 1], ['unknown', 2], ['aaa', 1], ['zzz', 1]])
  assert.deepEqual(sortedStatusCounts({}), [])
  assert.deepEqual(sortedStatusCounts({ working: 0 }), [], 'zero counts excluded')
})

// ---------------------------------------------------------------------------
// 路径脱敏（决策 4：完整 cwd/socket 绝对路径只暴露 basename）
// ---------------------------------------------------------------------------

test('pathBase: strips directories and trailing slashes', () => {
  assert.equal(pathBase('/Users/alice/.config/herdr/herdr.sock'), 'herdr.sock')
  assert.equal(pathBase('/proj/repo/src/'), 'src')
  assert.equal(pathBase('a'), 'a')
  assert.equal(pathBase('C:\\proj\\repo'), 'repo')
  assert.equal(pathBase('/'), null)
  assert.equal(pathBase(''), null)
  assert.equal(pathBase(null), null)
  assert.equal(pathBase(undefined), null)
})

// ---------------------------------------------------------------------------
// bytes / duration 格式化（缺失/非法 → null，UI 显示 Unavailable 而非伪造 0）
// ---------------------------------------------------------------------------

test('formatBytes: human-readable with unit scaling', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1048576), '1.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB')
})

test('formatBytes: null/negative/NaN → null (never fakes 0)', () => {
  assert.equal(formatBytes(null), null)
  assert.equal(formatBytes(undefined), null)
  assert.equal(formatBytes(-1), null)
  assert.equal(formatBytes(Number.NaN), null)
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), null)
})

test('formatDuration: ms/s/m/h with natural rounding', () => {
  assert.equal(formatDuration(500), '500ms')
  assert.equal(formatDuration(3000), '3s')
  assert.equal(formatDuration(65000), '1m 5s')
  assert.equal(formatDuration(120000), '2m')
  assert.equal(formatDuration(3600000), '1h')
  assert.equal(formatDuration(3660000), '1h 1m')
  assert.equal(formatDuration(null), null)
  assert.equal(formatDuration(-5), null)
  assert.equal(formatDuration(Number.NaN), null)
})

// ---------------------------------------------------------------------------
// stale 派生
// ---------------------------------------------------------------------------

test('deriveStale: never refreshed is stale; threshold boundary', () => {
  assert.equal(deriveStale(0, 1000, 6000), true, 'updatedAt=0 (never) → stale')
  assert.equal(deriveStale(1000, 3000, 6000), false, 'within threshold → fresh')
  assert.equal(deriveStale(1000, 7001, 6000), true, 'beyond threshold → stale')
})

test('shouldProbeNow: never probed probes; throttle window respected', () => {
  assert.equal(shouldProbeNow(0, 1000, 15000), true, 'lastProbeAt=0 (never) → probe')
  assert.equal(shouldProbeNow(1000, 10000, 15000), false, 'within window → reuse')
  assert.equal(shouldProbeNow(1000, 16000, 15000), true, 'window elapsed → probe again')
  assert.equal(shouldProbeNow(1000, 16000, 0), true, 'zero interval → always probe')
})

// ---------------------------------------------------------------------------
// workspace 聚合与汇总
// ---------------------------------------------------------------------------

function topo(): DashboardTopologyLike {
  return {
    workspaces: [
      { workspace_id: 'w1', label: 'demo', checkout_path: '/Users/alice/work/demo' },
      { workspace_id: 'w2' },
      { workspace_id: 'w10' },
    ],
    tabs: [
      { workspace_id: 'w1' },
      { workspace_id: 'w1' },
      { workspace_id: 'w2' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1' },
      { pane_id: 'w1:p2', workspace_id: 'w1' },
      { pane_id: 'w2:p1', workspace_id: 'w2' },
      { pane_id: 'w10:p1', workspace_id: 'w10' },
    ],
  }
}

const agents = [
  { pane_id: 'w1:p1', workspace_id: 'w1', kind: 'codex', name: 'codex-a', status: 'working' },
  { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'pi', status: 'blocked' },
  { pane_id: 'w2:p1', workspace_id: 'w2', status: 'idle' },
  // workspace_id 缺失：按 pane_id 反查 topology（协议兼容降级）
  { pane_id: 'w10:p1', status: 'working' },
  // pane 不在 topology：忽略
  { pane_id: 'ghost:p9', workspace_id: 'ghost', status: 'done' },
  // 完全无归属：忽略
  { status: 'unknown' },
]

test('aggregateDashboardWorkspaces: counts, status aggregation, agent details and basename sanitize', () => {
  const ws = aggregateDashboardWorkspaces(topo(), agents)
  // 自然排序：w1 < w2 < w10
  assert.deepEqual(ws.map(w => w.workspace_id), ['w1', 'w2', 'w10'])
  const w1 = ws[0]
  assert.equal(w1.label, 'demo')
  assert.equal(w1.checkout_path_base, 'demo', '绝对路径脱敏为 basename')
  assert.equal(w1.tab_count, 2)
  assert.equal(w1.pane_count, 2)
  assert.equal(w1.agent_count, 2)
  assert.equal(w1.agents_working, 1)
  assert.equal(w1.agents_blocked, 1)
  // v4：agent 明细挂 workspace（name/kind/status；kind 回退链 kind → agent）
  assert.deepEqual(w1.agents.map(a => a.pane_id), ['w1:p1', 'w1:p2'])
  assert.equal(w1.agents[0].kind, 'codex')
  assert.equal(w1.agents[0].status, 'working')
  const w10 = ws[2]
  assert.equal(w10.agent_count, 1, 'workspace_id 缺失的 agent 按 pane 反查归属')
  assert.equal(w10.agents_working, 1)
  assert.equal(w10.agents[0].kind, 'unknown', '无 kind/agent 时回退 unknown')
})

test('aggregateDashboardWorkspaces: empty topology and missing fields are stable', () => {
  assert.deepEqual(aggregateDashboardWorkspaces({ workspaces: [], tabs: [], panes: [] }, []), [])
  const ws = aggregateDashboardWorkspaces(
    { workspaces: [{ workspace_id: 'w1' }], tabs: [], panes: [] },
    [{ status: 'unknown' }, { status: null }],
  )
  assert.equal(ws.length, 1)
  assert.equal(ws[0].tab_count, 0)
  assert.equal(ws[0].pane_count, 0)
  assert.equal(ws[0].agent_count, 0, '无归属 agent 不计数到 workspace')
  assert.equal(ws[0].label, null)
  assert.equal(ws[0].checkout_path_base, null)
  assert.deepEqual(ws[0].agents, [], '无 agent 明细 → 空数组而非丢 workspace')
})

test('buildDashboardSummary: totals and status distribution from one normalized pass', () => {
  const ws = aggregateDashboardWorkspaces(topo(), agents)
  const summary = buildDashboardSummary(ws, agents)
  assert.equal(summary.workspaces, 3)
  assert.equal(summary.tabs, 3)
  assert.equal(summary.panes, 4)
  assert.equal(summary.agents, 6, 'agent 总数以全量为口径（含无归属）')
  assert.deepEqual(summary.agents_by_status, { working: 2, blocked: 1, idle: 1, done: 1, unknown: 1 })
})

// ---------------------------------------------------------------------------
// v5：workspace pane 明细（可点击跳转 / 可关闭的数据源）
// ---------------------------------------------------------------------------

test('aggregateDashboardWorkspaces: pane detail joins agent (label/kind/name/status)', () => {
  const topo2: DashboardTopologyLike = {
    workspaces: [{ workspace_id: 'w1', label: 'demo' }],
    tabs: [],
    panes: [
      { pane_id: 'w1:p2', workspace_id: 'w1' },
      { pane_id: 'w1:p1', workspace_id: 'w1', label: 'root pane' },
    ],
  }
  const ag2 = [
    { pane_id: 'w1:p1', workspace_id: 'w1', kind: 'codex', name: 'codex-a', status: 'working' },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'pi', status: 'blocked' },
  ]
  const ws = aggregateDashboardWorkspaces(topo2, ag2)
  assert.equal(ws.length, 1)
  assert.equal(ws[0].pane_count, 2)
  // pane_id 自然排序：w1:p1 < w1:p2
  assert.deepEqual(ws[0].panes.map(p => p.pane_id), ['w1:p1', 'w1:p2'])
  const p1 = ws[0].panes[0]
  assert.equal(p1.label, 'root pane')
  assert.equal(p1.kind, 'codex')
  assert.equal(p1.name, 'codex-a')
  assert.equal(p1.status, 'working')
  const p2 = ws[0].panes[1]
  assert.equal(p2.label, null, '无 label → null')
  assert.equal(p2.kind, 'pi', 'kind 回退链 kind → agent')
  assert.equal(p2.name, undefined, '无自定义 target 名')
  assert.equal(p2.status, 'blocked')
})

test('aggregateDashboardWorkspaces: non-agent pane falls back to agent_status + unknown kind', () => {
  const topo2: DashboardTopologyLike = {
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' },
      { pane_id: 'w1:p2', workspace_id: 'w1', label: 'plain', agent_status: 'unknown' },
    ],
  }
  const ws = aggregateDashboardWorkspaces(topo2, [])
  assert.equal(ws[0].pane_count, 2)
  assert.equal(ws[0].agent_count, 0, '无 agent 归属')
  assert.equal(ws[0].panes[0].pane_id, 'w1:p1')
  assert.equal(ws[0].panes[0].label, null)
  assert.equal(ws[0].panes[0].kind, 'unknown', '非 agent pane kind=unknown')
  assert.equal(ws[0].panes[0].name, undefined)
  assert.equal(ws[0].panes[0].status, 'idle', '非 agent pane 回退 agent_status')
  assert.equal(ws[0].panes[1].label, 'plain')
  assert.equal(ws[0].panes[1].status, 'unknown', 'agent_status 未知 → unknown')
})

// ---------------------------------------------------------------------------
// v4：kind 归一化 / agent 收集 / kind 计数 / Treemap / marker 状态派生
// ---------------------------------------------------------------------------

test('normalizeAgentKind: kind → agent → unknown fallback chain (name is never kind)', () => {
  assert.equal(normalizeAgentKind('codex', 'pi'), 'codex')
  assert.equal(normalizeAgentKind(undefined, 'pi'), 'pi')
  assert.equal(normalizeAgentKind('  ', 'opencode'), 'opencode', '空白 kind 回退')
  assert.equal(normalizeAgentKind(undefined, undefined), 'unknown')
  assert.equal(normalizeAgentKind(null, ''), 'unknown')
  // name 不当 kind：有 name 无 kind/agent → unknown
  assert.equal(normalizeAgentKind(undefined, undefined), 'unknown')
})

test('collectDashboardAgents: merges all workspaces and sorts kind → name → pane_id', () => {
  const ws = aggregateDashboardWorkspaces(topo(), agents)
  const all = collectDashboardAgents(ws)
  assert.equal(all.length, 4, '合并全部 workspace 的 agent 明细')
  // 稳定排序：kind 字母序（codex < pi < unknown）
  const kinds = all.map(a => a.kind)
  assert.deepEqual(kinds, [...kinds].sort())
  // 空输入稳定
  assert.deepEqual(collectDashboardAgents([]), [])
})

test('agentKindCounts: kind → count, descending by count then kind', () => {
  const counts = agentKindCounts([
    { kind: 'codex' }, { kind: 'codex' }, { kind: 'pi' }, { kind: 'unknown' },
  ])
  assert.deepEqual(counts, [
    { kind: 'codex', value: 2 },
    { kind: 'pi', value: 1 },
    { kind: 'unknown', value: 1 },
  ])
  assert.deepEqual(agentKindCounts([]), [])
})

test('deriveMarkerServerState: running/stopped/not-installed/checking matrix', () => {
  assert.equal(deriveMarkerServerState(null), 'checking', '无快照 → checking')
  assert.equal(deriveMarkerServerState({}), 'checking')
  assert.equal(deriveMarkerServerState({ server: { running: true } }), 'running')
  assert.equal(deriveMarkerServerState({ server: { status: 'not_running', running: false, installation: 'installed' } }), 'stopped')
  assert.equal(deriveMarkerServerState({ server: { status: 'not_running', running: false, installation: 'missing' } }), 'not-installed')
  assert.equal(deriveMarkerServerState({ server: { status: 'unknown', running: false, installation: 'missing' } }), 'checking', '未知状态不误判为未安装')
  assert.equal(deriveMarkerServerState({ server: { status: 'not_running', running: false, installation: 'unknown' } }), 'stopped')
})

test('derivePaneNavState: pane belongs to current session → self (jump)', () => {
  assert.equal(derivePaneNavState('session-a', 'session-a'), 'self')
  assert.equal(derivePaneNavState('session-a', 'session-b'), 'foreign', '其他会话 → 提示')
  assert.equal(derivePaneNavState('session-a', null), 'unbound', '无归属 → 提示')
  assert.equal(derivePaneNavState('session-a', undefined), 'unbound', '查询失败/无结果 → 提示')
  // 无当前会话（未注入 getSessionId）时任何 pane 都不能跳转
  assert.equal(derivePaneNavState(undefined, 'session-a'), 'foreign')
  assert.equal(derivePaneNavState(undefined, undefined), 'unbound')
})
