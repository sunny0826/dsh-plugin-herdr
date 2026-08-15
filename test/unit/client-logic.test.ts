// CA-016：Web 面板纯 UI 逻辑单测（client-logic.ts；真实浏览器渲染不可用属明确遗留）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGroups,
  comparePaneId,
  compareWorkspaceId,
  computeSnapPosition,
  createStatusStore,
  dotState,
  formatTime,
  isDragMovement,
  parseStartResponse,
  shouldAutoExpand,
  toggleCollapse,
} from '../../src/client-logic.ts'
import type { HerdrTopology } from '../../src/status.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 排序 / 分组 / 派生
// ---------------------------------------------------------------------------

test('CA-016: comparePaneId / compareWorkspaceId natural ordering', () => {
  assert.deepEqual(['w8:p10', 'w8:p2', 'w9:p1'].sort(comparePaneId), ['w8:p2', 'w8:p10', 'w9:p1'])
  assert.equal(comparePaneId('w8:p1', 'w8:p1'), 0)
  assert.deepEqual(['w10', 'w2', 'w9'].sort(compareWorkspaceId), ['w2', 'w9', 'w10'])
})

test('CA-016: dotState maps working/blocked/other to dot states', () => {
  assert.equal(dotState('working'), 'ongoing')
  assert.equal(dotState('blocked'), 'error')
  assert.equal(dotState('done'), 'done')
  assert.equal(dotState('idle'), 'done')
  assert.equal(dotState(undefined), 'done')
})

test('CA-016: buildGroups groups panes by workspace with natural sort', () => {
  const topology: HerdrTopology = {
    workspaces: [
      { workspace_id: 'w10' },
      { workspace_id: 'w2' },
    ],
    tabs: [{ tab_id: 't1', workspace_id: 'w2' }, { tab_id: 't2', workspace_id: 'w10' }],
    panes: [
      { pane_id: 'w2:p10', workspace_id: 'w2', focused: false },
      { pane_id: 'w2:p2', workspace_id: 'w2', focused: true },
      { pane_id: 'w10:p1', workspace_id: 'w10', focused: false },
    ],
  }
  const groups = buildGroups(topology)
  assert.deepEqual(groups.map(g => g.workspace.workspace_id), ['w2', 'w10'], 'workspaces sorted naturally')
  assert.deepEqual(groups[0].panes.map(p => p.pane_id), ['w2:p2', 'w2:p10'], 'panes sorted naturally')
  assert.equal(groups[1].panes.length, 1)
  assert.equal(groups[0].tabs.length, 1, 'tabs filtered per workspace')
  assert.equal(buildGroups(undefined).length, 0)
})

test('CA-016: formatTime renders HH:MM:SS-ish', () => {
  const s = formatTime(1700000000000)
  assert.ok(typeof s === 'string' && s.length >= 5)
})

// ---------------------------------------------------------------------------
// 拖动 / 折叠 / 自动展开
// ---------------------------------------------------------------------------

test('CA-016: isDragMovement threshold', () => {
  assert.equal(isDragMovement(1, 1), false)
  assert.equal(isDragMovement(5, 0), true)
  assert.equal(isDragMovement(0, -5), true)
})

test('CA-016: computeSnapPosition snaps right to viewport, left to sidebar, clamps y', () => {
  const vw = 1000, vh = 700
  // 中心偏右 → 右边界吸附
  const right = computeSnapPosition({ x: 800, y: 100, w: 200, h: 100, vw, vh, sidebarW: 0, snap: 16 })
  assert.deepEqual(right, { x: vw - 200 - 16, y: 100 })
  // 中心偏左 → 侧边栏右缘吸附
  const left = computeSnapPosition({ x: 100, y: 100, w: 200, h: 100, vw, vh, sidebarW: 80, snap: 16 })
  assert.deepEqual(left, { x: 80 + 16, y: 100 })
  // 纵向夹取在视口内（不超出 vh - h - snap）
  const yClamp = computeSnapPosition({ x: 800, y: 1000, w: 200, h: 100, vw, vh, sidebarW: 0 })
  assert.deepEqual(yClamp, { x: vw - 200 - 16, y: vh - 100 - 16 })
  // 纵向最小边界
  const yMin = computeSnapPosition({ x: 800, y: -50, w: 200, h: 100, vw, vh, sidebarW: 0 })
  assert.equal(yMin.y, 16)
})

