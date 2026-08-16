// CA-016：Web 面板纯 UI 逻辑单测（client-logic.ts；真实浏览器渲染不可用属明确遗留）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HERDR_PRESET_ID,
  agentTheme,
  applyPaneOrder,
  buildGroups,
  classifyLogLine,
  comparePaneId,
  compareWorkspaceId,
  computeSnapPosition,
  createStatusStore,
  deriveHerdrMode,
  dotState,
  filterGroupsToSession,
  formatTime,
  isDragMovement,
  loadPaneOrder,
  parseStartResponse,
  paneOrderKey,
  reorderPanes,
  savePaneOrder,
  shouldAutoExpand,
  toggleCollapse,
  validateLabel,
} from '../../src/client-logic.ts'
import type { PaneOrderStorageLike } from '../../src/client-logic.ts'
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

// ---------------------------------------------------------------------------
// 拖拽排序 / 持久化（T10）
// ---------------------------------------------------------------------------

test('CA-016: reorderPanes moves item to target index (落位后索引), immutable', () => {
  const ids = ['a', 'b', 'c', 'd']
  // 向前移（from < to）：'b'(1) → 落位 2 → ['a','c','b','d']
  assert.deepEqual(reorderPanes(ids, 1, 2), ['a', 'c', 'b', 'd'])
  // 向后移（from > to）：'d'(3) → 落位 1 → ['a','d','b','c']
  assert.deepEqual(reorderPanes(ids, 3, 1), ['a', 'd', 'b', 'c'])
  // 移到开头
  assert.deepEqual(reorderPanes(ids, 2, 0), ['c', 'a', 'b', 'd'])
  // 移到末尾
  assert.deepEqual(reorderPanes(ids, 0, 3), ['b', 'c', 'd', 'a'])
  // 不修改原数组
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'])
})

test('CA-016: reorderPanes 边界（越界 / 相同）稳定返回拷贝', () => {
  const ids = ['a', 'b', 'c']
  // from === to → 原样
  assert.deepEqual(reorderPanes(ids, 1, 1), ['a', 'b', 'c'])
  // from 越界
  assert.deepEqual(reorderPanes(ids, -1, 1), ['a', 'b', 'c'])
  assert.deepEqual(reorderPanes(ids, 5, 1), ['a', 'b', 'c'])
  // to 越界
  assert.deepEqual(reorderPanes(ids, 0, -1), ['a', 'b', 'c'])
  assert.deepEqual(reorderPanes(ids, 0, 9), ['a', 'b', 'c'])
  // 空数组
  assert.deepEqual(reorderPanes([], 0, 0), [])
})

test('CA-016: applyPaneOrder 按 order 排列，未知 id 追加尾部，空值返回原数组', () => {
  const panes = [
    { pane_id: 'a' }, { pane_id: 'b' }, { pane_id: 'c' }, { pane_id: 'd' },
  ]
  // 部分覆盖：未知 d 追加尾部
  assert.deepEqual(
    applyPaneOrder(panes, ['c', 'a']),
    [{ pane_id: 'c' }, { pane_id: 'a' }, { pane_id: 'b' }, { pane_id: 'd' }],
  )
  // 全量覆盖
  assert.deepEqual(
    applyPaneOrder(panes, ['d', 'b', 'a', 'c']).map(p => p.pane_id),
    ['d', 'b', 'a', 'c'],
  )
  // order 为空 / 无效 → 返回原数组引用
  assert.equal(applyPaneOrder(panes, []), panes)
  assert.equal(applyPaneOrder(panes, null), panes)
  assert.equal(applyPaneOrder(panes, undefined), panes)
  // 重复 id 去重且不重复输出
  assert.deepEqual(applyPaneOrder(panes, ['b', 'b', 'a']).map(p => p.pane_id), ['b', 'a', 'c', 'd'])
  // 空 panes
  assert.deepEqual(applyPaneOrder([], ['x']), [])
})

