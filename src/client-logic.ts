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
import type { I18nKey } from './web/i18n.ts'
import type { HerdrAgentStatus, HerdrPaneView, HerdrTopology } from './status.ts'

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

/** pane 显示名回退链：label > agent 名（herdr 给 agent 的 <kind>-<purpose>）> title > terminal_title_stripped > display_agent > agent > pane_id。 */
export function paneDisplayName(pane: HerdrPaneView, agent?: HerdrAgentStatus | undefined): string {
  return (
    pane.label
    ?? agent?.name
    ?? pane.title
    ?? pane.terminal_title_stripped
    ?? pane.display_agent
    ?? agent?.agent
    ?? pane.pane_id
  )
}

/** pane 是否归属插件自身（agent 为 dsh 或 label 以 dsh: 开头）——面板列表/看板中作为基础设施 pane 处理。 */
export function isDshPane(pane: HerdrPaneView, agent?: HerdrAgentStatus | undefined): boolean {
  const agentName = agent?.agent ?? ''
  if (agentName === 'dsh' || agentName.startsWith('dsh')) return true
  const label = pane.label ?? ''
  return label.startsWith('dsh:')
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

// ---------------------------------------------------------------------------
// 五态展示模型（design: herdr-tab-redesign §4.3）。
// 保留现有 dotState() 给 StateDot primitive（已验证兼容 ongoing/error/done）；
// 新的共享展示模型供所有 UI 入口统一使用，避免各组件自行映射。
// ---------------------------------------------------------------------------

/** 协议状态 → 展示态（5 态；unknown 不再伪装 done）。 */
export type PaneDisplayState = 'working' | 'blocked' | 'idle' | 'done' | 'unknown'

/** 状态展示优先级（数值越小 = 越需要用户介入）。 */
const STATUS_PRIORITY: Record<PaneDisplayState, number> = {
  blocked: 0,
  working: 1,
  idle: 2,
  done: 3,
  unknown: 4,
}

/** 将任意协议状态归一化为展示态（缺失/空/未识别 → unknown）。 */
export function paneDisplayState(status: string | undefined): PaneDisplayState {
  switch (status) {
    case 'working': return 'working'
    case 'blocked': return 'blocked'
    case 'idle': return 'idle'
    case 'done': return 'done'
    default: return 'unknown'
  }
}

/** 展示态排序优先级（数值越小越优先）。 */
export function statusSortPriority(state: PaneDisplayState): number {
  return STATUS_PRIORITY[state]
}

/** 五态的无障碍文本 key（组件层通过 t() 获取双语文案）。 */
export function ariaStateLabel(state: PaneDisplayState): Extract<I18nKey, `status.${PaneDisplayState}`> {
  switch (state) {
    case 'working': return 'status.working'
    case 'blocked': return 'status.blocked'
    case 'idle': return 'status.idle'
    case 'done': return 'status.done'
    case 'unknown': return 'status.unknown'
  }
}

// ---------------------------------------------------------------------------
// 键盘交互模型（design: herdr-tab-redesign §5.3）。
// 把交互语义下沉为纯函数，组件只把结果接到 DOM，避免 UI 层复制键盘规则。
// ---------------------------------------------------------------------------

/** 键盘事件语义（纯数据，组件按此挂 handler）。 */
export interface KeyboardAction {
  /** 是否触发该动作。 */
  readonly trigger: boolean
  /** 是否需要 preventDefault（Enter/Space 默认触发按钮行为）。 */
  readonly preventDefault: boolean
}

/** 元素激活语义：Enter 或 Space 触发。 */
export function paneKeyboardHandlers(key: string): KeyboardAction {
  if (key === 'Enter' || key === ' ') return { trigger: true, preventDefault: true }
  return { trigger: false, preventDefault: false }
}

// ---------------------------------------------------------------------------
// 确认对话框焦点模型（design: herdr-tab-redesign §5.3）。
// ---------------------------------------------------------------------------

/** 对话框焦点模型描述（组件据此管理 DOM 焦点与关联触发器状态）。 */
export interface DialogFocusModel {
  /** 打开后焦点应进入的元素（'cancel' = 取消按钮 / 'confirm' = 确认按钮）。 */
  readonly initialFocus: 'cancel' | 'confirm'
  /** Escape 键是否取消对话框。 */
  readonly escapeCancels: boolean
  /** 标题关联 ID（aria-labelledby）。 */
  readonly titleId: string
  /** 对话框关闭后是否恢复关联触发控件焦点。 */
  readonly restoreFocus: true
  /** 焦点恢复目标。 */
  readonly restoreTarget: 'trigger'
}

/** 根据对话框属性派生焦点模型。 */
export function dialogFocusModel(opts: { busy?: boolean; titleId: string }): DialogFocusModel {
  return {
    // 处理中时焦点锁定在确认按钮（阻止误操作）；否则默认焦点在取消 button（安全操作优先）
    initialFocus: opts.busy ? 'confirm' : 'cancel',
    escapeCancels: !opts.busy,
    titleId: opts.titleId,
    restoreFocus: true,
    restoreTarget: 'trigger',
  }
}

export interface DisclosureState {
  readonly expanded: boolean
  readonly ariaExpanded: boolean
  readonly controlsId: string
}

export function disclosureState(expanded: boolean, controlsId: string): DisclosureState {
  return { expanded, ariaExpanded: expanded, controlsId }
}

export interface FocusableTarget {
  focus(): void
}

export function focusBeforeRemoval(target: FocusableTarget | null): void {
  target?.focus()
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
// ANSI SGR 解析器（design: pane-log-terminal-design §3）。
// 委托到 src/terminal-ansi.ts 独立模块（纯函数，不依赖 React/DOM）。
// ---------------------------------------------------------------------------
export type { AnsiColor, AnsiColorKind, AnsiStyle, AnsiToken, AnsiLine } from './terminal-ansi.ts'
export type { TerminalScreen, TerminalCell, TerminalCursor } from './terminal-ansi.ts'
export { parseAnsiOutput, ansiPlainText, stripAnsi, compactAnsiLines, trimAnsiSnapshotPadding, rebaseTerminalFrame, truncateAnsiTail, replayTerminalSnapshot } from './terminal-ansi.ts'

// ---------------------------------------------------------------------------
// 交互式终端输入映射与滚动状态（design: pane-interactive-terminal §3.3/§3.5）
// 纯函数，node:test 可直接覆盖。
// ---------------------------------------------------------------------------

/** 键盘映射结果：text 分支发送原始字符，keys 分支发送协议键名，unsupported 显示提示。 */
export type TerminalKeyResult =
  | { kind: 'text'; text: string }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'unsupported' }

/** 已证实可用的 send_keys 词汇（来源：pane-send-keys.ts 工具描述 + 集成实测）。 */
const CONFIRMED_KEYS = new Set([
  'enter', 'esc', 'tab', 'ctrl+c', 'alt+x', 'shift+tab', 'f1',
])

/**
 * 键盘事件 → terminal input mapping。
 * - 可打印字符 → text 分支
 * - Enter → text: '\r'
 * - Backspace → text: '\x7f'（DEL；部分终端用 \x08 BS）
 * - Delete → text: '\x1b[3~'
 * - 箭头 → text: '\x1b[A/B/C/D'
 * - Home/End → text: '\x1b[H/F'
 * - PageUp/PageDown → text: '\x1b[5~/6~'
 * - 已证实 keys 词汇 → keys 分支
 * - 其余 → unsupported
 */
export function mapTerminalKey(event: {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): TerminalKeyResult {
  const { key, ctrlKey, altKey, metaKey } = event

  // Ctrl/Alt/Meta chord：只发送已证实的词汇
  if (ctrlKey || altKey || metaKey) {
    const chord = `${ctrlKey ? 'ctrl+' : ''}${altKey ? 'alt+' : ''}${metaKey ? 'meta+' : ''}${key.toLowerCase()}`
    if (CONFIRMED_KEYS.has(chord)) return { kind: 'keys', keys: [chord] }
    return { kind: 'unsupported' }
  }

  // 特殊键 → 原始控制字节回退
  switch (key) {
    case 'Enter': return { kind: 'text', text: '\r' }
    case 'Backspace': return { kind: 'text', text: '\x7f' }
    case 'Delete': return { kind: 'text', text: '\x1b[3~' }
    case 'ArrowUp': return { kind: 'text', text: '\x1b[A' }
    case 'ArrowDown': return { kind: 'text', text: '\x1b[B' }
    case 'ArrowRight': return { kind: 'text', text: '\x1b[C' }
    case 'ArrowLeft': return { kind: 'text', text: '\x1b[D' }
    case 'Home': return { kind: 'text', text: '\x1b[H' }
    case 'End': return { kind: 'text', text: '\x1b[F' }
    case 'PageUp': return { kind: 'text', text: '\x1b[5~' }
    case 'PageDown': return { kind: 'text', text: '\x1b[6~' }
    case 'Tab': return { kind: 'text', text: '\t' }
    case 'Escape': return { kind: 'text', text: '\x1b' }
  }

  // 已证实的 keys 词汇（不通过 chord 匹配的独立键名）
  if (CONFIRMED_KEYS.has(key.toLowerCase())) {
    return { kind: 'keys', keys: [key.toLowerCase()] }
  }

  // 可打印字符（单字符、非控制字符）
  if (key.length === 1 && key >= ' ') {
    return { kind: 'text', text: key }
  }

  return { kind: 'unsupported' }
}

/** 终端滚动跟随状态。 */
export interface TerminalScrollState {
  atBottom: boolean
  pendingOutput: boolean
}

/** 滚动状态转移：用户滚动更新 atBottom；新输出到达时若 atBottom 则跟随，否则标记 pending。 */
export function terminalScrollTransition(
  prev: TerminalScrollState,
  newOutput: boolean,
  scrolledToBottom: boolean,
): TerminalScrollState {
  if (scrolledToBottom) return { atBottom: true, pendingOutput: false }
  // 用户滚动到非底部 → atBottom=false
  if (!newOutput) return { atBottom: false, pendingOutput: prev.pendingOutput }
  // 新输出到达且不在底部 → 标记 pending
  return { atBottom: false, pendingOutput: true }
}

/** 最大化焦点转移：进入最大化时返回焦点目标描述，退出时恢复。 */
export interface TerminalFocusTransition {
  /** 进入最大化后焦点应移到何处。 */
  enterTarget: 'input'
  /** 退出最大化后焦点应恢复到何处（trigger element id）。 */
  restoreTarget: string | null
}

export function terminalFocusTransition(
  maximized: boolean,
  triggerId: string | null,
): TerminalFocusTransition {
  return {
    enterTarget: 'input',
    restoreTarget: maximized ? null : triggerId,
  }
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

// ---------------------------------------------------------------------------
// Herdr Dashboard 聚合（design: dashboard —— 本机只读控制面总览）。
// 纯函数：服务端 DTO 装配（src/dashboard.ts）与 Web 面板共用，node:test 直接覆盖。
// 脱敏约定：完整本地路径只以 basename 进入 DTO（pathBase），不泄露 cwd/socket 绝对路径。
// ---------------------------------------------------------------------------

/** agent 状态展示优先级（其余状态按字母序追加）。 */
const AGENT_STATUS_ORDER = ['working', 'blocked', 'idle', 'done', 'unknown'] as const

/** 按 agent 状态计数（缺失/空字符串归 unknown；空数组返回空对象）。 */
export function agentStatusCounts(agents: ReadonlyArray<{ status?: string | null }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const a of agents) {
    const s = a.status || 'unknown'
    counts[s] = (counts[s] ?? 0) + 1
  }
  return counts
}

/** 状态计数 → 稳定排序的 [status, count] 数组（working/blocked/idle/done/unknown 优先，其余按字母序；仅 >0）。 */
export function sortedStatusCounts(counts: Record<string, number>): Array<[string, number]> {
  const priority = AGENT_STATUS_ORDER.filter(k => (counts[k] ?? 0) > 0)
  const rest = Object.keys(counts).filter(k => !(AGENT_STATUS_ORDER as readonly string[]).includes(k)).sort()
  return [...priority, ...rest].map(k => [k, counts[k] ?? 0] as [string, number])
}

/**
 * 路径 → basename（脱敏：Dashboard 只展示 basename，不把完整本地路径写入 DTO/日志）。
 * ''/'/'/尾斜杠 → null；'a' → 'a'；'/a/b' → 'b'；'a\\b' → 'b'。
 */
export function pathBase(p: string | null | undefined): string | null {
  if (!p) return null
  const cleaned = p.replace(/[\\/]+$/, '')
  if (!cleaned) return null
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  const base = idx >= 0 ? cleaned.slice(idx + 1) : cleaned
  return base === '' ? null : base
}

/** 字节 → 人类可读（B/KB/MB/GB/TB；缺失/非法返回 null → UI 显示 Unavailable，绝不显示伪造 0）。 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 时长 → 人类可读（ms/s/m/h；缺失/非法返回 null）。 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

/** stale 派生：从未成功刷新（updatedAt=0）或距最近成功刷新超过阈值。 */
export function deriveStale(updatedAt: number, now: number, thresholdMs: number): boolean {
  return updatedAt === 0 || now - updatedAt > thresholdMs
}

/** 进程探测节流判定：从未探测或距上次探测 ≥ interval → 重新探测（纯函数，可测）。 */
export function shouldProbeNow(lastProbeAt: number, now: number, probeIntervalMs: number): boolean {
  return lastProbeAt === 0 || now - lastProbeAt >= probeIntervalMs
}

/** agent 明细（v4：全局 agent 视图与 Treemap 的数据源）。 */
export interface DashboardAgentDetail {
  pane_id: string
  /** 自定义名称（target）；缺失时展示回退 name/kind。 */
  name?: string
  /** best-effort kind（回退链 kind → agent → unknown；协议兼容推断）。 */
  kind: string
  status: string
}

/** workspace 内单个 pane 明细（服务端 DTO 与 Web 镜像类型共用）。 */
export interface DashboardPaneDetail {
  pane_id: string
  /** topology label（pane 显示名；可能为 null）。 */
  label: string | null
  /** 归属 agent 的归一化 kind；非 agent pane 为 'unknown'。 */
  kind: string
  /** 自定义 target 名称（无则 undefined）。 */
  name?: string
  /** 状态输入（agent.status；非 agent 回退 agent_status）。 */
  status: string
}

/** 单个 workspace 的 Dashboard 聚合记录（服务端 DTO 与 Web 镜像类型共用）。 */
export interface DashboardWorkspaceAgg {
  workspace_id: string
  label: string | null
  /** 脱敏：checkout_path 的 basename（原始绝对路径不进入 DTO）。 */
  checkout_path_base: string | null
  tab_count: number
  pane_count: number
  agent_count: number
  agents_working: number
  agents_blocked: number
  /** v4：workspace 内 agent 明细（同一份数据服务名称列表/Treemap/tooltip）。 */
  agents: DashboardAgentDetail[]
  /** v5：workspace 内 pane 明细（可点击跳转 / 可关闭；含非 agent 纯终端 pane）。 */
  panes: DashboardPaneDetail[]
}

/** 聚合输入的最小 workspace 形状。 */
export interface DashboardWorkspaceLike {
  workspace_id?: string
  label?: string | null
  checkout_path?: string | null
}

/** 聚合输入的最小拓扑形状（同时兼容服务端 status.ts 拓扑与 Web 镜像类型）。 */
export interface DashboardTopologyLike {
  workspaces: ReadonlyArray<DashboardWorkspaceLike>
  tabs: ReadonlyArray<{ workspace_id?: string }>
  panes: ReadonlyArray<{
    pane_id?: string
    workspace_id?: string
    /** pane 显示名（rename 后即时；可能为 null）。 */
    label?: string | null
    /** 非 agent pane 的状态输入（agent pane 用 agent.status 优先）。 */
    agent_status?: string
  }>
}

/** 聚合输入的最小 agent 形状。 */
export interface DashboardAgentLike {
  pane_id?: string | null
  workspace_id?: string | null
  name?: string | null
  kind?: string | null
  agent?: string | null
  status?: string | null
}

/**
 * kind 归一化（v4）：kind → agent → unknown 回退链。name 是自定义 target，
 * 不得当 kind 用（协议无正式 kind 字段，此为兼容推断）。
 */
export function normalizeAgentKind(kind: string | null | undefined, agent: string | null | undefined): string {
  if (kind && kind.trim() !== '') return kind
  if (agent && agent.trim() !== '') return agent
  return 'unknown'
}

const DASHBOARD_KINDS = ['codex', 'pi', 'opencode', 'claude', 'dsh'] as const

export type DashboardKind = typeof DASHBOARD_KINDS[number] | 'unknown'

function isDashboardKind(value: string): value is DashboardKind {
  switch (value) {
    case 'codex':
    case 'pi':
    case 'opencode':
    case 'claude':
    case 'dsh':
      return true
    default:
      return false
  }
}

export function normalizeDashboardKind(kind: string | null | undefined): DashboardKind {
  const normalized = kind?.trim().toLowerCase() ?? ''
  return isDashboardKind(normalized) ? normalized : 'unknown'
}

export function normalizeDashboardKindCounts(kinds: ReadonlyArray<{ kind: string; value: number }>): Array<{ kind: DashboardKind; value: number }> {
  const counts = new Map<DashboardKind, number>()
  for (const entry of kinds) {
    const kind = normalizeDashboardKind(entry.kind)
    counts.set(kind, (counts.get(kind) ?? 0) + entry.value)
  }
  return [...counts].map(([kind, value]) => ({ kind, value }))
}

/**
 * workspace 聚合：tabs/panes/agents 计数 + agent 状态汇总 + agent 明细挂载。
 * - agent 归属优先 workspace_id；缺失时按 pane_id 反查 topology（协议兼容降级）；
 * - 缺失/未知状态归 unknown；workspace_id 缺失的 pane/agent 忽略；
 * - 结果按 workspace_id 自然排序（w2 < w10）。
 */
export function aggregateDashboardWorkspaces(
  topology: DashboardTopologyLike,
  agents: ReadonlyArray<DashboardAgentLike>,
): DashboardWorkspaceAgg[] {
  const tabCount = new Map<string, number>()
  for (const t of topology.tabs) {
    if (!t.workspace_id) continue
    tabCount.set(t.workspace_id, (tabCount.get(t.workspace_id) ?? 0) + 1)
  }
  const panesByWs = new Map<string, Array<DashboardTopologyLike['panes'][number]>>()
  const wsByPane = new Map<string, string>()
  for (const p of topology.panes) {
    if (!p.workspace_id) continue
    const arr = panesByWs.get(p.workspace_id) ?? []
    arr.push(p)
    panesByWs.set(p.workspace_id, arr)
    if (p.pane_id) wsByPane.set(p.pane_id, p.workspace_id)
  }
  const wsAgents = new Map<string, DashboardAgentDetail[]>()
  for (const a of agents) {
    if (!a.pane_id) continue
    const wsId = a.workspace_id ?? wsByPane.get(a.pane_id)
    if (!wsId) continue
    const arr = wsAgents.get(wsId) ?? []
    arr.push({
      pane_id: a.pane_id,
      name: a.name ?? undefined,
      kind: normalizeAgentKind(a.kind, a.agent),
      status: a.status || 'unknown',
    })
    wsAgents.set(wsId, arr)
  }
  return topology.workspaces
    .filter((w): w is DashboardWorkspaceLike & { workspace_id: string } => Boolean(w.workspace_id))
    .map(w => {
      const id = w.workspace_id
      const panes = panesByWs.get(id) ?? []
      const agentsOfWs = wsAgents.get(id) ?? []
      const counts = agentStatusCounts(agentsOfWs.map(a => ({ status: a.status })))
      const agentByPaneId = new Map(agentsOfWs.map(a => [a.pane_id, a] as const))
      const paneDetails: DashboardPaneDetail[] = panes
        .filter((p): p is DashboardTopologyLike['panes'][number] & { pane_id: string } => Boolean(p.pane_id))
        .map(p => {
          const agent = agentByPaneId.get(p.pane_id)
          return {
            pane_id: p.pane_id,
            label: p.label ?? null,
            kind: agent?.kind ?? 'unknown',
            name: agent?.name,
            status: agent?.status ?? p.agent_status ?? 'unknown',
          }
        })
        .sort((a, b) => comparePaneId(a.pane_id, b.pane_id))
      return {
        workspace_id: id,
        label: w.label ?? null,
        checkout_path_base: pathBase(w.checkout_path),
        tab_count: tabCount.get(id) ?? 0,
        pane_count: panes.length,
        agent_count: agentsOfWs.length,
        agents_working: counts['working'] ?? 0,
        agents_blocked: counts['blocked'] ?? 0,
        agents: agentsOfWs,
        panes: paneDetails,
      }
    })
    .sort((a, b) => compareWorkspaceId(a.workspace_id, b.workspace_id))
}

/**
 * 全局 agent 收集（v4 需求 4）：合并所有 workspace 的 agent 明细并稳定排序
 * kind → name → pane_id（轮询顺序变化不造成视觉抖动）。
 */
export function collectDashboardAgents(workspaces: ReadonlyArray<Pick<DashboardWorkspaceAgg, 'agents'>>): DashboardAgentDetail[] {
  const all = workspaces.flatMap(w => w.agents ?? [])
  return all.sort((a, b) => {
    const k = a.kind.localeCompare(b.kind)
    if (k !== 0) return k
    const n = (a.name ?? '').localeCompare(b.name ?? '')
    if (n !== 0) return n
    return a.pane_id.localeCompare(b.pane_id)
  })
}

/** workspace agent kind → 计数（Treemap 输入；按计数降序）。 */
export function agentKindCounts(agents: ReadonlyArray<Pick<DashboardAgentDetail, 'kind'>>): Array<{ kind: string; value: number }> {
  const counts = new Map<string, number>()
  for (const a of agents) {
    counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, value]) => ({ kind, value }))
    .sort((a, b) => b.value - a.value || a.kind.localeCompare(b.kind))
}

