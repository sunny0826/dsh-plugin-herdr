// 数据获取：模块级共享轮询（多组件订阅同一数据源；逻辑见 client-logic.ts）。
// 与拆分前的 client.tsx 完全一致：statusStore 是本模块的模块级单例，
// 所有订阅方（HerdrView / HerdrHeaderPill / HerdrPaneList / HerdrHeroStatus）
// 共享同一数据源——移入独立模块后单例仍位于本文件，行为不变。

import { useCallback, useEffect, useState } from 'react'
import { createStatusStore, parseStartResponse } from '../client-logic.ts'
import type { HerdrStatusSnapshot } from './types.ts'

// 会话聚焦（design: herdr-mode-gating）：Tab/面板都只显示本会话专属 workspace，
// 不再需要 project/all scope 切换——固定 project 轮询即可（本会话 workspace 有
// 服务端 self-pane 豁免，恒不被过滤）。
async function fetchStatus(signal: AbortSignal): Promise<HerdrStatusSnapshot> {
  const resp = await fetch('/herdr-status', { signal })
  if (!resp.ok) throw new Error(`herdr-status HTTP ${resp.status}`)
  return (await resp.json()) as HerdrStatusSnapshot
}

const statusStore = createStatusStore<HerdrStatusSnapshot>({ fetch: fetchStatus })

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
