import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createGlobalDashboardStore, createStatusStore, parseStartResponse } from '../client-logic.ts'
import type { SseEvent } from '../client-logic.ts'
import type { HerdrStatusSnapshot } from './types.ts'
import type { HerdrDashboardSnapshot } from './dashboard-types.ts'
import { getHerdrMode, useHerdrMode } from './mode.ts'

async function fetchStatus(signal: AbortSignal): Promise<HerdrStatusSnapshot> {
  const resp = await fetch('/herdr-status', { signal })
  if (!resp.ok) throw new Error(`herdr-status HTTP ${resp.status}`)
  return (await resp.json()) as HerdrStatusSnapshot
}

export function statusIntervalFor(snap: HerdrStatusSnapshot | null): number {
  const agents = (snap as HerdrStatusSnapshot | null)?.agents ?? []
  const hasWorking = agents.some(a => a.status === 'working' || a.status === 'blocked')
  if (hasWorking) return 1500
  if (agents.length === 0) return 10000
  const allIdleDone = agents.every(a => a.status === 'idle' || a.status === 'done')
  if (allIdleDone) return 5000
  const allUnknown = agents.every(a => !a.status || a.status === 'unknown')
  if (allUnknown) return 10000
  return 2000
}

export const globalDashboardStore = createGlobalDashboardStore()

function shouldPauseStatus(): boolean {
  const hidden = typeof document !== 'undefined' ? document.hidden : false
  if (hidden) return true
  const herdrMode = getHerdrMode()
  const dashboardOpen = globalDashboardStore.getOpen()
  return !herdrMode && !dashboardOpen
}

export function patchHerdrStatus(snap: HerdrStatusSnapshot, event: SseEvent): HerdrStatusSnapshot {
  switch (event.type) {
    case 'topology': {
      const topo = event.topology as HerdrStatusSnapshot['topology']
      const filter = event.filter as HerdrStatusSnapshot['filter']
      if (!topo) return snap
      return { ...snap, topology: topo, ...(filter ? { filter } : {}), updated_at: Date.now() }
    }
    case 'agent_status': {
      const agents = snap.agents ?? []
      const now = Date.now()
      const idx = agents.findIndex(a => a.pane_id === event.pane_id)
      let nextAgents: HerdrStatusSnapshot['agents']
      if (idx >= 0) {
        const prev = agents[idx]!
        if (prev.status === event.status && prev.agent === event.agent && prev.message === event.message) return snap
        nextAgents = agents.slice()
        nextAgents[idx] = { ...prev, agent: event.agent || prev.agent, status: event.status, ...(event.message !== undefined ? { message: event.message } : { message: prev.message }), updated_at: now }
      } else {
        nextAgents = agents.concat([{ pane_id: event.pane_id, agent: event.agent, status: event.status, ...(event.message ? { message: event.message } : {}), output: '', updated_at: now }])
      }
      return { ...snap, agents: nextAgents, updated_at: now }
    }
    case 'heartbeat': {
      return { ...snap, stale: event.stale, last_error: event.last_error, updated_at: Date.now() }
    }
    case 'output':
      return snap
    default:
      return snap
  }
}

