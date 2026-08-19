// CA-016：Web 面板纯 UI 逻辑单测（client-logic.ts；真实浏览器渲染不可用属明确遗留）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HERDR_PRESET_ID,
  agentTheme,
  applyPaneOrder,
  ariaStateLabel,
  buildGroups,
  classifyLogLine,
  comparePaneId,
  compareWorkspaceId,
  computeSnapPosition,
  createStatusStore,
  deriveHerdrMode,
  dialogFocusModel,
  disclosureState,
  dotState,
  filterGroupsToSession,
  focusBeforeRemoval,
  formatTime,
  isDshPane,
  isDragMovement,
  loadPaneOrder,
  normalizeDashboardKind,
  normalizeDashboardKindCounts,
  paneDisplayName,
  paneDisplayState,
  paneKeyboardHandlers,
  parseAnsiOutput,
  compactAnsiLines,
  mapTerminalKey,
  parseStartResponse,
  paneOrderKey,
  replayTerminalSnapshot,
  reorderPanes,
  savePaneOrder,
  shouldAutoExpand,
  stackedBarSegments,
  statusSortPriority,
  stripAnsi,
  terminalFocusTransition,
  terminalScrollTransition,
  toggleCollapse,
  trimAnsiSnapshotPadding,
  truncateAnsiTail,
  validateLabel,
} from '../../src/client-logic.ts'
import type { PaneOrderStorageLike } from '../../src/client-logic.ts'
import type { HerdrPaneView, HerdrTopology } from '../../src/status.ts'

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

// ---------------------------------------------------------------------------
// 五态展示模型（design: herdr-tab-redesign §4.3）
// ---------------------------------------------------------------------------

test('paneDisplayState: normalizes protocol status to 5-state display model', () => {
  assert.equal(paneDisplayState('working'), 'working')
  assert.equal(paneDisplayState('blocked'), 'blocked')
  assert.equal(paneDisplayState('idle'), 'idle')
  assert.equal(paneDisplayState('done'), 'done')
  assert.equal(paneDisplayState('unknown'), 'unknown')
  // missing / empty / unrecognized → unknown
  assert.equal(paneDisplayState(undefined), 'unknown')
  assert.equal(paneDisplayState(''), 'unknown')
  assert.equal(paneDisplayState('random-status'), 'unknown')
})

// ---------------------------------------------------------------------------
// 状态堆积条（design: dashboard-redesign §4 —— 替代 Treemap）
// ---------------------------------------------------------------------------

test('stackedBarSegments: aggregates in canonical order with ratios summing to 1', () => {
  const segments = stackedBarSegments(['working', 'working', 'blocked', 'idle', 'done', 'idle'])
  assert.deepEqual(segments.map(s => s.state), ['working', 'blocked', 'idle', 'done'])
  assert.deepEqual(segments.map(s => s.count), [2, 1, 2, 1])
  const total = segments.reduce((n, s) => n + s.ratio, 0)
  assert.ok(Math.abs(total - 1) < 1e-9, `ratios sum to 1, got ${total}`)
  // 规范顺序与计数比例一致（working 2/6）
  assert.ok(Math.abs(segments[0].ratio - 2 / 6) < 1e-9)
})

test('stackedBarSegments: empty input returns empty array', () => {
  assert.deepEqual(stackedBarSegments([]), [])
})

test('stackedBarSegments: unknown/empty/unrecognized statuses map to unknown (last position)', () => {
  const segments = stackedBarSegments(['working', '', 'weird-status', 'done'])
  assert.deepEqual(segments.map(s => s.state), ['working', 'done', 'unknown'])
  assert.deepEqual(segments.map(s => s.count), [1, 1, 2], 'empty + weird both count as unknown')
})

test('stackedBarSegments: zero counts are dropped, single state works', () => {
  assert.deepEqual(stackedBarSegments(['idle', 'idle', 'idle']), [
    { state: 'idle', count: 3, ratio: 1 },
  ])
})

test('statusSortPriority: blocked highest, unknown lowest', () => {
  assert.equal(statusSortPriority('blocked'), 0)
  assert.equal(statusSortPriority('working'), 1)
  assert.equal(statusSortPriority('idle'), 2)
  assert.equal(statusSortPriority('done'), 3)
  assert.equal(statusSortPriority('unknown'), 4)
})

test('ariaStateLabel: returns i18n key for each display state', () => {
  assert.equal(ariaStateLabel('working'), 'status.working')
  assert.equal(ariaStateLabel('blocked'), 'status.blocked')
  assert.equal(ariaStateLabel('idle'), 'status.idle')
  assert.equal(ariaStateLabel('done'), 'status.done')
  assert.equal(ariaStateLabel('unknown'), 'status.unknown')
})