/** Dashboard 汇总计数（workspaces/tabs/panes/agents + 状态分布）。 */
export interface DashboardSummaryLike {
  workspaces: number
  tabs: number
  panes: number
  agents: number
  agents_by_status: Record<string, number>
}

/** 汇总：总数 + agent 状态分布（同一轮归一化快照内计算，避免跨时间点）。 */
export function buildDashboardSummary(
  workspaces: ReadonlyArray<Pick<DashboardWorkspaceAgg, 'tab_count' | 'pane_count'>>,
  agents: ReadonlyArray<DashboardAgentLike>,
): DashboardSummaryLike {
  return {
    workspaces: workspaces.length,
    tabs: workspaces.reduce((n, w) => n + w.tab_count, 0),
    panes: workspaces.reduce((n, w) => n + w.pane_count, 0),
    agents: agents.length,
    agents_by_status: agentStatusCounts(agents),
  }
}

// ---------------------------------------------------------------------------
// 全局 Dashboard 打开状态（design: dashboard-global §7.1）。
// createGlobalDashboardStore：可测的显式 store（非模块级 open flag）；多个入口
// （sidebar 按钮 / 旧 Herdr tab 降级按钮）共享同一实例，订阅即反映切换。
// ---------------------------------------------------------------------------

export interface GlobalDashboardStore {
  /** 订阅打开状态；返回退订函数（无 DOM/React 依赖）。 */
  subscribe(listener: () => void): () => void
  getOpen(): boolean
  open(): void
  close(): void
  toggle(): void
}

