// 数据获取：模块级共享轮询（多组件订阅同一数据源；逻辑见 client-logic.ts）。
// 与拆分前的 client.tsx 完全一致：statusStore 是本模块的模块级单例，
// 所有订阅方（HerdrView / HerdrHeaderPill / HerdrPaneList / HerdrHeroStatus）
// 共享同一数据源——移入独立模块后单例仍位于本文件，行为不变。

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createGlobalDashboardStore, createStatusStore, parseStartResponse } from '../client-logic.ts'
import type { HerdrStatusSnapshot } from './types.ts'
import type { HerdrDashboardSnapshot } from './dashboard-types.ts'

// 会话聚焦（design: herdr-mode-gating）：Tab/面板都只显示本会话专属 workspace，
// 不再需要 project/all scope 切换——固定 project 轮询即可（本会话 workspace 有
// 服务端 self-pane 豁免，恒不被过滤）。
async function fetchStatus(signal: AbortSignal): Promise<HerdrStatusSnapshot> {
  const resp = await fetch('/herdr-status', { signal })
  if (!resp.ok) throw new Error(`herdr-status HTTP ${resp.status}`)
  return (await resp.json()) as HerdrStatusSnapshot
}

// v4 需求 2：marker 原生 DOM 按钮订阅 statusStore（单飞 /herdr-status 轮询，与
// 会话 UI 共享同一数据源与单飞请求；marker 不另起全量轮询——P1-1 定案）。
// 取舍：marker 常驻订阅使 statusStore 页面级活跃（2s 单飞轮询，含 agents 输出）；
// 若未来需减负可评估服务端轻量 server 端点，本次遵循「不新增端点除非必要」。
export const statusStore = createStatusStore<HerdrStatusSnapshot>({ fetch: fetchStatus })

export function useHerdrStatus(): { snap: HerdrStatusSnapshot | null; error: string | null; refresh: () => void } {
  const [snap, setSnap] = useState<HerdrStatusSnapshot | null>(statusStore.getSnap())
  const [error, setError] = useState<string | null>(statusStore.getError())
  useEffect(() => {
    const update = () => {
      setSnap(statusStore.getSnap())
      setError(statusStore.getError())
    }
    const unsubscribe = statusStore.subscribe(update)
    update()
    return unsubscribe
  }, [])
  const refresh = useCallback(() => {
    statusStore.refresh()
  }, [])
  return { snap, error, refresh }
}

// ---------------------------------------------------------------------------
// Dashboard（design: dashboard §5.2）：独立只读轮询 store（多组件共享单飞请求；
// 卸载即停并 abort；不重复创建 timer——逻辑见 client-logic.createStatusStore）。
// ---------------------------------------------------------------------------

async function fetchDashboard(signal: AbortSignal): Promise<HerdrDashboardSnapshot> {
  const resp = await fetch('/herdr-dashboard', { signal })
  if (!resp.ok) throw new Error(`herdr-dashboard HTTP ${resp.status}`)
  return (await resp.json()) as HerdrDashboardSnapshot
}

// 数据派生自 status 轮询 + 进程探测，4s 周期足够；首次立即 tick。
const dashboardStore = createStatusStore<HerdrDashboardSnapshot>({ fetch: fetchDashboard, intervalMs: 4000 })

export function useHerdrDashboard(): { snap: HerdrDashboardSnapshot | null; error: string | null; refresh: () => void } {
  const [snap, setSnap] = useState<HerdrDashboardSnapshot | null>(dashboardStore.getSnap())
  const [error, setError] = useState<string | null>(dashboardStore.getError())
  useEffect(() => {
    const update = () => {
      setSnap(dashboardStore.getSnap())
      setError(dashboardStore.getError())
    }
    const unsubscribe = dashboardStore.subscribe(update)
    update()
    return unsubscribe
  }, [])
  const refresh = useCallback(() => {
    dashboardStore.refresh()
  }, [])
  return { snap, error, refresh }
}

// ---------------------------------------------------------------------------
// 全局 Dashboard 打开状态（design: dashboard-global §6.2）。
// 模块级单例 store（createGlobalDashboardStore，纯逻辑可测）；sidebar 按钮与旧
// Herdr tab 降级按钮共享。按钮不订阅 dashboardStore —— Web 轮询生命周期以全局
// 面板订阅为准（打开挂载即拉取，关闭退订即 stop+abort）。
// 导出单例供原生 DOM marker controller 订阅（P1-1：open/close 同步 aria-pressed）。
// ---------------------------------------------------------------------------

export const globalDashboardStore = createGlobalDashboardStore()

export function useGlobalDashboardOpen(): boolean {
  // useSyncExternalStore：getSnapshot 返回原始值，无引用稳定性问题
  return useSyncExternalStore(globalDashboardStore.subscribe, globalDashboardStore.getOpen)
}

export function getGlobalDashboardOpen(): boolean {
  return globalDashboardStore.getOpen()
}

export function openGlobalDashboard(): void {
  globalDashboardStore.open()
}

export function closeGlobalDashboard(): void {
  globalDashboardStore.close()
}

export function useHerdrStart(): { starting: boolean; startError: string | null; start: () => Promise<boolean> } {
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const start = async (): Promise<boolean> => {
    setStarting(true)
    setStartError(null)
    try {
      const resp = await fetch('/herdr-start', { method: 'POST' })
      const body = await parseStartResponse(resp)
      if (!body.ok) {
        setStartError(body.error ?? `herdr-start HTTP ${resp.status}`)
        return false
      }
      return true
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setStarting(false)
    }
  }
  return { starting, startError, start }
}