export function openHerdrEvents(signal: AbortSignal, onEvent: (e: SseEvent) => void): { close(): void } {
  let closed = false
  let lastRevision: number | null = null
  let curController: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const abortAll = (): void => {
    closed = true
    if (curController) try { curController.abort() } catch { /* ignore */ }
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
  signal.addEventListener('abort', abortAll, { once: true })
  const emitParsed = (rawEvent: string, rawData: string, rawId: string): void => {
    if (!rawData) return
    try {
      const data = JSON.parse(rawData) as Record<string, unknown>
      if (rawEvent === 'output') {
        const pane_id = String((data as { pane_id?: string }).pane_id ?? '')
        const revision = typeof (data as { revision?: number }).revision === 'number' ? (data as { revision: number }).revision : (rawId && /^\d+$/.test(rawId) ? Number(rawId) : 0)
        if (pane_id) {
          if (Number.isSafeInteger(revision)) lastRevision = revision
          onEvent({ type: 'output', pane_id, revision, id: rawId } as SseEvent)
        }
      } else if (rawEvent === 'term') {
        // 终端会话帧转发：服务端不带 id，不推进 lastRevision
        const session_id = String((data as { session_id?: string }).session_id ?? '')
        const pane_id = String((data as { pane_id?: string }).pane_id ?? '')
        if (session_id && pane_id) {
          onEvent({ type: 'term', session_id, pane_id, event: (data as { event?: unknown }).event } as SseEvent)
        }
      } else if (rawEvent === 'agent_status') {
        const pane_id = String((data as { pane_id?: string }).pane_id ?? '')
        if (pane_id) {
          onEvent({ type: 'agent_status', pane_id, agent: String((data as { agent?: string }).agent ?? ''), status: String((data as { status?: string }).status ?? 'unknown'), message: (data as { message?: string }).message, workspace_id: (data as { workspace_id?: string }).workspace_id } as SseEvent)
        }
      } else if (rawEvent === 'topology') {
        onEvent({ type: 'topology', topology: (data as { topology?: unknown }).topology, filter: (data as { filter?: unknown }).filter } as SseEvent)
      } else if (rawEvent === 'heartbeat') {
        onEvent({ type: 'heartbeat', stale: Boolean((data as { stale?: boolean }).stale), last_error: (data as { last_error?: string | null }).last_error ?? null } as SseEvent)
      }
    } catch { /* ignore */ }
  }
  const connect = async (): Promise<void> => {
    if (closed || signal.aborted) return
    curController = new AbortController()
    const linkSignal = curController.signal
    const onOuterAbort = (): void => { try { curController!.abort() } catch { /* ignore */ } }
    signal.addEventListener('abort', onOuterAbort, { once: true })
    const url = lastRevision != null ? `/herdr-events?after_revision=${lastRevision}` : '/herdr-events'
    try {
      const resp = await fetch(url, { signal: linkSignal, headers: { Accept: 'text/event-stream' } })
      if (!resp.ok || !resp.body) throw new Error(`sse ${resp.status}`)
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let curEvent = ''
      let curData = ''
      let curId = ''
      const flush = (): void => {
        if (curData !== '' || curEvent !== '') {
          emitParsed(curEvent, curData, curId)
          curEvent = ''
          curData = ''
          curId = ''
        }
      }
      while (true) {
        if (linkSignal.aborted || signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        for (const raw of parts) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (line === '') { flush(); continue }
          if (line.startsWith(':')) continue
          if (line.startsWith('retry:')) continue
          if (line.startsWith('id:')) {
            curId = line.slice(3).trim()
            if (curId && /^\d+$/.test(curId)) lastRevision = Number(curId)
            continue
          }
          if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue }
          if (line.startsWith('data:')) { curData = line.slice(5).trim(); continue }
        }
      }
      if (!closed && !signal.aborted) retryTimer = setTimeout(() => { void connect() }, 3000)
    } catch {
      if (!closed && !signal.aborted) retryTimer = setTimeout(() => { void connect() }, 3000)
    } finally {
      signal.removeEventListener('abort', onOuterAbort)
    }
  }
  void connect()
  return { close: abortAll }
}

// ---------------------------------------------------------------------------
// /herdr-events 单例事件总线：整个页面共享一条常驻 SSE 连接。浏览器对单域名
// 的并发连接数有限，status store 与逐卡 observer 若各开一条会把配额耗尽，
// 进而出现连接饥饿（Failed to fetch / bootstrap 超时）。订阅者退订不关流。
// ---------------------------------------------------------------------------
type HerdrEventListener = (ev: SseEvent) => void
const herdrEventListeners = new Set<HerdrEventListener>()
let herdrEventStreamStarted = false

function ensureHerdrEventStream(): void {
  if (herdrEventStreamStarted) return
  if (typeof window === 'undefined') return
  herdrEventStreamStarted = true
  const ctrl = new AbortController()
  // 页面生命周期常驻：ctrl 不暴露，断线由 openHerdrEvents 内部退避重连
  openHerdrEvents(ctrl.signal, ev => {
    for (const l of [...herdrEventListeners]) {
      try { l(ev) } catch { /* ignore */ }
    }
  })
}

/** 订阅共享 herdr 事件流；返回退订函数。流为页面级单例，不因退订关闭。 */
export function subscribeHerdrEvents(listener: HerdrEventListener): () => void {
  herdrEventListeners.add(listener)
  ensureHerdrEventStream()
  return () => { herdrEventListeners.delete(listener) }
}

/** 订阅指定 pane 的 output 变化（快照模式按此防抖重拉）。 */
export function subscribePaneOutput(paneId: string, cb: (revision: number) => void): () => void {
  return subscribeHerdrEvents(ev => {
    if (ev.type === 'output' && ev.pane_id === paneId) cb(ev.revision)
  })
}

function sseOpen(signal: AbortSignal, onEvent: (e: SseEvent) => void): { close(): void } {
  const off = subscribeHerdrEvents(onEvent)
  signal.addEventListener('abort', off, { once: true })
  return { close: off }
}

export async function fetchPaneOutputs(paneIds: string[], lines = 40): Promise<Map<string, string>> {
  if (paneIds.length === 0) return new Map()
  try {
    const ids = paneIds.map(id => encodeURIComponent(id)).join(',')
    const url = `/herdr-agents/output?pane_ids=${ids}&lines=${encodeURIComponent(String(lines))}`
    const resp = await fetch(url)
    if (!resp.ok) return new Map()
    const body = (await resp.json()) as { outputs?: Array<{ pane_id: string; text?: string; truncated?: boolean; error?: string }> }
    const map = new Map<string, string>()
    for (const o of body.outputs ?? []) {
      if (o.pane_id && typeof o.text === 'string') map.set(o.pane_id, o.text)
    }
    return map
  } catch {
    return new Map()
  }
}