/** 全局面板打开状态 store（纯逻辑；React 侧用 useSyncExternalStore 订阅）。 */
export function createGlobalDashboardStore(): GlobalDashboardStore {
  let open = false
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const l of [...listeners]) l()
  }
  const set = (next: boolean) => {
    if (next === open) return // 幂等：无变化不通知
    open = next
    emit()
  }
  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getOpen: () => open,
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!open),
  }
}

// ---------------------------------------------------------------------------
// marker 服务状态派生（v4 需求 2：运行中/已停止/未安装/检查中三态 + 中性诊断态）。
// 数据源复用 statusStore 快照（/herdr-status 单飞轮询；marker 不另起全量轮询）。
// ---------------------------------------------------------------------------

/** marker 状态点语义（视觉色 + i18n 文本）。 */
export type MarkerServerState = 'running' | 'stopped' | 'not-installed' | 'checking'

/**
 * 三态派生：running（server.running）；not_running + installation=missing →
 * not-installed；not_running → stopped；无快照/unknown/HTTP 失败 → checking。
 * 不得把任意 fetch 失败误判为 stopped/not-installed。
 */
export function deriveMarkerServerState(snap: {
  server?: { running?: boolean; status?: string; installation?: string }
} | null): MarkerServerState {
  if (!snap?.server) return 'checking'
  const server = snap.server
  if (server.running === true) return 'running'
  if (server.status === 'not_running') {
    return server.installation === 'missing' ? 'not-installed' : 'stopped'
  }
  return 'checking'
}

