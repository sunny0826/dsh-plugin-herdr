// 数据获取：模块级共享轮询（多组件订阅同一数据源；逻辑见 client-logic.ts）。
// 与拆分前的 client.tsx 完全一致：statusStore 是本模块的模块级单例，
// 所有订阅方（HerdrView / HerdrHeaderPill / HerdrPaneList / HerdrHeroStatus）
// 共享同一数据源——移入独立模块后单例仍位于本文件，行为不变。

import { useCallback, useEffect, useState } from 'react'
import { createStatusStore, parseStartResponse } from '../client-logic.ts'
import type { HerdrStatusSnapshot } from './types.ts'

export type StatusScope = 'project' | 'all'

// 当前看板 scope（模块级共享，与 statusStore 同源）：切换后立即重拉，所有订阅方（HerdrView /
// HerdrPaneList / HeadlessPill）随同更新——悬浮面板与 Herdr Tab 行为一致（design-v2 §7.4）。
let statusScope: StatusScope = 'project'

async function fetchStatus(signal: AbortSignal): Promise<HerdrStatusSnapshot> {
  const qs = statusScope === 'all' ? '?scope=all' : ''
  const resp = await fetch('/herdr-status' + qs, { signal })
  if (!resp.ok) throw new Error(`herdr-status HTTP ${resp.status}`)
  return (await resp.json()) as HerdrStatusSnapshot
}

const statusStore = createStatusStore<HerdrStatusSnapshot>({ fetch: fetchStatus })

/** 切换看板 scope（'project' 目录过滤 / 'all' 全量）；变更时触发立即重拉。 */
export function setStatusScope(scopeArg: StatusScope): void {
  if (scopeArg === statusScope) return
  statusScope = scopeArg
  statusStore.refresh()
}

/** 读取当前看板 scope。 */
export function getStatusScope(): StatusScope {
  return statusScope
}

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
