/**
 * CA-016：Web 面板纯 UI 逻辑（从 client.tsx 提取，无 React/DOM 依赖，node:test 可直接测）。
 *
 * 覆盖验收点：
 * - 看板数据轮询：createStatusStore（首次立即 poll、单飞不重叠、无重复 timer、卸载即停）；
 * - start 流程：parseStartResponse；
 * - pane focus/排序：comparePaneId/compareWorkspaceId/buildGroups；
 * - 拖动：isDragMovement/computeSnapPosition（水平吸附边界 + 纵向夹取）；
 * - 自动展开：shouldAutoExpand（working 边沿且处于折叠）；
 * - 折叠：toggleCollapse（不可变 Set 语义）；
 * - 状态着色：dotState。
 *
 * 真实浏览器渲染（desktop/mobile 视觉）需要 jsdom/@testing-library 与 web shell 的
 * dsh-client-ui-primitives 运行时注入——当前环境不可用，属明确遗留（M6/M7/M10-M12
 * 人工验收项保持开放，逻辑层以上述单测自动覆盖）。
 */
import type { HerdrTopology } from './status.ts'

// ---------------------------------------------------------------------------
// 排序 / 分组 / 状态派生（纯函数）
// ---------------------------------------------------------------------------

/** pane_id 自然排序（w8:p2 < w8:p10）：workspace 字典序 + pane 数字序。 */
export function comparePaneId(a: string, b: string): number {
  const [wa, pa] = a.split(':')
  const [wb, pb] = b.split(':')
  if (wa !== wb) return wa < wb ? -1 : 1
  const na = Number((pa ?? '').replace(/\D/g, '')) || 0
  const nb = Number((pb ?? '').replace(/\D/g, '')) || 0
  return na - nb
}

/** workspace_id 自然排序（w2 < w10）。 */
export function compareWorkspaceId(a: string, b: string): number {
  const na = Number(a.replace(/\D/g, '')) || 0
  const nb = Number(b.replace(/\D/g, '')) || 0
  if (na !== nb) return na - nb
  return a < b ? -1 : 1
}

/** agent 状态 → StateDot 状态（working=ongoing 矩阵动画 / blocked=error / 其余 done）。 */
export function dotState(status: string | undefined): string {
  if (status === 'working') return 'ongoing'
  if (status === 'blocked') return 'error'
  return 'done'
}

/** topology → 按 workspace 分组的 pane 列表（Herdr 视图与右侧面板共用）。 */
export function buildGroups(topology: HerdrTopology | undefined) {
  return (topology?.workspaces ?? [])
    .map(ws => ({
      workspace: ws,
      panes: (topology?.panes ?? [])
        .filter(p => p.workspace_id === ws.workspace_id)
        .sort((a, b) => comparePaneId(a.pane_id, b.pane_id)),
      tabs: (topology?.tabs ?? []).filter(t => t.workspace_id === ws.workspace_id),
    }))
    .sort((a, b) => compareWorkspaceId(a.workspace.workspace_id, b.workspace.workspace_id))
}

/** 时间戳 → 面板显示时间（HH:MM:SS）。 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ---------------------------------------------------------------------------
// 拖动（纯数学）
// ---------------------------------------------------------------------------

/** 拖动位移是否超过阈值（4px），用于区分点击与拖动。 */
export function isDragMovement(dx: number, dy: number, threshold = 4): boolean {
  return Math.abs(dx) + Math.abs(dy) > threshold
}

export interface SnapInput {
  /** 拖动结束时的绝对位置（不含吸附）。 */
  x: number
  y: number
  /** 元素尺寸。 */
  w: number
  h: number
  /** 视口尺寸。 */
  vw: number
  vh: number
  /** 左侧侧边栏宽度（左侧吸附到侧边栏右缘；无侧边栏传 0）。 */
  sidebarW: number
  /** 吸附边距（默认 16）。 */
  snap?: number
}

/** 水平分左右吸附（右侧 → 视口右边界；左侧 → 侧边栏右缘），纵向夹取在视口内。 */
export function computeSnapPosition(i: SnapInput): { x: number; y: number } {
  const snap = i.snap ?? 16
  const snapX = i.x + i.w / 2 < i.vw / 2 ? i.sidebarW + snap : i.vw - i.w - snap
  const snapY = Math.max(snap, Math.min(i.y, i.vh - i.h - snap))
  return { x: Math.max(0, Math.min(snapX, i.vw - i.w)), y: snapY }
}