// ---------------------------------------------------------------------------
// Dashboard pane → 会话跳转能力（v4 交互：Treemap 块点击跳转当前会话 pane）。
// derivePaneNavState：pane 归属（/herdr-pane-session 反查）vs 当前 DSH 会话。
// 纯函数，node:test 直测；React 组件只负责调用与提示。
// ---------------------------------------------------------------------------

/** pane 跳转能力派生：self（属于当前会话可跳转）| foreign（其他会话）| unbound（无归属）。 */
export type PaneNavState = 'self' | 'foreign' | 'unbound'

export function derivePaneNavState(
  selfSessionId: string | undefined,
  paneSessionId: string | null | undefined,
): PaneNavState {
  if (!paneSessionId) return 'unbound'
  if (selfSessionId && paneSessionId === selfSessionId) return 'self'
  return 'foreign'
}

// ---------------------------------------------------------------------------
// workspace 状态堆积条（design: dashboard-redesign §4 —— 替代 agent-kind Treemap）。
// 纯函数：每个 agent 状态经 paneDisplayState 归一 → 规范顺序聚合（working → blocked
// → idle → done → unknown），丢弃 0 计数；ratio 为该段占全部 agent 的比例（合计 1）。
// ---------------------------------------------------------------------------

export interface StackedBarSegment {
  state: PaneDisplayState
  count: number
  /** 占全部 agent 的比例（0..1；各段合计 ≈1）。 */
  ratio: number
}

