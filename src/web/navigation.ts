// Herdr Tab 跳转与当前会话 id：共享的模块级可变状态。
// 拆出独立模块以避免组件间循环 import（apply 注入 getSessionId，HerdrPaneList 读取）。
// 可变状态以闭包 + 访问器函数封装：ES 模块的 import 绑定不可重新赋值，
// 故跨模块读写必须经函数（行为与拆分前同模块内的 let 直写一致）。

import { derivePaneNavState, type PaneNavState } from '../client-logic.ts'

/** 待定位的 pane（Herdr 视图挂载时消费；面板点击 → 切 tab 的时序兜底）。 */
let pendingFocusPane: string | null = null

export function getPendingFocusPane(): string | null {
  return pendingFocusPane
}

export function setPendingFocusPane(v: string | null): void {
  pendingFocusPane = v
}

/** 在当前 DOM 中查找 Herdr tab 并点击（跨会话切换后目标 tab 未渲染时用 defer 版）。 */
function findAndClickHerdrTab(): HTMLElement | null {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(t => (t.textContent ?? '').trim() === 'Herdr')
  if (tab instanceof HTMLElement) {
    tab.click()
    return tab
  }
  return null
}

export function focusPaneInHerdrTab(paneId: string): void {
  pendingFocusPane = paneId
  // 切换到 Herdr 视图 tab（模拟用户点击 header tab）
  findAndClickHerdrTab()
  // 事件广播：Herdr 视图已挂载时直接定位
  document.dispatchEvent(new CustomEvent('herdr:focus-pane', { detail: { paneId } }))
}

/** 当前会话 id 读取器（apply 时经 sessions 服务注入）。 */
let getSessionIdReader: () => string | undefined = () => undefined

export function getSessionId(): string | undefined {
  return getSessionIdReader()
}

export function setSessionIdReader(r: () => string | undefined): void {
  getSessionIdReader = r
}

/** 会话切换读取器（apply 时经 sessions.open 注入；跨会话跳转用）。 */
let openSessionReader: (id: string) => void = () => {}

export function setSessionOpener(fn: (id: string) => void): void {
  openSessionReader = fn
}

export function openSession(id: string): void {
  openSessionReader(id)
}

/**
 * 跨会话切换后延迟定位 Herdr tab：目标会话的 tablist/Herrdr 视图尚未渲染，
 * 短间隔轮询（≤300ms，最多 maxAttempts 次）直到找到 Herdr tab 再点击并广播
 * 聚焦事件；超时（目标非 herdr 模式）静默放弃——会话已切换即达成主目标。
 */
export function deferFocusHerdrTab(paneId: string, maxAttempts = 20): void {
  let attempts = 0
  const tryFocus = (): boolean => {
    const tab = findAndClickHerdrTab()
    if (tab) {
      document.dispatchEvent(new CustomEvent('herdr:focus-pane', { detail: { paneId } }))
      return true
    }
    return false
  }
  if (tryFocus()) return
  const timer = setInterval(() => {
    attempts += 1
    if (tryFocus() || attempts >= maxAttempts) clearInterval(timer)
  }, 300)
}

/**
 * 跳转决策（三态）：self → 本会话 Herdr Tab 定位；foreign → 切会话 + 延迟定位；
 * unbound → 仍尽力在本会话 Herdr Tab 定位（pane 属于当前 herdr server，通常
 * 就在本会话 workspace 内；跨 workspace 时定位是 no-op，落在 Herdr Tab）。
 * 返回最终 state 供调用方决定是否关闭面板。
 */
export function navigateToPane(paneId: string, opts: { selfSessionId?: string; paneSessionId: string | null | undefined }): PaneNavState {
  const state = derivePaneNavState(opts.selfSessionId, opts.paneSessionId)
  if (state === 'self' || state === 'unbound') {
    focusPaneInHerdrTab(paneId)
  } else if (state === 'foreign') {
    if (!opts.paneSessionId) return 'unbound'
    setPendingFocusPane(paneId)
    openSession(opts.paneSessionId)
    deferFocusHerdrTab(paneId)
  }
  return state
}