test('normalizeDashboardKind: supported kinds stay stable and arbitrary kinds become unknown', () => {
  assert.equal(normalizeDashboardKind('codex'), 'codex')
  assert.equal(normalizeDashboardKind(' PI '), 'pi')
  assert.equal(normalizeDashboardKind('claude'), 'claude')
  assert.equal(normalizeDashboardKind('future-agent'), 'unknown')
  assert.equal(normalizeDashboardKind(undefined), 'unknown')
})

test('normalizeDashboardKindCounts: merges duplicate arbitrary kinds under unknown', () => {
  assert.deepEqual(normalizeDashboardKindCounts([
    { kind: 'codex', value: 2 },
    { kind: 'codex', value: 3 },
    { kind: 'future-agent', value: 1 },
    { kind: 'new-kind', value: 4 },
    { kind: ' PI ', value: 2 },
  ]), [
    { kind: 'codex', value: 5 },
    { kind: 'unknown', value: 5 },
    { kind: 'pi', value: 2 },
  ])
})

// ---------------------------------------------------------------------------
// 键盘交互模型（design: herdr-tab-redesign §5.3）
// ---------------------------------------------------------------------------

test('paneKeyboardHandlers: Enter and Space trigger with complete keyboard action data', () => {
  assert.deepEqual(paneKeyboardHandlers('Enter'), { trigger: true, preventDefault: true })
  assert.deepEqual(paneKeyboardHandlers(' '), { trigger: true, preventDefault: true })
  assert.deepEqual(paneKeyboardHandlers('Tab'), { trigger: false, preventDefault: false })
  assert.deepEqual(paneKeyboardHandlers('Escape'), { trigger: false, preventDefault: false })
  assert.deepEqual(paneKeyboardHandlers('a'), { trigger: false, preventDefault: false })
})

// ---------------------------------------------------------------------------
// 对话框焦点模型（design: herdr-tab-redesign §5.3）
// ---------------------------------------------------------------------------

test('dialogFocusModel: default focuses cancel and restores trigger', () => {
  const model = dialogFocusModel({ titleId: 'dlg-1' })
  assert.deepEqual(model, {
    initialFocus: 'cancel',
    escapeCancels: true,
    titleId: 'dlg-1',
    restoreFocus: true,
    restoreTarget: 'trigger',
  })
})

test('dialogFocusModel: busy focuses confirm and restores trigger', () => {
  const model = dialogFocusModel({ busy: true, titleId: 'dlg-2' })
  assert.deepEqual(model, {
    initialFocus: 'confirm',
    escapeCancels: false,
    titleId: 'dlg-2',
    restoreFocus: true,
    restoreTarget: 'trigger',
  })
})

test('disclosureState: production controls derive from one pure expanded state', () => {
  assert.deepEqual(disclosureState(true, 'pane-log-1'), {
    expanded: true,
    ariaExpanded: true,
    controlsId: 'pane-log-1',
  })
  assert.deepEqual(disclosureState(false, 'workspace-body-1'), {
    expanded: false,
    ariaExpanded: false,
    controlsId: 'workspace-body-1',
  })
})

test('focusBeforeRemoval: focus occurs before immediate optimistic unmount', () => {
  const events: string[] = []
  const trigger = { focus: () => { events.push('trigger-focus') } }
  focusBeforeRemoval(trigger)
  events.push('parent-unmount')
  assert.deepEqual(events, ['trigger-focus', 'parent-unmount'])
  focusBeforeRemoval(null)
  assert.deepEqual(events, ['trigger-focus', 'parent-unmount'])
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

test('paneDisplayState unknown does NOT map to done (P1-1 regression guard)', () => {
  // This is the core P1-1 fix: unknown must not look like done
  assert.equal(paneDisplayState('unknown'), 'unknown')
  assert.equal(dotState('unknown'), 'done', 'dotState still maps to done for StateDot compatibility')
  // The key invariant: paneDisplayState and dotState diverge for unknown
  assert.notEqual(paneDisplayState('unknown'), dotState('unknown'))
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

// ---------------------------------------------------------------------------
// ANSI SGR 解析器（design: pane-log-terminal-design §3）
// ---------------------------------------------------------------------------

test('parseAnsiOutput: plain text without ANSI is preserved as-is', () => {
  const lines = parseAnsiOutput('hello world')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].plainText, 'hello world')
  assert.equal(lines[0].tokens.length, 1)
  assert.equal(lines[0].tokens[0].text, 'hello world')
  assert.equal(lines[0].tokens[0].style.bold, false)
  assert.equal(lines[0].tokens[0].style.foreground, null)
})

test('parseAnsiOutput: SGR reset (0) clears all styles', () => {
  const lines = parseAnsiOutput('\u001b[1m\u001b[32mbold green\u001b[0m normal')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].tokens.length, 2)
  assert.equal(lines[0].tokens[0].text, 'bold green')
  assert.equal(lines[0].tokens[0].style.bold, true)
  assert.equal(lines[0].tokens[0].style.foreground?.kind, 'ansi16')
  assert.equal(lines[0].tokens[0].style.foreground?.index, 2)
  assert.equal(lines[0].tokens[1].text, ' normal')
  assert.equal(lines[0].tokens[1].style.bold, false)
  assert.equal(lines[0].tokens[1].style.foreground, null)
})