const STACKED_BAR_ORDER: readonly PaneDisplayState[] = ['working', 'blocked', 'idle', 'done', 'unknown']

/** 状态堆积条分段：输入 agent 状态数组，输出规范顺序、非零计数、比例守恒的分段。 */
export function stackedBarSegments(statuses: ReadonlyArray<string | undefined>): StackedBarSegment[] {
  const counts = new Map<PaneDisplayState, number>()
  for (const s of statuses) {
    const state = paneDisplayState(s)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const total = statuses.length
  if (total === 0) return []
  const segments: StackedBarSegment[] = []
  for (const state of STACKED_BAR_ORDER) {
    const count = counts.get(state) ?? 0
    if (count === 0) continue
    segments.push({ state, count, ratio: count / total })
  }
  return segments
}

// ---------------------------------------------------------------------------
// 侧栏 marker 注入与 surface 边界（design: dashboard-global v3 —— 插件-only）。
// 按钮进入 sidebar 文档流（marker 插到 regionArea 之前），不悬浮不遮挡；
// surface 从 sidebar 右边界覆盖整个右侧工作区。纯函数可 node:test 直接覆盖；
// DOM 查询/observer 留在组件层。
// ---------------------------------------------------------------------------

/** rail 态 36x36 控件盒（对齐 DSH sidebar 的 rail spec）。 */
export const SIDEBAR_RAIL_WIDTH = 36
/** 锚点宽度 ≤ 此值判定为 rail（rail capsule 36px；wide 全宽行 ≥100px）。 */
export const SIDEBAR_RAIL_WIDTH_THRESHOLD = 60

/** New Session 锚点选择器（主：CSS module 类名子串；兜底：双语 aria-label）。 */
export const NEW_SESSION_SELECTORS = [
  '[class*="newSession"]',
  '[aria-label="新建会话"]',
  '[aria-label="New session"]',
] as const

/** workspace/session 浏览区（sidebar.workspaces 渲染容器）选择器。 */
export const REGION_AREA_SELECTOR = '[class*="regionArea"]'
/** marker 根元素标识（防重复注入与 DOM 定位）。 */
export const SIDEBAR_MARKER_DATA = 'data-herdr-sidebar-button'

/** 锚点宽度 → 是否 rail（窄栏/折叠态；marker 按钮形态据此切换）。 */
export function isSidebarRail(anchorWidth: number): boolean {
  return anchorWidth <= SIDEBAR_RAIL_WIDTH_THRESHOLD
}

/** marker 注入合法性判定结果。 */
export interface SidebarMarkerResolution {
  ok: boolean
  /** ok=false 时的诊断原因（不注入，避免误插/孤儿按钮）。 */
  reason: 'no-anchor' | 'no-region-area' | 'not-same-sidebar' | null
}

/** marker 按钮 aria-pressed 值派生（open → 'true'；原生 DOM 按钮非 React，由订阅同步）。 */
export function deriveMarkerPressed(open: boolean): 'true' | 'false' {
  return open ? 'true' : 'false'
}

/**
 * marker 注入校验（P1-1：祖先关系而非严格同父）。
 * regionArea 由 DSH SidebarRoot 直接管理；New Session 按钮可能被 Tooltip 等
 * 包装节点包裹（当前 primitives Tooltip 用 cloneElement 无包装节点，但未来包装
 * 变化不应破坏注入），因此用 `contains(regionParent, anchor)` 祖先关系判定两者
 * 属于同一 sidebar root；插入点恒为 regionParent 上的 regionArea 之前。
 */
export function resolveSidebarMarker(
  regionParent: unknown,
  anchor: unknown,
  contains: (container: unknown, node: unknown) => boolean,
): SidebarMarkerResolution {
  if (regionParent == null) return { ok: false, reason: 'no-region-area' }
  if (anchor == null) return { ok: false, reason: 'no-anchor' }
  if (!contains(regionParent, anchor)) return { ok: false, reason: 'not-same-sidebar' }
  return { ok: true, reason: null }
}

/** surface 左边界测量输入（sidebar column 可见 rect 或 null=测量失败）。 */
export interface SidebarColumnRect {
  left: number
  right: number
}

/** 右侧工作区 surface 的 fixed 边界（不覆盖 sidebar）。 */
export interface GlobalSurfaceBounds {
  left: number
  top: number
  width: number
  height: number
}

/**
 * surface 边界：left = sidebar 右缘（不覆盖 sidebar）；top/height 全高。
 * 测量失败（sidebar 不可见）→ 全屏覆盖：保证 surface 完整可读、关闭入口
 * （关闭按钮/Escape）始终可用；sidebar 恢复后由 observer 重测回退。
 */
export function computeGlobalSurfaceBounds(
  sidebar: SidebarColumnRect | null,
  viewportWidth: number,
  viewportHeight: number,
): GlobalSurfaceBounds {
  if (sidebar === null) {
    return { left: 0, top: 0, width: viewportWidth, height: viewportHeight }
  }
  const left = sidebar.right
  return {
    left,
    top: 0,
    width: Math.max(0, viewportWidth - left),
    height: viewportHeight,
  }
}
