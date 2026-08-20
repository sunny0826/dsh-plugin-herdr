// 自会话 pane 单例：单飞 + 退避 + 订阅（HerdrView / PaneList 共享）。
// 命中后停止请求，miss 时退避 1s→2s→4s→8s→30s cap；session 切换由 store 内单一轮询检测。
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { fetchSelfPaneId } from './session-pane.ts'
import { getSessionId } from './navigation.ts'

type PaneValue = string | null | undefined // undefined=未查

export interface SelfPaneStore {
  subscribe(sessionId: string, cb: () => void): () => void
  get(sessionId: string): PaneValue
  getSnapshot(sessionId: string): PaneValue
  getMisses(sessionId: string): number
  getBackoff(sessionId: string): number
  refresh(sessionId: string): void
  invalidate(sessionId?: string): void
  stop(): void
  /** test only: reset all state */
  _reset(): void
}

export type SelfPaneStoreOptions = {
  fetchFn?: (sessionId: string) => Promise<string | null>
  getSessionIdFn?: () => string | undefined
  sessionPollMs?: number
  /** base delay for first fetch; also backoff reset value. test only, default 1000 */
  baseDelayMs?: number
}

export function createSelfPaneStore(opts: SelfPaneStoreOptions = {}): SelfPaneStore & {
  subscribeSession(cb: () => void): () => void
  getCurrentSessionId(): string | undefined
  useSelfPaneId(): PaneValue
} {
  const fetchFn = opts.fetchFn ?? fetchSelfPaneId
  const getSid = opts.getSessionIdFn ?? getSessionId
  const sessionPollMs = opts.sessionPollMs ?? 1000
  const baseDelay = opts.baseDelayMs ?? 1000
  const BACKOFF_CAP = 30000

  const bySession = new Map<string, PaneValue>()
  const inflight = new Set<string>()
  const backoff = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const misses = new Map<string, number>()
  const listeners = new Map<string, Set<() => void>>()

  // 全局 session 监听（供 hook 感知切会话，单一定时器驱动）
  const sessionListeners = new Set<() => void>()
  let sessionTimer: ReturnType<typeof setInterval> | null = null
  let lastSessionId: string | undefined = getSid()

  const notify = (sessionId: string) => {
    const set = listeners.get(sessionId)
    if (set) {
      for (const cb of [...set]) cb()
    }
  }
  const notifySession = () => {
    for (const cb of [...sessionListeners]) cb()
  }

  const ensureSessionPolling = () => {
    if (sessionTimer !== null) return
    // 仅当有订阅者时才启动；首个订阅者会触发此分支
    if (listeners.size === 0 && sessionListeners.size === 0) return
    sessionTimer = setInterval(() => {
      const id = getSid()
      if (id !== lastSessionId) {
        lastSessionId = id
        notifySession()
        if (id) {
          // 新会话若从未查过，开始调度；若已命中则保持命中，不再调度
          const v = bySession.get(id)
          if (v === undefined) {
            // 未查过，重置退避并调度
            backoff.set(id, baseDelay)
            misses.set(id, 0)
            scheduleFetch(id)
          } else if (v === null) {
            // 之前 miss 的会话切回，继续退避调度（若无在途且无定时器）
            if (!inflight.has(id) && !timers.has(id)) scheduleFetch(id)
          }
          // 已命中 v !== null → 不再调度
        }
      }
    }, sessionPollMs)
    // 让 Node 测试中不阻塞进程退出
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t: any = sessionTimer
    if (t && typeof t.unref === 'function') t.unref()
  }

  const stopSessionPollingIfIdle = () => {
    if (listeners.size === 0 && sessionListeners.size === 0 && sessionTimer !== null) {
      clearInterval(sessionTimer)
      sessionTimer = null
    }
  }

  const scheduleFetch = (sessionId: string) => {
    if (!sessionId) return
    // 命中后不再调度
    const cur = bySession.get(sessionId)
    if (cur !== null && cur !== undefined) return
    if (inflight.has(sessionId)) return
    if (timers.has(sessionId)) return
    const delay = backoff.get(sessionId) ?? baseDelay
    const timer = setTimeout(async () => {
      timers.delete(sessionId)
      inflight.add(sessionId)
      try {
        const paneId = await fetchFn(sessionId)
        if (paneId !== null && paneId !== undefined) {
          bySession.set(sessionId, paneId)
          backoff.set(sessionId, baseDelay)
          misses.set(sessionId, 0)
          notify(sessionId)
          // 命中后停止，不再调度
        } else {
          bySession.set(sessionId, null)
          const nextMisses = (misses.get(sessionId) ?? 0) + 1
          misses.set(sessionId, nextMisses)
          const prev = backoff.get(sessionId) ?? baseDelay
          const next = Math.min(prev * 2, BACKOFF_CAP)
          backoff.set(sessionId, next)
          notify(sessionId)
          inflight.delete(sessionId)
          scheduleFetch(sessionId)
          return
        }
      } catch {
        bySession.set(sessionId, null)
        const nextMisses = (misses.get(sessionId) ?? 0) + 1
        misses.set(sessionId, nextMisses)
        const prev = backoff.get(sessionId) ?? baseDelay
        const next = Math.min(prev * 2, BACKOFF_CAP)
        backoff.set(sessionId, next)
        notify(sessionId)
        inflight.delete(sessionId)
        scheduleFetch(sessionId)
        return
      } finally {
        inflight.delete(sessionId)
      }
    }, delay)
    timers.set(sessionId, timer)
  }

  const subscribe = (sessionId: string, cb: () => void): (() => void) => {
    if (!sessionId) return () => {}
    let set = listeners.get(sessionId)
    if (!set) {
      set = new Set()
      listeners.set(sessionId, set)
    }
    set.add(cb)
    // 首次订阅时若从未查过，初始化并调度
    if (bySession.get(sessionId) === undefined) {
      // 区分：未查时 bySession 没有 key，get 返回 undefined
      // 初始化退避与 miss，并启动调度
      if (!backoff.has(sessionId)) backoff.set(sessionId, baseDelay)
      if (!misses.has(sessionId)) misses.set(sessionId, 0)
      // 同步 lastSessionId 到当前订阅的 session（避免误判切换）
      const curSid = getSid()
      if (curSid === sessionId) lastSessionId = curSid
      scheduleFetch(sessionId)
    } else {
      // 已有值（命中或 miss），若是 miss 且当前无定时器/在途则恢复调度
      const v = bySession.get(sessionId)
      if (v === null && !inflight.has(sessionId) && !timers.has(sessionId)) {
        scheduleFetch(sessionId)
      }
    }
    ensureSessionPolling()
    return () => {
      const s = listeners.get(sessionId)
      if (s) {
        s.delete(cb)
        if (s.size === 0) listeners.delete(sessionId)
      }
      stopSessionPollingIfIdle()
    }
  }

  const subscribeSession = (cb: () => void): (() => void) => {
    sessionListeners.add(cb)
    ensureSessionPolling()
    return () => {
      sessionListeners.delete(cb)
      stopSessionPollingIfIdle()
    }
  }

  const get = (sessionId: string): PaneValue => bySession.get(sessionId)
  const getSnapshot = (sessionId: string): PaneValue => bySession.get(sessionId)
  const getMisses = (sessionId: string): number => misses.get(sessionId) ?? 0
  const getBackoff = (sessionId: string): number => backoff.get(sessionId) ?? baseDelay

  const refresh = (sessionId: string): void => {
    if (!sessionId) return
    const t = timers.get(sessionId)
    if (t) {
      clearTimeout(t)
      timers.delete(sessionId)
    }
    // 若已命中，refresh 应强制重新查询：清除命中状态，重置退避
    // 若为 miss/未查，重置退避为 1000 立即重查
    bySession.delete(sessionId)
    backoff.set(sessionId, baseDelay)
    misses.set(sessionId, 0)
    notify(sessionId)
    scheduleFetch(sessionId)
  }

  const invalidate = (sessionId?: string): void => {
    if (sessionId) {
      const t = timers.get(sessionId)
      if (t) {
        clearTimeout(t)
        timers.delete(sessionId)
      }
      inflight.delete(sessionId)
      bySession.delete(sessionId)
      backoff.delete(sessionId)
      misses.delete(sessionId)
      notify(sessionId)
      // 若是当前会话，立即重调度
      const cur = getSid()
      if (cur === sessionId) {
        backoff.set(sessionId, baseDelay)
        misses.set(sessionId, 0)
        scheduleFetch(sessionId)
      }
    } else {
      for (const [, t] of timers) clearTimeout(t)
      timers.clear()
      inflight.clear()
      bySession.clear()
      backoff.clear()
      misses.clear()
      // 通知所有监听者（全局刷新）
      for (const [, set] of listeners) {
        for (const cb of [...set]) cb()
      }
      // 当前会话若存在，重新调度
      const cur = getSid()
      if (cur) {
        backoff.set(cur, baseDelay)
        misses.set(cur, 0)
        scheduleFetch(cur)
      }
    }
  }

  const stop = (): void => {
    for (const [, t] of timers) clearTimeout(t)
    timers.clear()
    inflight.clear()
    if (sessionTimer !== null) {
      clearInterval(sessionTimer)
      sessionTimer = null
    }
  }

  const _reset = (): void => {
    for (const [, t] of timers) clearTimeout(t)
    timers.clear()
    inflight.clear()
    bySession.clear()
    backoff.clear()
    misses.clear()
    listeners.clear()
    sessionListeners.clear()
    if (sessionTimer !== null) {
      clearInterval(sessionTimer)
      sessionTimer = null
    }
    lastSessionId = getSid()
  }

  const getCurrentSessionId = (): string | undefined => getSid()

  function useSelfPaneId(): PaneValue {
    const [sessionId, setSessionId] = useState<string | undefined>(() => getSid())
    useEffect(() => {
      return subscribeSession(() => {
        setSessionId(getSid())
      })
    }, [])
    const sid = sessionId ?? ''
    const subscribeCb = useCallback(
      (cb: () => void) => {
        if (!sid) return () => {}
        return subscribe(sid, cb)
      },
      [sid],
    )
    const getSnap = useCallback(() => (sid ? getSnapshot(sid) : undefined), [sid])
    // useSyncExternalStore 要求在 SSR 时提供 getServerSnapshot，此处按 undefined 处理
    const paneId = useSyncExternalStore(subscribeCb, getSnap, getSnap)
    return sid ? paneId : undefined
  }

  return {
    subscribe,
    subscribeSession,
    get,
    getSnapshot,
    getMisses,
    getBackoff,
    refresh,
    invalidate,
    stop,
    _reset,
    getCurrentSessionId,
    useSelfPaneId,
  }
}

export const selfPaneStore = createSelfPaneStore()

export function useSelfPaneId(): string | null | undefined {
  return selfPaneStore.useSelfPaneId()
}