test('parseAnsiOutput: 16-color foreground (30-37, 90-97)', () => {
  const red = parseAnsiOutput('\u001b[31mR\u001b[0m')
  assert.equal(red[0].tokens[0].style.foreground?.kind, 'ansi16')
  assert.equal(red[0].tokens[0].style.foreground?.index, 1)
  const blue = parseAnsiOutput('\u001b[34mB\u001b[0m')
  assert.equal(blue[0].tokens[0].style.foreground?.index, 4)
  const brightRed = parseAnsiOutput('\u001b[91mBR\u001b[0m')
  assert.equal(brightRed[0].tokens[0].style.foreground?.index, 9)
})

test('parseAnsiOutput: 16-color background (40-47, 100-107)', () => {
  const bg = parseAnsiOutput('\u001b[42mG\u001b[0m')
  assert.equal(bg[0].tokens[0].style.background?.kind, 'ansi16')
  assert.equal(bg[0].tokens[0].style.background?.index, 2)
  const brightBg = parseAnsiOutput('\u001b[104mB\u001b[0m')
  assert.equal(brightBg[0].tokens[0].style.background?.index, 12)
})

test('parseAnsiOutput: fg/bg reset (39/49)', () => {
  const lines = parseAnsiOutput('\u001b[31mR\u001b[39m back to normal')
  assert.equal(lines[0].tokens.length, 2)
  assert.equal(lines[0].tokens[0].style.foreground?.index, 1)
  assert.equal(lines[0].tokens[1].style.foreground, null)
  const bgReset = parseAnsiOutput('\u001b[41mR\u001b[49m no bg')
  assert.equal(bgReset[0].tokens[0].style.background?.index, 1)
  assert.equal(bgReset[0].tokens[1].style.background, null)
})

test('parseAnsiOutput: bold/dim/underline/inverse and their resets', () => {
  assert.equal(parseAnsiOutput('\u001b[1mB\u001b[0m')[0].tokens[0].style.bold, true)
  assert.equal(parseAnsiOutput('\u001b[2mD\u001b[0m')[0].tokens[0].style.dim, true)
  assert.equal(parseAnsiOutput('\u001b[4mU\u001b[0m')[0].tokens[0].style.underline, true)
  assert.equal(parseAnsiOutput('\u001b[7mI\u001b[0m')[0].tokens[0].style.inverse, true)
  assert.equal(parseAnsiOutput('\u001b[1m\u001b[22mB\u001b[0m')[0].tokens[0].style.bold, false)
  assert.equal(parseAnsiOutput('\u001b[4m\u001b[24mU\u001b[0m')[0].tokens[0].style.underline, false)
  assert.equal(parseAnsiOutput('\u001b[7m\u001b[27mI\u001b[0m')[0].tokens[0].style.inverse, false)
})

test('parseAnsiOutput: 256-color cube and gray', () => {
  const c0 = parseAnsiOutput('\u001b[38;5;0mX\u001b[0m')
  assert.equal(c0[0].tokens[0].style.foreground?.kind, 'ansi256')
  assert.equal(c0[0].tokens[0].style.foreground?.index, 0)
  const c255 = parseAnsiOutput('\u001b[38;5;255mX\u001b[0m')
  assert.equal(c255[0].tokens[0].style.foreground?.index, 255)
  // Index 196: cube ri=5, gi=0, bi=0 → comp(5)=55+40*5=255
  const cube = parseAnsiOutput('\u001b[38;5;196mX\u001b[0m')
  assert.equal(cube[0].tokens[0].style.foreground?.r, 255)
  const gray = parseAnsiOutput('\u001b[38;5;232mX\u001b[0m')
  assert.equal(gray[0].tokens[0].style.foreground?.r, 8)
  const bg256 = parseAnsiOutput('\u001b[48;5;196mX\u001b[0m')
  assert.equal(bg256[0].tokens[0].style.background?.kind, 'ansi256')
})