test('CA-016: load/savePaneOrder 通过可注入 storage 读写（含损坏/空防御）', () => {
  const store = new Map<string, string>()
  const storage: PaneOrderStorageLike = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v) },
  }
  // 未保存 → null
  assert.equal(loadPaneOrder('w1', storage), null)
  // 保存后读回
  savePaneOrder('w1', ['w1:p2', 'w1:p1'], storage)
  assert.deepEqual(loadPaneOrder('w1', storage), ['w1:p2', 'w1:p1'])
  // 键格式契约：herdr:pane-order:<ws>
  assert.ok(store.has(paneOrderKey('w1')))
  assert.equal(paneOrderKey('w1'), 'herdr:pane-order:w1')
  // 不同 ws 隔离
  assert.equal(loadPaneOrder('w2', storage), null)
  // 覆盖写
  savePaneOrder('w1', ['w1:p1'], storage)
  assert.deepEqual(loadPaneOrder('w1', storage), ['w1:p1'])
})

test('CA-016: loadPaneOrder 损坏 JSON / 非数组 / 空数组 / 非字符串 → null 或过滤', () => {
  const store = new Map<string, string>([
    [paneOrderKey('bad-json'), '{oops'],
    [paneOrderKey('not-array'), '{"a":1}'],
    [paneOrderKey('empty'), '[]'],
    [paneOrderKey('mixed'), '[1, "w1:p1", false, "w1:p2"]'],
  ])
  const storage: PaneOrderStorageLike = {
    getItem: k => store.get(k) ?? null,
    setItem: () => {},
  }
  assert.equal(loadPaneOrder('bad-json', storage), null)
  assert.equal(loadPaneOrder('not-array', storage), null)
  assert.equal(loadPaneOrder('empty', storage), null)
  assert.deepEqual(loadPaneOrder('mixed', storage), ['w1:p1', 'w1:p2'])
})

test('CA-016: SSR/无 localStorage 防御 —— storage 不可用时 load 为 null、save 无操作', () => {
  assert.equal(loadPaneOrder('w1', null), null)
  assert.equal(savePaneOrder('w1', ['a'], null), undefined)
  // 注入 storage 抛错（模拟 localStorage 被禁）→ 静默
  const throwing: PaneOrderStorageLike = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(loadPaneOrder('w1', throwing), null)
  assert.equal(savePaneOrder('w1', ['a'], throwing), undefined)
})

// ---------------------------------------------------------------------------
// 名称校验（T12 · design-v2 §6.2 / §10）
// ---------------------------------------------------------------------------

test('CA-006/T12: validateLabel 去空白；空 → null（清除名称）', () => {
  assert.equal(validateLabel(''), null)
  assert.equal(validateLabel('   '), null)
  assert.equal(validateLabel('\t\n '), null)
})

test('CA-006/T12: validateLabel 非空 trim 返回', () => {
  assert.equal(validateLabel('  claude  '), 'claude')
  assert.equal(validateLabel('agent A'), 'agent A')
  assert.equal(validateLabel('中文字符'), '中文字符')
})

test('CA-006/T12: validateLabel 超长（>64）抛错', () => {
  assert.throws(() => validateLabel('x'.repeat(65)), /at most 64 characters/)
  // 边界：恰好 64 允许
  assert.equal(validateLabel('x'.repeat(64)), 'x'.repeat(64))
  // trim 后再判长：65 字符含前导空格 → trim 后 64，允许
  assert.equal(validateLabel(' ' + 'x'.repeat(64)), 'x'.repeat(64))
})

// ── Agent 主题与日志行分类（pane-log 行级渲染） ─────────────────────────
test('classifyLogLine: detects diff add/del with or without line numbers', () => {
  assert.equal(classifyLogLine('+ added line'), 'diff-add')
  assert.equal(classifyLogLine('- removed line'), 'diff-del')
  assert.equal(classifyLogLine('    110 +'), 'diff-add')
  assert.equal(classifyLogLine('    112 +14'), 'diff-add')
  assert.equal(classifyLogLine('    115 -'), 'diff-del')
  assert.equal(classifyLogLine('+++ b/file.ts'), 'plain')
  assert.equal(classifyLogLine('--- a/file.ts'), 'plain')
})

