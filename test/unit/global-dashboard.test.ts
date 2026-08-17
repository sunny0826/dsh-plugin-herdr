// 全局 Dashboard（design: dashboard-global v3 —— 插件-only：marker 注入 + 右侧
// surface）纯逻辑单测：marker 注入校验（祖先关系/包装场景）、rail 判定、surface
// 边界（含测量失败回退）、open store 状态机、global.* i18n（drift sentinel）。
// React 渲染 / DOM observer 行为属 CA-016 浏览器人工验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeGlobalSurfaceBounds,
  createGlobalDashboardStore,
  deriveMarkerPressed,
  isSidebarRail,
  NEW_SESSION_SELECTORS,
  REGION_AREA_SELECTOR,
  resolveSidebarMarker,
  SIDEBAR_MARKER_DATA,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH_THRESHOLD,
  type GlobalDashboardStore,
} from '../../src/client-logic.ts'
import { I18N_KEYS } from '../../src/web/i18n.ts'

function makeStore(): { store: GlobalDashboardStore; calls: number[] } {
  const store = createGlobalDashboardStore()
  const calls: number[] = []
  store.subscribe(() => calls.push(store.getOpen() ? 1 : 0))
  return { store, calls }
}

test('global store: starts closed; open/close/toggle flip state', () => {
  const { store } = makeStore()
  assert.equal(store.getOpen(), false)
  store.open()
  assert.equal(store.getOpen(), true)
  store.toggle()
  assert.equal(store.getOpen(), false)
  store.toggle()
  assert.equal(store.getOpen(), true)
  store.close()
  assert.equal(store.getOpen(), false)
})

test('global store: notify on change, silent on idempotent calls', () => {
  const { store, calls } = makeStore()
  store.open()
  store.open() // 幂等：无变化不通知
  store.close()
  store.close()
  assert.deepEqual(calls, [1, 0], '两次实际变化各通知一次')
})

test('global store: multiple subscribers all notified; unsubscribe stops', () => {
  const store = createGlobalDashboardStore()
  const a: number[] = []
  const b: number[] = []
  const offA = store.subscribe(() => a.push(store.getOpen() ? 1 : 0))
  store.subscribe(() => b.push(store.getOpen() ? 1 : 0))
  store.open()
  assert.deepEqual(a, [1])
  assert.deepEqual(b, [1])
  offA()
  store.close()
  assert.deepEqual(a, [1], '退订后不再通知')
  assert.deepEqual(b, [1, 0])
})

test('marker pressed: aria-pressed derives from the global open state (P1-1)', () => {
  assert.equal(deriveMarkerPressed(false), 'false')
  assert.equal(deriveMarkerPressed(true), 'true')
  // 派生值语义：toggle 按钮 open 时按下（active 样式经 [aria-pressed='true']）
  assert.equal(deriveMarkerPressed(true), 'true')
})

// ---------------------------------------------------------------------------
// Step 1：marker 注入校验（P1-1：祖先关系而非严格同父）
// ---------------------------------------------------------------------------

/** 模拟 DOM 祖先链：仅当 container 是 owner 且 node 属于 owner 子树时 contains 为真。 */
function makeContainsTree(owner: unknown, descendants: unknown[]) {
  return (container: unknown, node: unknown) => container === owner && (node === owner || descendants.includes(node))
}

test('marker: same-sidebar anchor (direct sibling) is injectable', () => {
  const parent = { tag: 'root' }
  const anchor = { tag: 'newSession' }
  const regionParent = parent
  const resolution = resolveSidebarMarker(regionParent, anchor, makeContainsTree(parent, [anchor]))
  assert.deepEqual(resolution, { ok: true, reason: null })
})

test('marker: wrapped anchor (Tooltip/future wrapper) still injectable via ancestry (P1-1)', () => {
  // New Session 可能被 Tooltip 等包装节点包裹——严格 parentElement 相等校验会误拒；
  // 祖先关系校验（regionParent.contains(anchor)）容忍任意层包装。
  const parent = { tag: 'root' }
  const wrapper = { tag: 'tooltip-wrapper' }
  const anchor = { tag: 'newSession' }
  const resolution = resolveSidebarMarker(parent, anchor, makeContainsTree(parent, [wrapper, anchor]))
  assert.deepEqual(resolution, { ok: true, reason: null }, '包装节点下的 anchor 仍属于同一 sidebar root')
  assert.notEqual(anchor, wrapper, '场景前提：anchor 的父节点是 wrapper 而非 regionParent')
})