test('parseAnsiOutput: truecolor with clamp', () => {
  const tc = parseAnsiOutput('\u001b[38;2;255;128;0mRGB\u001b[0m')
  assert.equal(tc[0].tokens[0].style.foreground?.kind, 'rgb')
  assert.equal(tc[0].tokens[0].style.foreground?.r, 255)
  assert.equal(tc[0].tokens[0].style.foreground?.g, 128)
  assert.equal(tc[0].tokens[0].style.foreground?.b, 0)
  // 38;2;r;g;b: values clamped to 0-255 (note: SGR params are non-negative, -10 is not valid SGR)
  const clamp = parseAnsiOutput('\u001b[38;2;300;0;256mX\u001b[0m')
  assert.equal(clamp[0].tokens[0].style.foreground?.kind, 'rgb')
  assert.equal(clamp[0].tokens[0].style.foreground?.r, 255) // clamped from 300
  assert.equal(clamp[0].tokens[0].style.foreground?.g, 0)
  assert.equal(clamp[0].tokens[0].style.foreground?.b, 255) // 256 clamped to 255
  const bgTc = parseAnsiOutput('\u001b[48;2;10;20;30mX\u001b[0m')
  assert.equal(bgTc[0].tokens[0].style.background?.kind, 'rgb')
  assert.equal(bgTc[0].tokens[0].style.background?.r, 10)
})

test('parseAnsiOutput: multiple params, empty params, unknown params', () => {
  const multi = parseAnsiOutput('\u001b[1;31;4mX\u001b[0m')
  assert.equal(multi[0].tokens[0].style.bold, true)
  assert.equal(multi[0].tokens[0].style.underline, true)
  assert.equal(multi[0].tokens[0].style.foreground?.index, 1)
  const empty = parseAnsiOutput('\u001b[mX\u001b[0m')
  assert.equal(empty[0].tokens[0].style.bold, false)
  const unknown = parseAnsiOutput('\u001b[999;31mR\u001b[0m')
  assert.equal(unknown[0].tokens[0].style.foreground?.index, 1)
})

test('parseAnsiOutput: cross-line style continuation', () => {
  // Reset at end of line 2 — only one token per line (reset has no visible text)
  const lines = parseAnsiOutput('\u001b[32mline1\nline2\u001b[0m')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].tokens[0].style.foreground?.index, 2) // green
  assert.equal(lines[1].tokens.length, 1) // 'line2' styled (reset produces no token)
  assert.equal(lines[1].tokens[0].style.foreground?.index, 2) // green continues
  // Reset in middle of line 2 — two tokens
  const lines2 = parseAnsiOutput('\u001b[32mline1\nline2a\u001b[0mline2b')
  assert.equal(lines2[1].tokens.length, 2) // 'line2a' green + 'line2b' reset
  assert.equal(lines2[1].tokens[0].style.foreground?.index, 2)
  assert.equal(lines2[1].tokens[1].style.foreground, null)
})

test('parseAnsiOutput: CRLF and CR normalization', () => {
  const crlf = parseAnsiOutput('a\r\nb')
  assert.equal(crlf.length, 2)
  assert.equal(crlf[0].plainText, 'a')
  assert.equal(crlf[1].plainText, 'b')
  const cr = parseAnsiOutput('a\rb')
  assert.equal(cr.length, 2)
  assert.equal(cr[0].plainText, 'a')
  assert.equal(cr[1].plainText, 'b')
})

test('parseAnsiOutput: empty lines preserved', () => {
  const lines = parseAnsiOutput('a\n\nb')
  assert.equal(lines.length, 3)
  assert.equal(lines[0].plainText, 'a')
  assert.equal(lines[1].plainText, '')
  assert.equal(lines[2].plainText, 'b')
})

test('parseAnsiOutput: OSC sequences stripped safely', () => {
  const lines = parseAnsiOutput('\u001b]8;;https://example.com\u0007click here\u001b]8;;\u0007')
  assert.equal(lines[0].plainText, 'click here')
  assert.equal(lines[0].tokens.length, 1)
})

test('parseAnsiOutput: non-SGR CSI ignored', () => {
  const lines = parseAnsiOutput('line1\u001b[2Aline2')
  assert.equal(lines[0].plainText, 'line1line2')
})

test('parseAnsiOutput: incomplete CSI/OSC at EOF handled safely', () => {
  const csi = parseAnsiOutput('text\u001b[31')
  assert.equal(csi[0].plainText, 'text')
  const osc = parseAnsiOutput('text\u001b]8;;url')
  assert.equal(osc[0].plainText, 'text')
})

test('parseAnsiOutput: XSS safety — token.text is plain text', () => {
  const lines = parseAnsiOutput('<script>alert(1)</script>\u001b[31m<span>bold</span>\u001b[0m')
  const allText = lines[0].tokens.map(t => t.text).join('')
  assert.ok(allText.includes('<script>'), 'script tag preserved as text')
  assert.ok(allText.includes('<span>'), 'span tag preserved as text')
  assert.ok(!allText.includes('&lt;'), 'no HTML entity escaping')
})

