// Herdr Tab 跳转与当前会话 id：共享的模块级可变状态。
// 拆出独立模块以避免组件间循环 import（apply 注入 getSessionId，HerdrPaneList 读取）。
// 可变状态以闭包 + 访问器函数封装：ES 模块的 import 绑定不可重新赋值，
// 故跨模块读写必须经函数（行为与拆分前同模块内的 let 直写一致）。

/** 待定位的 pane（Herdr 视图挂载时消费；面板点击 → 切 tab 的时序兜底）。 */
let pendingFocusPane: string | null = null

export function getPendingFocusPane(): string | null {
  return pendingFocusPane
}

export function setPendingFocusPane(v: string | null): void {
  pendingFocusPane = v
}

export function focusPaneInHerdrTab(paneId: string): void {
  pendingFocusPane = paneId
  // 切换到 Herdr 视图 tab（模拟用户点击 header tab）
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(t => (t.textContent ?? '').trim() === 'Herdr')
  if (tab instanceof HTMLElement) tab.click()
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