test('marker: missing anchor/region or foreign anchor is not injectable', () => {
  const parent = { tag: 'root' }
  const otherSidebar = { tag: 'other-sidebar' }
  const anchor = { tag: 'newSession' }
  assert.deepEqual(resolveSidebarMarker(null, anchor, () => true), { ok: false, reason: 'no-region-area' })
  assert.deepEqual(resolveSidebarMarker(parent, null, () => true), { ok: false, reason: 'no-anchor' })
  assert.deepEqual(
    resolveSidebarMarker(parent, anchor, makeContainsTree(parent, [])),
    { ok: false, reason: 'not-same-sidebar' },
    'anchor 在别的 sidebar → 拒绝注入（防误插到其他容器）',
  )
  assert.deepEqual(
    resolveSidebarMarker(parent, anchor, makeContainsTree(otherSidebar, [anchor])),
    { ok: false, reason: 'not-same-sidebar' },
  )
})

test('anchors: New Session + regionArea selectors target the sidebar layout nodes', () => {
  // drift sentinel：DSH SidebarRoot 的 capsule 是 css.newSession + 双语 aria-label；
  // 浏览区是 css.regionArea（sidebar.workspaces 渲染点）。选择器改动需同步本契约。
  assert.ok(NEW_SESSION_SELECTORS.includes('[class*="newSession"]'))
  assert.ok(NEW_SESSION_SELECTORS.includes('[aria-label="新建会话"]'))
  assert.ok(NEW_SESSION_SELECTORS.includes('[aria-label="New session"]'))
  assert.equal(REGION_AREA_SELECTOR, '[class*="regionArea"]')
  assert.equal(SIDEBAR_MARKER_DATA, 'data-herdr-sidebar-button', 'marker 标识（幂等查重）')
})

// ---------------------------------------------------------------------------
// rail / surface 边界
// ---------------------------------------------------------------------------

test('rail: anchor width threshold separates rail from wide (marker 形态切换)', () => {
  assert.equal(isSidebarRail(36), true)
  assert.equal(isSidebarRail(SIDEBAR_RAIL_WIDTH_THRESHOLD), true, '阈值边界含 rail')
  assert.equal(isSidebarRail(61), false)
  assert.equal(isSidebarRail(208), false)
  assert.equal(SIDEBAR_RAIL_WIDTH, 36)
})

test('surface: covers the right work area from the sidebar right edge', () => {
  const bounds = computeGlobalSurfaceBounds({ left: 0, right: 240 }, 1280, 800)
  assert.deepEqual(bounds, { left: 240, top: 0, width: 1040, height: 800 }, '不覆盖 sidebar，全高')
  // rail 侧栏（56px）
  const rail = computeGlobalSurfaceBounds({ left: 0, right: 56 }, 800, 600)
  assert.deepEqual(rail, { left: 56, top: 0, width: 744, height: 600 })
})

test('surface: sidebar measurement failure falls back to full-frame coverage', () => {
  // P2-2：测量失败（sidebar 不可见）→ 全屏覆盖，保证 surface 完整可读、关闭入口可用；
  // sidebar 恢复后由 observer 重测回退。
  const bounds = computeGlobalSurfaceBounds(null, 1024, 768)
  assert.deepEqual(bounds, { left: 0, top: 0, width: 1024, height: 768 })
})

test('surface: sidebar wider than viewport clamps to zero width (no negative)', () => {
  const bounds = computeGlobalSurfaceBounds({ left: 0, right: 900 }, 800, 600)
  assert.equal(bounds.width, 0, '宽度不为负')
  assert.ok(bounds.left >= 0 && bounds.top >= 0)
})

test('global.* copy: marker button and surface labels are bilingual', () => {
  const keys = {
    title: I18N_KEYS['global.title'],
    close: I18N_KEYS['global.close'],
  }
  for (const [name, entry] of Object.entries(keys)) {
    assert.ok(entry.zh.length > 0, `global.${name} zh non-empty`)
    assert.ok(entry.en.length > 0, `global.${name} en non-empty`)
  }
  assert.equal(keys.title.zh, 'Herdr 仪表盘')
  assert.equal(keys.title.en, 'Herdr Dashboard')
})