// ---------------------------------------------------------------------------
// 折叠 / 自动展开（纯函数）
// ---------------------------------------------------------------------------

/** 折叠集合切换（不可变：返回新 Set）。 */
export function toggleCollapse(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** 自动展开：本对话 pane 状态 working 边沿（非 working → working）且处于折叠。 */
export function shouldAutoExpand(prevStatus: string | undefined, currentStatus: string | undefined, collapsed: boolean): boolean {
  return currentStatus === 'working' && prevStatus !== 'working' && collapsed
}

// ---------------------------------------------------------------------------
// start 流程（fetch 响应解析，纯逻辑）
// ---------------------------------------------------------------------------

export interface StartResponseLike {
  ok: boolean
  json(): Promise<unknown>
}

/** POST /herdr-start 响应解析：{ok, error?}（UI 依赖 body.ok 判定，HTTP 状态仅兜底文案）。 */
export async function parseStartResponse(resp: StartResponseLike): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = (await resp.json()) as { ok?: boolean; error?: string }
    if (body.ok !== true) return { ok: false, error: body.error ?? `herdr-start HTTP ${resp.ok ? 200 : 'error'}` }
    return { ok: true }
  } catch {
    return { ok: false, error: 'herdr-start returned a non-JSON response' }
  }
}

// ---------------------------------------------------------------------------
// 状态轮询 store（无重复 timer / 单飞 / 卸载即停）
// ---------------------------------------------------------------------------

export interface StatusStore<T> {
  /** 订阅状态变更；首个订阅者启动轮询，最后一个退订停止轮询（无重复 timer）。 */
  subscribe(listener: () => void): () => void
  /** 立即触发一次轮询（单飞：在途时忽略）。 */
  refresh(): void
  /** 停止轮询并中止在途请求（幂等）。 */
  stop(): void
  getSnap(): T | null
  getError(): string | null
  /** 在途请求数（单飞保证 ≤ 1；测试/诊断用）。 */
  inflight(): number
}

export interface StatusPollOptions<T> {
  intervalMs?: number
  fetch: (signal: AbortSignal) => Promise<T>
}

/**
 * 模块级共享轮询 store：多组件订阅同一数据源。
 * - 首次立即 poll（不等第一个 interval）；
 * - 单飞：在途请求未完成时忽略后续触发（慢请求不重叠，避免重复请求风暴）；
 * - 无重复 timer：started 标志保证只有一个 interval；最后订阅者退订即停；
 * - stop 中止在途请求且结果不落盘。
 */
export function createStatusStore<T>(opts: StatusPollOptions<T>): StatusStore<T> {
  let snap: T | null = null
  let error: string | null = null
  let started = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const l of listeners) l()
  }

  const pollOnce = async (): Promise<void> => {
    // 捕获当前 controller：stop() 会置 null，在途请求的 catch 必须引用本次快照
    const ctrl = controller
    if (!ctrl || polling) return // 单飞：在途或已停止
    polling = true
    try {
      const s = await opts.fetch(ctrl.signal)
      if (ctrl.signal.aborted) return
      snap = s
      error = null
    } catch (e) {
      if (ctrl.signal.aborted) return
      error = e instanceof Error ? e.message : String(e)
    } finally {
      polling = false
    }
    emit()
  }

  const ensurePolling = (): void => {
    if (started) return
    started = true
    controller = new AbortController()
    void pollOnce() // 首次立即 tick
    timer = setInterval(() => void pollOnce(), opts.intervalMs ?? 2000)
  }

  const stop = (): void => {
    if (!started) return
    started = false
    controller?.abort()
    controller = null
    if (timer) clearInterval(timer)
    timer = null
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    ensurePolling()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) stop()
    }
  }

  return {
    subscribe,
    refresh: () => void pollOnce(),
    stop,
    getSnap: () => snap,
    getError: () => error,
    inflight: () => (polling ? 1 : 0),
  }
}