export async function fetchPaneOutputsDetailed(
  paneIds: string[],
  lines = 40,
): Promise<Map<string, { text: string; truncated: boolean }>> {
  if (paneIds.length === 0) return new Map()
  try {
    const ids = paneIds.map(id => encodeURIComponent(id)).join(',')
    const url = `/herdr-agents/output?pane_ids=${ids}&lines=${encodeURIComponent(String(lines))}`
    const resp = await fetch(url)
    if (!resp.ok) return new Map()
    const body = (await resp.json()) as { outputs?: Array<{ pane_id: string; text?: string; truncated?: boolean; error?: string }> }
    const map = new Map<string, { text: string; truncated: boolean }>()
    for (const o of body.outputs ?? []) {
      if (o.pane_id && typeof o.text === 'string') map.set(o.pane_id, { text: o.text, truncated: Boolean(o.truncated) })
    }
    return map
  } catch {
    return new Map()
  }
}

export const statusStore = createStatusStore<HerdrStatusSnapshot>({
  fetch: fetchStatus,
  intervalFor: statusIntervalFor,
  pauseWhen: shouldPauseStatus,
  sse: { open: sseOpen },
  onSseEvent: patchHerdrStatus,
})

export function useHerdrStatus(): { snap: HerdrStatusSnapshot | null; error: string | null; stale: boolean; refresh: () => void; diagnostics: { inflight: number; currentInterval: number | null; paused: boolean } } {
  const herdrMode = useHerdrMode()
  const globalOpen = useGlobalDashboardOpen()
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
  const prevPausedRef = useRef<boolean | null>(null)
  useEffect(() => {
    const paused = (typeof document !== 'undefined' ? document.hidden : false) || (!herdrMode && !globalOpen)
    if (prevPausedRef.current === true && !paused) {
      statusStore.refresh()
    }
    prevPausedRef.current = paused
  }, [herdrMode, globalOpen])
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => {
      if (!document.hidden) {
        const paused = !getHerdrMode() && !globalDashboardStore.getOpen()
        if (!paused) statusStore.refresh()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const refresh = useCallback(() => {
    statusStore.refresh()
  }, [])
  const stale = (snap as HerdrStatusSnapshot | null)?.stale ?? false
  const diagnostics = statusStore.getDiagnostics()
  return { snap, error, stale, refresh, diagnostics }
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

export function useGlobalDashboardOpen(): boolean {
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

// ---------------------------------------------------------------------------
// 终端输入写回（design: pane-interactive-terminal §3.4）
// ---------------------------------------------------------------------------

/** 单 pane 的输入队列：FIFO + promise chain 保证顺序。 */
const inputQueues = new Map<string, Promise<void>>()

/** 发送终端输入到指定 pane（HTTP → /herdr-pane-input → pane.send_input）。 */
export function sendPaneInput(paneId: string, input: { text?: string; keys?: string[] }): Promise<void> {
  const prev = inputQueues.get(paneId) ?? Promise.resolve()
  const next = prev.then(async () => {
    const resp = await fetch('/herdr-pane-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane_id: paneId, ...input }),
    })
    const body = await resp.json() as { ok?: boolean; error?: string }
    if (!body.ok) throw new Error(body.error ?? `herdr-pane-input HTTP ${resp.status}`)
  })
  inputQueues.set(paneId, next.catch(() => {}))
  return next
}

// ---------------------------------------------------------------------------
// 终端 bootstrap/snapshot（B 模式：revision 快照重拉）
// ---------------------------------------------------------------------------

export interface TerminalBootstrapResult {
  text: string
  revision?: number
  truncated: boolean
}

/** 获取 pane 的终端快照（B 模式：revision 变化时重新读取全量 snapshot；source 可选 visible/recent_unwrapped）。 */
export async function fetchTerminalBootstrap(
  paneId: string,
  maxLines?: number,
  signal?: AbortSignal,
  source: 'visible' | 'recent_unwrapped' = 'visible',
): Promise<TerminalBootstrapResult> {
  const url = new URL('/herdr-pane-terminal-bootstrap', window.location.origin)
  url.searchParams.set('pane_id', paneId)
  if (maxLines !== undefined) url.searchParams.set('lines', String(maxLines))
  if (source !== 'visible') url.searchParams.set('source', source)
  const resp = await fetch(url.toString(), { signal })
  const body = await resp.json() as { ok?: boolean; text?: string; revision?: number; truncated?: boolean; error?: string }
  if (!body.ok) throw new Error(body.error ?? `terminal-bootstrap HTTP ${resp.status}`)
  return { text: body.text ?? '', revision: body.revision, truncated: body.truncated === true }
}