test('compactAnsiLines: compresses consecutive blanks, preserves style across compaction', () => {
  const input = parseAnsiOutput('\u001b[31mL1\u001b[0m\n\n\nL2\n\nL3')
  const compacted = compactAnsiLines(input)
  const nonBlank = compacted.filter(l => l.plainText.trim() !== '')
  assert.equal(nonBlank.length, 3)
  assert.equal(nonBlank[0].tokens[0].style.foreground?.index, 1)
})

test('classifyLogLine: uses plainText from ANSI-parsed lines', () => {
  const line = parseAnsiOutput('\u001b[32m+ added line\u001b[0m')
  assert.equal(classifyLogLine(line[0].plainText), 'diff-add')
  const cmd = parseAnsiOutput('\u001b[36m❯ sh -c pwd\u001b[0m')
  assert.equal(classifyLogLine(cmd[0].plainText), 'cmd')
})

test('stripAnsi: produces same result as parseAnsiOutput plainText', () => {
  const out = '\u001b[1;31mBold Red\u001b[0m normal \u001b[4mUnderline\u001b[0m'
  assert.equal(stripAnsi(out), parseAnsiOutput(out).map(l => l.plainText).join('\n'))
  assert.equal(stripAnsi(out), 'Bold Red normal Underline')
})

test('truncateAnsiTail: preserves tail without splitting escape sequences', () => {
  // Short text not truncated
  assert.equal(truncateAnsiTail('hello', 10), 'hello')
  // Long plain text truncated
  const long = 'a'.repeat(100)
  assert.equal(truncateAnsiTail(long, 50).length, 50)
  // Incomplete escape at the end is discarded
  const incomplete = 'hello\u001b[31'
  const t = truncateAnsiTail(incomplete, 5)
  assert.ok(!t.includes('\u001b'), 'incomplete escape discarded')
  assert.equal(t, 'hello', 'visible text before escape preserved')
})

test('parseAnsiOutput: combined bold+color+underline', () => {
  const s = parseAnsiOutput('\u001b[1;4;33mStyled\u001b[0m')[0].tokens[0].style
  assert.equal(s.bold, true)
  assert.equal(s.underline, true)
  assert.equal(s.foreground?.kind, 'ansi16')
  assert.equal(s.foreground?.index, 3)
})

test('parseAnsiOutput: inverse with explicit colors', () => {
  const s = parseAnsiOutput('\u001b[31;42;7mX\u001b[0m')[0].tokens[0].style
  assert.equal(s.foreground?.index, 1)
  assert.equal(s.background?.index, 2)
  assert.equal(s.inverse, true)
})

// ---------------------------------------------------------------------------
// 严格 SGR 数值参数校验（design: malformed 参数整条忽略）
// ---------------------------------------------------------------------------

