// 模式 store（design: herdr-mode-gating §4.1）：当前会话是否 herdr 模式的单一事实源。
// 数据源是 sessions 服务的 list（ObservableSnapshot）：subscribe 响应式跟踪、无网络往返；
// 派生结果镜像到 documentElement 的 data-herdr-mode，供纯 CSS 门控（styles.ts）。
// 初始值 false（隐藏优先）：非 herdr 对话绝不闪现 herdr UI；herdr 对话在会话快照
// 就绪后立即翻转（同步内存数据，无可见闪烁）。

import { useEffect, useState } from 'react'
import { deriveHerdrMode } from '../client-logic.ts'

/** sessions.list 的最小形状（ObservableSnapshot<SessionListState> 的子集）。 */
export interface SessionListLike {
  getSnapshot(): {
    byId?: Record<string, { agentPreset?: string }>
    current?: string
  }
  subscribe(fn: () => void): () => void
}

let herdrMode = false
const listeners = new Set<() => void>()

function setMode(next: boolean): void {
  if (next === herdrMode) return
  herdrMode = next
  // 镜像到 documentElement：CSS 门控锚点（html:not([data-herdr-mode='1']) .herdr-tab { display: none }）
  if (typeof document !== 'undefined') {
    if (next) document.documentElement.setAttribute('data-herdr-mode', '1')
    else document.documentElement.removeAttribute('data-herdr-mode')
  }
  for (const l of [...listeners]) l()
}

/** 订阅会话列表并跟踪当前会话模式；返回退订函数（app.tsx 注入回调内启动）。 */
export function startModeTracking(list: SessionListLike): () => void {
  const update = () => {
    const s = list.getSnapshot()
    setMode(deriveHerdrMode(s.byId, s.current))
  }
  update()
  const unsubscribe = list.subscribe(update)
  return () => {
    unsubscribe()
    // 组件订阅由各自 useEffect 清理；这里只停止数据源跟踪
  }
}

/** React hook：当前会话是否为 herdr 模式（subscribe + useState，订阅模式同 statusStore）。 */
export function useHerdrMode(): boolean {
  const [mode, setModeState] = useState(herdrMode)
  useEffect(() => {
    const update = () => setModeState(herdrMode)
    listeners.add(update)
    update()
    return () => {
      listeners.delete(update)
    }
  }, [])
  return mode
}

/** 同步读取当前模式（非 React 场景用）。 */
export function getHerdrMode(): boolean {
  return herdrMode
}