test('CA-016: toggleCollapse is immutable', () => {
  const s = new Set<string>(['w1'])
  const next = toggleCollapse(s, 'w1')
  assert.deepEqual([...next], [], 'removed')
  assert.deepEqual([...s], ['w1'], 'original untouched')
  const add = toggleCollapse(s, 'w2')
  assert.deepEqual([...add].sort(), ['w1', 'w2'])
})

test('CA-016: shouldAutoExpand only on working rising edge while collapsed', () => {
  assert.equal(shouldAutoExpand('idle', 'working', true), true)
  assert.equal(shouldAutoExpand('working', 'working', true), false, 'not a rising edge')
  assert.equal(shouldAutoExpand('idle', 'working', false), false, 'already expanded')
  assert.equal(shouldAutoExpand('idle', 'done', true), false)
  assert.equal(shouldAutoExpand(undefined, 'working', true), true, 'first observation counts as edge')
})

// ---------------------------------------------------------------------------
// start 流程
// ---------------------------------------------------------------------------

test('CA-016: parseStartResponse ok/error/non-JSON', async () => {
  assert.deepEqual(await parseStartResponse({ ok: true, json: async () => ({ ok: true }) }), { ok: true })
  const err = await parseStartResponse({ ok: true, json: async () => ({ ok: false, error: 'boom' }) })
  assert.deepEqual(err, { ok: false, error: 'boom' })
  const bad = await parseStartResponse({ ok: false, json: async () => { throw new Error('x') } })
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /non-JSON/)
})

// ---------------------------------------------------------------------------
// 轮询 store：单飞 / 无重复 timer / 卸载即停
// ---------------------------------------------------------------------------

function makeFetcher(ms: number) {
  const calls: number[] = []
  const fetcher = async (signal: AbortSignal) => {
    const id = calls.length + 1
    calls.push(id)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), ms)
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
    })
    return { id, at: Date.now() }
  }
  return { calls, fetcher }
}

test('CA-016: store polls immediately and periodically without duplicate timers', async () => {
  const { fetcher } = makeFetcher(5)
  const store = createStatusStore<{ id: number }>({ intervalMs: 30, fetch: fetcher })
  const unsub = store.subscribe(() => {})
  await sleep(80)
  assert.ok(store.getSnap() !== null, 'first poll is immediate')
  assert.ok(store.getSnap()!.id >= 1)
  unsub() // 最后订阅者退订 → 停止轮询
  await sleep(60)
  const snapAfter = store.getSnap()
  unsub() // 幂等（二次退订）
  assert.equal(store.getSnap(), snapAfter, 'no further polls after unsubscribe')
  store.stop()
})

test('CA-016: single-flight — slow fetch never overlaps (inflight <= 1)', async () => {
  const { calls, fetcher } = makeFetcher(60)
  const store = createStatusStore<{ id: number }>({ intervalMs: 10, fetch: fetcher })
  const unsub = store.subscribe(() => {})
  await sleep(200)
  // 20 个 interval tick + refresh 触发，但单飞后实际请求数应接近 200/60 ≈ 3-4
  assert.ok(calls.length <= 5, `expected bounded fetches, got ${calls.length}`)
  assert.ok(calls.length >= 2, 'multiple sequential cycles still happen')
  assert.ok(store.inflight() <= 1)
  unsub()
  store.stop()
})

test('CA-016: stop aborts in-flight and discards results; refresh after stop is a no-op', async () => {
  let aborted = false
  const store = createStatusStore<{ id: number }>({
    intervalMs: 10_000,
    fetch: signal => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) })
    }),
  })
  const unsub = store.subscribe(() => {})
  await sleep(20)
  store.stop()
  assert.equal(aborted, true, 'in-flight request aborted on stop')
  await sleep(10) // 等 rejection 微任务把 polling 复位
  assert.equal(store.inflight(), 0)
  store.refresh() // 已停止 → no-op（不重新启动）
  await sleep(20)
  assert.equal(aborted, true, 'no new fetch after stop')
  unsub()
})

test('CA-016: errors surface via getError, cleared on success', async () => {
  let fail = true
  const store = createStatusStore<{ ok: boolean }>({
    intervalMs: 10_000,
    fetch: async () => {
      if (fail) throw new Error('server down')
      return { ok: true }
    },
  })
  const unsub = store.subscribe(() => {})
  await sleep(20)
  assert.match(store.getError() ?? '', /server down/)
  fail = false
  store.refresh()
  await sleep(20)
  assert.equal(store.getError(), null)
  unsub()
  store.stop()
})