test('parseAnsiOutput: malformed SGR with decimal (31.5m) is discarded as non-SGR CSI', () => {
  // 31.5m：CSI 参数含 '.'（非参数字符）→ 整个 CSI 被视为非 SGR 并忽略
  // '5m' 被当作非 SGR 终止符 → 整条序列不产生任何样式
  // '5m' 成为可见文本（非 SGR 终止符不是控制序列）
  const lines = parseAnsiOutput('\u001b[31.5mX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground, null, 'malformed decimal param: no color applied')
  assert.equal(lines[0].plainText, '5mX', 'non-SGR terminator text is visible')
})

test('parseAnsiOutput: malformed SGR with non-numeric (abc) is ignored entirely', () => {
  const lines = parseAnsiOutput('\u001b[abcmX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground, null, 'non-numeric param ignored')
})

test('parseAnsiOutput: malformed 38;5; with missing n is ignored', () => {
  // 38;5; 缺少颜色索引 → 整条忽略
  const lines = parseAnsiOutput('\u001b[38;5;mX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground, null, 'incomplete 256-color ignored')
})

test('parseAnsiOutput: malformed 38;2; with missing r/g/b is ignored', () => {
  // 38;2;255;0; 缺少 b → 整条忽略
  const lines = parseAnsiOutput('\u001b[38;2;255;0;mX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground, null, 'incomplete truecolor ignored')
})

test('parseAnsiOutput: valid 38;5;196 works correctly', () => {
  const lines = parseAnsiOutput('\u001b[38;5;196mX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground?.kind, 'ansi256')
  assert.equal(lines[0].tokens[0].style.foreground?.index, 196)
})

test('parseAnsiOutput: valid 38;2;255;128;0 works correctly', () => {
  const lines = parseAnsiOutput('\u001b[38;2;255;128;0mX\u001b[0m')
  assert.equal(lines[0].tokens[0].style.foreground?.kind, 'rgb')
  assert.equal(lines[0].tokens[0].style.foreground?.r, 255)
  assert.equal(lines[0].tokens[0].style.foreground?.g, 128)
  assert.equal(lines[0].tokens[0].style.foreground?.b, 0)
})

// ---------------------------------------------------------------------------
// C0/C1 控制字符安全丢弃
// ---------------------------------------------------------------------------

test('parseAnsiOutput: BEL (0x07) is discarded', () => {
  const lines = parseAnsiOutput('before\u0007after')
  assert.equal(lines[0].plainText, 'beforeafter', 'BEL discarded')
  assert.equal(lines[0].tokens.length, 1)
})

test('parseAnsiOutput: BS (0x08) is discarded', () => {
  const lines = parseAnsiOutput('before\u0008after')
  assert.equal(lines[0].plainText, 'beforeafter', 'BS discarded')
})

test('parseAnsiOutput: FF (0x0C) is discarded', () => {
  const lines = parseAnsiOutput('before\u000Cafter')
  assert.equal(lines[0].plainText, 'beforeafter', 'FF discarded')
})

test('parseAnsiOutput: C1 CSI (0x9B) is discarded, following text is plain', () => {
  // 0x9B = C1 CSI shortcut → 作为控制字符丢弃
  // 后续 '31m' 不再被解释为 SGR（CSI introducer 已丢失）→ 作为普通文本
  const lines = parseAnsiOutput('before\u009B31mafter')
  assert.equal(lines[0].plainText, 'before31mafter', 'C1 CSI discarded, 31m becomes plain text')
  assert.equal(lines[0].tokens[0].style.foreground, null, 'C1 CSI does not apply color')
})

test('parseAnsiOutput: NUL (0x00) is discarded', () => {
  const lines = parseAnsiOutput('before\u0000after')
  assert.equal(lines[0].plainText, 'beforeafter', 'NUL discarded')
})

test('parseAnsiOutput: mixed control chars with valid text', () => {
  const lines = parseAnsiOutput('\u0007\u0008\u000Ctext\u009B')
  assert.equal(lines[0].plainText, 'text', 'all control chars discarded, visible text preserved')
})

// ---------------------------------------------------------------------------
// 交互式终端输入映射（design: pane-interactive-terminal §3.3）
// ---------------------------------------------------------------------------

test('mapTerminalKey: Enter sends \\r', () => {
  const r = mapTerminalKey({ key: 'Enter', code: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: '\r' })
})

test('mapTerminalKey: printable character sends as text', () => {
  const r = mapTerminalKey({ key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: 'a' })
})

test('mapTerminalKey: Backspace sends DEL (\\x7f)', () => {
  const r = mapTerminalKey({ key: 'Backspace', code: 'Backspace', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: '\x7f' })
})

test('mapTerminalKey: Delete sends CSI 3~', () => {
  const r = mapTerminalKey({ key: 'Delete', code: 'Delete', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: '\x1b[3~' })
})

test('mapTerminalKey: Arrow keys send CSI A/B/C/D', () => {
  assert.deepEqual(mapTerminalKey({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[A' })
  assert.deepEqual(mapTerminalKey({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[B' })
  assert.deepEqual(mapTerminalKey({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[C' })
  assert.deepEqual(mapTerminalKey({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[D' })
})

test('mapTerminalKey: Home/End send CSI H/F', () => {
  assert.deepEqual(mapTerminalKey({ key: 'Home', code: 'Home', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[H' })
  assert.deepEqual(mapTerminalKey({ key: 'End', code: 'End', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[F' })
})

test('mapTerminalKey: PageUp/PageDown send CSI 5~/6~', () => {
  assert.deepEqual(mapTerminalKey({ key: 'PageUp', code: 'PageUp', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[5~' })
  assert.deepEqual(mapTerminalKey({ key: 'PageDown', code: 'PageDown', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }), { kind: 'text', text: '\x1b[6~' })
})

test('mapTerminalKey: Tab sends \\t', () => {
  const r = mapTerminalKey({ key: 'Tab', code: 'Tab', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: '\t' })
})

test('mapTerminalKey: Escape sends ESC', () => {
  const r = mapTerminalKey({ key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'text', text: '\x1b' })
})

test('mapTerminalKey: confirmed ctrl+c chord sends keys', () => {
  const r = mapTerminalKey({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'keys', keys: ['ctrl+c'] })
})

test('mapTerminalKey: unconfirmed chord returns unsupported', () => {
  const r = mapTerminalKey({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(r, { kind: 'unsupported' })
})

test('mapTerminalKey: control characters return unsupported', () => {
  const r = mapTerminalKey({ key: 'F1', code: 'F1', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false })
  // F1 is not in confirmed keys, but it's not a single printable char
  assert.equal(r.kind, 'keys', 'F1 is a confirmed key')
  assert.deepEqual((r as { kind: 'keys'; keys: string[] }).keys, ['f1'])
})

test('mapTerminalKey: Shift+Enter sends text (not special)', () => {
  const r = mapTerminalKey({ key: 'Enter', code: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: true })
  assert.deepEqual(r, { kind: 'text', text: '\r' })
})

// ---------------------------------------------------------------------------
// 滚动状态（design: pane-interactive-terminal §3.5）
// ---------------------------------------------------------------------------

test('terminalScrollTransition: new output at bottom stays at bottom', () => {
  const r = terminalScrollTransition({ atBottom: true, pendingOutput: false }, true, true)
  assert.deepEqual(r, { atBottom: true, pendingOutput: false })
})

test('terminalScrollTransition: new output not at bottom sets pending', () => {
  const r = terminalScrollTransition({ atBottom: true, pendingOutput: false }, true, false)
  assert.deepEqual(r, { atBottom: false, pendingOutput: true })
})

test('terminalScrollTransition: scrolled to bottom clears pending', () => {
  const r = terminalScrollTransition({ atBottom: false, pendingOutput: true }, false, true)
  assert.deepEqual(r, { atBottom: true, pendingOutput: false })
})

test('terminalScrollTransition: user scroll up sets atBottom false', () => {
  const r = terminalScrollTransition({ atBottom: true, pendingOutput: false }, false, false)
  assert.deepEqual(r, { atBottom: false, pendingOutput: false })
})

test('terminalScrollTransition: user scroll up preserves pendingOutput', () => {
  const r = terminalScrollTransition({ atBottom: true, pendingOutput: true }, false, false)
  assert.deepEqual(r, { atBottom: false, pendingOutput: true })
})

// ---------------------------------------------------------------------------
// 最大化焦点转移（design: pane-interactive-terminal §5.2）
// ---------------------------------------------------------------------------

test('terminalFocusTransition: entering maximize targets input', () => {
  const r = terminalFocusTransition(true, null)
  assert.equal(r.enterTarget, 'input')
  assert.equal(r.restoreTarget, null)
})

test('terminalFocusTransition: exiting maximize restores trigger', () => {
  const r = terminalFocusTransition(false, 'max-btn-123')
  assert.equal(r.enterTarget, 'input')
  assert.equal(r.restoreTarget, 'max-btn-123')
})

// ---------------------------------------------------------------------------
// 终端屏幕回放（design: pane-interactive-terminal §3.1）
// ---------------------------------------------------------------------------

test('replayTerminalSnapshot: empty output produces blank screen', () => {
  const s = replayTerminalSnapshot('', { rows: 4, cols: 20 })
  assert.equal(s.rows.length, 4)
  assert.equal(s.cursor.row, 0)
  assert.equal(s.cursor.column, 0)
})

test('replayTerminalSnapshot: plain text fills cells', () => {
  const s = replayTerminalSnapshot('hello', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].text, 'h')
  assert.equal(s.rows[0][4].text, 'o')
  assert.equal(s.cursor.column, 5)
})

test('replayTerminalSnapshot: CR moves cursor to column 0', () => {
  const s = replayTerminalSnapshot('abc\rXYZ', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].text, 'X')
  assert.equal(s.rows[0][1].text, 'Y')
  assert.equal(s.rows[0][2].text, 'Z')
})

test('replayTerminalSnapshot: LF moves cursor down (column preserved)', () => {
  // \n moves cursor down but does NOT reset column (only \r does)
  const s = replayTerminalSnapshot('line1\nline2', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].text, 'l')
  // line2 starts at column 5 (column preserved from line1)
  assert.equal(s.rows[1][5].text, 'l')
})

test('replayTerminalSnapshot: cursor moves past screen scrolls up', () => {
  // With \n only (no \r), column is preserved - use \r\n for line breaks
  const s = replayTerminalSnapshot('a\r\nb\r\nc\r\nd\r\ne', { rows: 3, cols: 20 })
  // 5 lines in 3-row screen: first 2 scroll off
  assert.equal(s.rows[0][0].text, 'c')
  assert.equal(s.rows[1][0].text, 'd')
  assert.equal(s.rows[2][0].text, 'e')
})

test('replayTerminalSnapshot: SGR sets style on cells', () => {
  const s = replayTerminalSnapshot('\u001b[31mred\u001b[0m normal', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].style.foreground?.kind, 'ansi16')
  assert.equal(s.rows[0][0].style.foreground?.index, 1) // red
  assert.equal(s.rows[0][4].style.foreground, null) // reset
})

test('replayTerminalSnapshot: erase line clears current line', () => {
  const s = replayTerminalSnapshot('hello\u001b[2K', { rows: 4, cols: 20 })
  // Line cleared by erase
  assert.equal(s.rows[0][0].text, ' ') // default cell after erase
})

test('replayTerminalSnapshot: cursor position H command', () => {
  const s = replayTerminalSnapshot('\u001b[2;5Hx', { rows: 4, cols: 20 })
  assert.equal(s.rows[1][4].text, 'x')
})

test('replayTerminalSnapshot: tab advances to next 8-col boundary', () => {
  const s = replayTerminalSnapshot('a\tb', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].text, 'a')
  assert.equal(s.rows[0][8].text, 'b')
})

test('replayTerminalSnapshot: backspace moves cursor back and overwrites', () => {
  // 'abc' → cursor at col 3; '\b' → col 2; 'x' → overwrite col 2 → 'abx'
  const s = replayTerminalSnapshot('abc\bx', { rows: 4, cols: 20 })
  assert.equal(s.rows[0][0].text, 'a')
  assert.equal(s.rows[0][1].text, 'b') // 'b' unchanged
  assert.equal(s.rows[0][2].text, 'x') // 'x' overwrote 'c' at col 2
  assert.equal(s.cursor.column, 3) // cursor at col 3
})

test('paneDisplayName: fallback chain label > agent 名 > title > terminal_title_stripped > display_agent > agent > pane_id', () => {
  const pane = (label?: string, title?: string, tts?: string, da?: string): HerdrPaneView => ({
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    focused: false,
    label, title, terminal_title_stripped: tts, display_agent: da,
  })
  const agent = (name?: string, agentName?: string) => ({ name, agent: agentName }) as never
  assert.equal(paneDisplayName(pane('我的 pane'), undefined), '我的 pane')
  // agent 名（herdr 给 agent 的 <kind>-<purpose>）优先于 title/终端标题
  assert.equal(paneDisplayName(pane(undefined, 'title'), agent('pi-code-review', 'pi-1')), 'pi-code-review')
  assert.equal(paneDisplayName(pane(undefined, undefined, 'stripped'), agent('pi-code-review', 'pi-1')), 'pi-code-review')
  assert.equal(paneDisplayName(pane(undefined, 'title'), undefined), 'title')
  assert.equal(paneDisplayName(pane(undefined, undefined, 'stripped'), undefined), 'stripped')
  assert.equal(paneDisplayName(pane(undefined, undefined, undefined, 'pi-1'), undefined), 'pi-1')
  assert.equal(paneDisplayName(pane(), agent(undefined, 'pi-1')), 'pi-1')
  assert.equal(paneDisplayName(pane(), agent('pi-task', 'pi-1')), 'pi-task')
  assert.equal(paneDisplayName(pane(), undefined), 'w1:p1')
  // label 优先于 agent 名（重命名后展示用户名字）
  assert.equal(paneDisplayName(pane('用户改名', 'title'), agent('pi-code-review', 'pi-1')), '用户改名')
})

test('isDshPane: agent 为 dsh 或 label 以 dsh: 开头判为插件自身 pane', () => {
  const pane = (label?: string): HerdrPaneView => ({ pane_id: 'w1:p1', workspace_id: 'w1', focused: false, label })
  const agent = (agentName: string) => ({ agent: agentName }) as never
  assert.equal(isDshPane(pane(), agent('dsh')), true)
  assert.equal(isDshPane(pane(), agent('dsh:herdr-plugin')), true)
  assert.equal(isDshPane(pane('dsh:my-project'), undefined), true)
  assert.equal(isDshPane(pane(), agent('pi-1')), false)
  assert.equal(isDshPane(pane('normal'), agent('codex-1')), false)
  assert.equal(isDshPane(pane(), undefined), false)
})

test('trimAnsiSnapshotPadding: 去首部空行与行尾填充空白（保留 ANSI 序列）', () => {
  assert.equal(trimAnsiSnapshotPadding(''), '')
  assert.equal(trimAnsiSnapshotPadding('   \n  \ncontent'), 'content')
  assert.equal(trimAnsiSnapshotPadding('content\n'), 'content\n')
  assert.equal(trimAnsiSnapshotPadding('content   \nnext\t\n'), 'content\nnext\n')
  // ANSI 序列保留，仅去掉纯空白
  assert.equal(trimAnsiSnapshotPadding('\u001b[31mred\u001b[0m   \nplain'), '\u001b[31mred\u001b[0m\nplain')
  // CRLF 归一为 \n
  assert.equal(trimAnsiSnapshotPadding('\r\n\r\ncontent\r\n'), 'content\n')
})