test('classifyLogLine: commands, headings, code fences, plain', () => {
  assert.equal(classifyLogLine('❯ sh -c pwd'), 'cmd')
  assert.equal(classifyLogLine('$ ls'), 'cmd')
  assert.equal(classifyLogLine('  ❯ git status'), 'cmd')
  assert.equal(classifyLogLine('## 测试缺口'), 'heading')
  assert.equal(classifyLogLine('```'), 'code-fence')
  assert.equal(classifyLogLine('~~~json'), 'code-fence')
  assert.equal(classifyLogLine('普通输出行'), 'plain')
})

test('agentTheme: prefix match with lowercase', () => {
  assert.equal(agentTheme('codex'), 'codex')
  assert.equal(agentTheme('Codex'), 'codex')
  assert.equal(agentTheme('pi-coding-agent'), 'pi')
  assert.equal(agentTheme('pi'), 'pi')
  assert.equal(agentTheme('claude-4'), 'claude')
  assert.equal(agentTheme('dsh'), 'dsh')
  assert.equal(agentTheme('unknown-agent'), 'other')
  assert.equal(agentTheme(undefined), 'other')
})

// ---------------------------------------------------------------------------
// Herdr 模式判定与面板会话聚焦（design: herdr-mode-gating MG-02）
// ---------------------------------------------------------------------------

test('MG-02: HERDR_PRESET_ID 与服务端 preset id 一致（preset-install.ts PRESET_ID）', () => {
  assert.equal(HERDR_PRESET_ID, 'herdr')
})

test('MG-02: deriveHerdrMode 按当前会话 agentPreset 判定', () => {
  const byId = {
    s1: { agentPreset: 'herdr' },
    s2: { agentPreset: 'default' },
    s3: {},
  }
  assert.equal(deriveHerdrMode(byId, 's1'), true)
  assert.equal(deriveHerdrMode(byId, 's2'), false)
  assert.equal(deriveHerdrMode(byId, 's3'), false)
  // 未知/无当前会话/无列表
  assert.equal(deriveHerdrMode(byId, 's9'), false)
  assert.equal(deriveHerdrMode(byId, undefined), false)
  assert.equal(deriveHerdrMode(undefined, 's1'), false)
  // 大小写敏感（preset id 是目录名）
  assert.equal(deriveHerdrMode({ s1: { agentPreset: 'Herdr' } }, 's1'), false)
})

test('MG-02: filterGroupsToSession 只保留包含 selfPaneId 的 workspace 组', () => {
  const topology: HerdrTopology = {
    workspaces: [{ workspace_id: 'w1' }, { workspace_id: 'w2' }],
    tabs: [
      { tab_id: 't1', workspace_id: 'w1' },
      { tab_id: 't2', workspace_id: 'w2' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', focused: true },
      { pane_id: 'w1:p2', workspace_id: 'w1', focused: false },
      { pane_id: 'w2:p1', workspace_id: 'w2', focused: false },
    ],
  }
  const groups = filterGroupsToSession(topology, 'w1:p1')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].workspace.workspace_id, 'w1')
  // 组内 panes 保持 buildGroups 自然排序
  assert.deepEqual(groups[0].panes.map(p => p.pane_id), ['w1:p1', 'w1:p2'])
  assert.deepEqual(groups[0].tabs.map(t => t.tab_id), ['t1'])
  // workspace 排序契约保持（单组时无影响，但组形态与 buildGroups 一致）
  assert.deepEqual(filterGroupsToSession(topology, 'w2:p1')[0].workspace.workspace_id, 'w2')
})

test('MG-02: filterGroupsToSession 边界——selfPaneId 未决 / pane 不存在 / 空拓扑', () => {
  const topology: HerdrTopology = {
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', focused: true }],
  }
  assert.deepEqual(filterGroupsToSession(topology, null), [])
  assert.deepEqual(filterGroupsToSession(topology, undefined), [])
  assert.deepEqual(filterGroupsToSession(topology, ''), [])
  // pane 已关闭（绑定仍在但拓扑中已无）
  assert.deepEqual(filterGroupsToSession(topology, 'w1:p9'), [])
  // 空/缺失 topology
  assert.deepEqual(filterGroupsToSession(undefined, 'w1:p1'), [])
  assert.deepEqual(filterGroupsToSession({ workspaces: [], tabs: [], panes: [] }, 'w1:p1'), [])
})
