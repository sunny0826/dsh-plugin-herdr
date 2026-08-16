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
// 拖拽排序 / localStorage 持久化（纯函数，SSR 防御）
// ---------------------------------------------------------------------------

/** localStorage 键：herdr:pane-order:<workspace_id>。 */
export function paneOrderKey(workspaceId: string): string {
  return 'herdr:pane-order:' + workspaceId
}

/** 可注入的存储（节点测试用 mock；默认浏览器 localStorage）。 */
export interface PaneOrderStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 默认存储：非浏览器环境（SSR/测试）无 localStorage 时返回 null。 */
function defaultPaneOrderStorage(): PaneOrderStorageLike | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

/**
 * 拖拽排序：把 ids[from] 移到结果数组下标 to（落位后索引），不修改原数组。
 * 语义：先从 from 移除，再 splice(to, 0, item)——移动项最终精确落在下标 to。
 * 边界：from 越界 / to 越界 / from===to → 返回原数组的拷贝（稳定不变）。
 * @example reorderPanes(['a','b','c','d'], 1, 2) // from=1('b') → ['a','c','b','d']
 */
export function reorderPanes(ids: string[], from: number, to: number): string[] {
  const n = ids.length
  if (from === to) return ids.slice()
  if (from < 0 || from >= n || to < 0 || to >= n) return ids.slice()
  const next = ids.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * 按 order 排列 panes；未知 id 追加尾部（保持原相对顺序）；
 * order 为空/无效时返回原数组。
 */
export function applyPaneOrder<T extends { pane_id: string }>(
  panes: T[],
  order: string[] | null | undefined,
): T[] {
  if (!order || order.length === 0) return panes
  const byId = new Map<string, T>(panes.map(p => [p.pane_id, p]))
  const used = new Set<string>()
  const result: T[] = []
  for (const id of order) {
    if (used.has(id)) continue
    used.add(id)
    const p = byId.get(id)
    if (p) result.push(p)
  }
  for (const p of panes) {
    if (!used.has(p.pane_id)) result.push(p)
  }
  return result
}

/** 读取持久化解序的 pane_id 数组；无/损坏/空 → null。 */
export function loadPaneOrder(
  workspaceId: string,
  storage?: PaneOrderStorageLike | null,
): string[] | null {
  const s = storage === undefined ? defaultPaneOrderStorage() : storage
  if (!s) return null
  try {
    const raw = s.getItem(paneOrderKey(workspaceId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const ids = parsed.filter((x): x is string => typeof x === 'string')
    return ids.length ? ids : null
  } catch {
    return null
  }
}

/** 持久化解序（每次 drop 后重写）；localStorage 不可用则静默。 */
export function savePaneOrder(
  workspaceId: string,
  order: string[],
  storage?: PaneOrderStorageLike | null,
): void {
  const s = storage === undefined ? defaultPaneOrderStorage() : storage
  if (!s) return
  try {
    s.setItem(paneOrderKey(workspaceId), JSON.stringify(order))
  } catch {
    // localStorage 被禁用/拒绝 → 静默（仅本次不持久化，UI 不受影响）
  }
}

// ---------------------------------------------------------------------------
// 名称校验（T12）；label 非空时 ≤64，超出抛错由 UI 捕获展示
// ---------------------------------------------------------------------------

/** label 校验：去空白后为空 → null（表示清除名称）；>64 → 抛 Error；否则返回 trim 后字符串。 */
export function validateLabel(label: string): string | null {
  const trimmed = label.trim()
  if (trimmed === '') return null
  if (trimmed.length > 64) throw new Error('label must be at most 64 characters')
  return trimmed
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

// ---------------------------------------------------------------------------
// Agent 主题与日志行分类（design-v2 §5.2 补充）：按 agent 类型适配日志渲染。
// classifyLogLine 识别日志行语义（diff 增删 / markdown 标题 / 命令提示符 /
// 代码围栏），PaneLog 据此着色；agentTheme 提供 agent 品牌强调色。
// ---------------------------------------------------------------------------

/** 日志行语义分类（PaneLog 行级着色用）。 */
export type LogLineKind = 'diff-add' | 'diff-del' | 'heading' | 'cmd' | 'code-fence' | 'plain'

/** 识别日志行语义；纯函数。 */
export function classifyLogLine(line: string): LogLineKind {
  const t = line.trimStart()
  if (t.startsWith('❯') || t.startsWith('$')) return 'cmd'
  if (t.startsWith('```') || t.startsWith('~~~')) return 'code-fence'
  if (t.startsWith('#')) return 'heading'
  // diff 行：+/- 开头（排除 +++/--- 文件头）；或行号前缀（如 "  110 +" / "  112 +14"，
  // 行号后须有空白，避免把 "2024-01-01" 之类日期误判）
  if (/^\+[^+\s]/.test(t) || /^\+\s/.test(t) || /^\s*\d+\s+\+/.test(t)) return 'diff-add'
  if (/^-[^-\s]/.test(t) || /^-\s/.test(t) || /^\s*\d+\s+-/.test(t)) return 'diff-del'
  return 'plain'
}

/** Agent 品牌主题（卡片徽章 / 日志强调色）。 */
export type AgentAccent = 'codex' | 'pi' | 'claude' | 'dsh' | 'other'

/** 按 agent 名识别品牌（小写前缀匹配）；未知归 other。 */
export function agentTheme(agentName: string | undefined): AgentAccent {
  const n = (agentName ?? '').toLowerCase()
  if (n.startsWith('codex')) return 'codex'
  if (n.startsWith('pi-coding') || n.startsWith('pi')) return 'pi'
  if (n.startsWith('claude')) return 'claude'
  if (n.startsWith('dsh')) return 'dsh'
  return 'other'
}

// ---------------------------------------------------------------------------
// Herdr 模式判定与面板会话聚焦（design: herdr-mode-gating）。
// deriveHerdrMode：当前会话是否 herdr 模式（agentPreset 权威信号）；
// filterGroupsToSession：面板只保留包含本会话绑定 pane 的 workspace 组。
// ---------------------------------------------------------------------------

/** herdr agent preset id（与服务端 preset-install.ts 的 PRESET_ID 一致；两处需同步修改）。 */
export const HERDR_PRESET_ID = 'herdr'

/** 会话列表状态 → 当前会话是否为 herdr 模式（agentPreset === HERDR_PRESET_ID）。 */
export function deriveHerdrMode(
  byId: Record<string, { agentPreset?: string }> | undefined,
  current: string | undefined,
): boolean {
  return byId?.[current ?? '']?.agentPreset === HERDR_PRESET_ID
}

/**
 * 面板会话聚焦：只保留包含 selfPaneId 的 workspace 组。
 * - selfPaneId 为 null/空（未绑定/查询在途）→ []（不展示其他 workspace）；
 * - selfPaneId 对应的 pane 不在 topology 中（pane 已关闭）→ []；
 * - 命中 → 该 workspace 组（组内 panes 保持 buildGroups 排序）。
 */
export function filterGroupsToSession(
  topology: HerdrTopology | undefined,
  selfPaneId: string | null | undefined,
): ReturnType<typeof buildGroups> {
  if (!selfPaneId) return []
  const pane = topology?.panes.find(p => p.pane_id === selfPaneId)
  if (!pane) return []
  return buildGroups(topology).filter(g => g.workspace.workspace_id === pane.workspace_id)
}

