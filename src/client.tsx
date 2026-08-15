// dsh-plugin-herdr 客户端插件（Web 面板）：Herdr 视图 + 会话页右侧 pane 状态列表。
// 组件来自 dsh-client-ui-primitives（StateDot / Pill / Button / TerminalBlock）——
// 该包由 web shell 的 ClientModuleLoader 提供（tsdown external），本地用宽松类型桥
// 保持编译期契约（与 SlotsApi 同一策略）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Pill, StateDot, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  buildGroups,
  comparePaneId,
  compareWorkspaceId,
  computeSnapPosition,
  createStatusStore,
  dotState,
  formatTime,
  isDragMovement,
  parseStartResponse,
  shouldAutoExpand,
  toggleCollapse,
} from './client-logic.ts'

// ---------------------------------------------------------------------------
// primitives 宽松类型桥（运行时由 ModuleLoader 解析真实实现）
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function StateDot(p: { state: string; size?: number; className?: string }): ReactNode
  export function Pill(p: { active?: boolean; className?: string; children?: ReactNode } & Record<string, unknown>): ReactNode
  export function Button(p: { variant?: string; size?: string; icon?: ReactNode; children?: ReactNode } & Record<string, unknown>): ReactNode
  export function TerminalBlock(p: {
    command: string
    cwd?: string
    home?: string
    output?: string
    exitCode?: number
    signal?: string
    running?: boolean
    maxLines?: number
    className?: string
  }): ReactNode
}

// ---------------------------------------------------------------------------
// 样式注入（布局样式全部使用 DSH 真实 token；组件样式由 web shell 提供）
// ---------------------------------------------------------------------------

const STYLE_ID = 'dsh-plugin-herdr-styles'

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.herdr-root {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px 24px; min-height: 100%; box-sizing: border-box;
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.herdr-head {
  position: sticky; top: 0; z-index: 4;
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0 10px;
  background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.herdr-head-title { font-size: 15px; font-weight: 600; }
.herdr-head-stats { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.herdr-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.herdr-ws-list { display: flex; flex-direction: column; gap: 2px; }
.herdr-ws { border-radius: 12px; }
.herdr-ws + .herdr-ws { margin-top: 12px; }
.herdr-ws-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 10px; cursor: pointer;
  user-select: none;
}
.herdr-ws-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-ws-chev {
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); flex: none;
  transition: transform .15s var(--ds-ease-in-out);
}
.herdr-ws[data-collapsed] .herdr-ws-chev { transform: rotate(-90deg); }
.herdr-ws-label { font-size: 14px; line-height: 22px; font-weight: 500; }
.herdr-ws-id {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform);
  border-radius: 5px; padding: 0 6px;
}
.herdr-ws-stats { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.herdr-ws-stats b { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.herdr-ws-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 6px 4px; }
.herdr-ws[data-collapsed] .herdr-ws-body { display: none; }
.herdr-pane {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-pane:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.herdr-pane[data-focused] { border-color: var(--dsw-alias-state-business-primary); }
.herdr-pane-id {
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; font-weight: 500;
}
.herdr-pane-focus { color: var(--dsw-alias-state-business-primary); font-size: 11px; }
.herdr-pane-meta { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.herdr-pane-cwd {
  font-family: var(--ds-font-family-code); font-size: 11px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.herdr-pane-time { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.herdr-pane-chev {
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform .15s var(--ds-ease-in-out);
}
.herdr-pane[data-open] .herdr-pane-chev { transform: rotate(90deg); }
.herdr-pane-out { display: none; flex-direction: column; gap: 8px; padding: 0 4px; }
.herdr-pane[data-open] + .herdr-pane-out { display: flex; }
.herdr-pane-message { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 0 12px; }
.herdr-dot-muted { opacity: .35; }
.herdr-state-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.herdr-state-text[data-state=done] { color: var(--dsw-alias-state-success-primary); }
.herdr-state-text[data-state=warning] { color: var(--dsw-alias-state-warn-primary); }
.herdr-state-text[data-state=error] { color: var(--dsw-alias-state-error-primary); }
.herdr-agent-pill .herdr-agent-name { font-weight: 500; }
.herdr-empty {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  padding: 28px 16px; text-align: center; line-height: 20px;
}
.herdr-empty code {
  font-family: var(--ds-font-family-code);
  font-size: 11px; background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px; padding: 1px 5px;
}
/* ── 会话页右侧 pane 状态列表面板 ─────────────────────────────── */
.pane-list-panel {
  position: fixed; top: 56px; right: 16px; width: 264px; z-index: 30;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv2);
  display: flex; flex-direction: column;
  max-height: calc(100vh - 72px);
}
.pane-list-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab;
}
.pane-list-head:active { cursor: grabbing; }
.pane-list-title { font-size: 13px; font-weight: 500; line-height: 20px; }
.pane-list-meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.pane-list-collapse {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; flex: none;
}
.pane-list-collapse:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.pane-list-body { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.pane-list-body::-webkit-scrollbar { width: 6px; }
.pane-list-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.pl-group { border-radius: 8px; }
.pl-group + .pl-group { margin-top: 4px; }
.pl-group-head {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 7px; cursor: pointer;
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
  user-select: none;
}
.pl-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pl-group-head .chev { width: 12px; height: 12px; transition: transform .15s var(--ds-ease-in-out); flex: none; }
.pl-group[data-collapsed] .chev { transform: rotate(-90deg); }
.pl-group-head .ws { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
.pl-group-head .n { margin-left: auto; font-variant-numeric: tabular-nums; }
.pl-group[data-collapsed] .pl-group-body { display: none; }
.pl-group-body { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 3px; }
.pl-row {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 8px; border-radius: 7px;
  min-height: 26px;
  cursor: pointer;
}
.pl-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pl-row[data-self] { background: var(--dsw-alias-state-business-tertiary); }
.pl-row[data-self]:hover { background: var(--dsw-alias-interactive-bg-hover-accent); }
.pl-paneid { font-family: var(--ds-font-family-code); font-size: 11.5px; line-height: 16px; font-weight: 500; }
.pl-agent { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-state { margin-left: auto; font-size: 11px; line-height: 16px; flex: none; }
.pl-state[data-state=done] { color: var(--dsw-alias-state-success-primary); }
.pl-state[data-state=warning] { color: var(--dsw-alias-state-warn-primary); }
.pl-state[data-state=error] { color: var(--dsw-alias-state-error-primary); }
.pl-self-tag {
  font-size: 9.5px; line-height: 14px; font-weight: 600; flex: none;
  color: var(--dsw-alias-state-business-primary);
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 4px; padding: 0 4px;
}
/* 折叠态：仅 Herdr logo 圆钮 */
.pane-list-min {
  position: fixed; top: 56px; right: 16px; z-index: 30;
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 50%;
  box-shadow: var(--dsw-shadow-lv2);
  cursor: grab;
  transition: background .15s var(--ds-ease-in-out), box-shadow .15s var(--ds-ease-in-out);
}
.pane-list-min:active { cursor: grabbing; }
.pane-list-min:hover { background: var(--dsw-alias-interactive-bg-hover); box-shadow: var(--dsw-shadow-lv3); }
.pane-list-min .logo-svg { width: 22px; height: 22px; display: block; color: var(--dsw-alias-label-primary); }
.pane-list-head .logo-svg { width: 16px; height: 16px; display: block; flex: none; color: var(--dsw-alias-label-tertiary); }
.pane-list-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; flex: none; padding: 0;
}
.pane-list-logo:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* 跳转定位高亮 */
.herdr-pane-flash {
  animation: herdr-pane-flash 1.4s var(--ds-ease-in-out);
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary);
}
@keyframes herdr-pane-flash {
  0% { box-shadow: 0 0 0 0 var(--dsw-alias-state-business-tertiary); }
  30% { box-shadow: 0 0 0 6px var(--dsw-alias-state-business-tertiary); }
  100% { box-shadow: 0 0 0 0 var(--dsw-alias-state-business-tertiary); }
}
/* ── 服务状态看板条 / 胶囊 / 安装提示 / hero 卡片 ─────────────── */
.herdr-server-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 10px;
  font-size: 12px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.herdr-conn-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.herdr-conn-dot.ok { background: var(--dsw-alias-state-success-primary); }
.herdr-conn-dot.bad { background: var(--dsw-alias-state-error-primary); }
.herdr-server-title { font-weight: 600; }
.herdr-server-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-left: auto; white-space: nowrap; }
.herdr-server-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); margin-top: 6px; }
.herdr-server-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.herdr-banner-stopped { border-color: var(--dsw-alias-state-warn-secondary); background: var(--dsw-alias-state-warn-tertiary); }
.herdr-banner-running { border-color: var(--dsw-alias-state-success-secondary); background: var(--dsw-alias-state-success-tertiary); }
.herdr-hero-card {
  position: fixed; top: 56px; right: 16px; width: 320px; z-index: 30;
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3);
}
.herdr-hero-card .herdr-server-banner { border-radius: 12px; }
.herdr-hero-card .herdr-server-error { padding: 0 12px 8px; }
.herdr-hero-card .herdr-server-note { padding: 0 12px 8px; }
.herdr-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 999px; padding: 3px 10px; cursor: default;
}
.herdr-pill button {
  border: none; background: none; color: inherit;
  font-size: 11px; font-weight: 600; padding: 0; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.herdr-pill button:hover { color: var(--dsw-alias-label-primary); }
.herdr-pill button:disabled { opacity: .55; cursor: default; }
.herdr-install {
  font-size: 12px; color: var(--dsw-alias-label-primary);
  padding: 10px 12px; border-radius: 10px;
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  line-height: 20px;
}
.herdr-install-title { font-weight: 600; margin-bottom: 4px; color: var(--dsw-alias-state-warn-label); }
.herdr-install code {
  font-family: var(--ds-font-family-code);
  font-size: 11px; background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px; padding: 1px 6px; user-select: all;
}
.herdr-install a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.herdr-install a:hover { text-decoration: underline; }
`
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// 宽松类型桥：slots / sessions
// ---------------------------------------------------------------------------

interface SlotsApi {
  inject(name: string, register: () => unknown): unknown
  register(opts: Record<string, unknown>, Component: unknown): unknown
}

interface ClientCtx {
  slots: SlotsApi
  inject(name: string | string[], callback: (scope: unknown) => unknown): unknown
  effect(fn: () => unknown): unknown
}

// ---------------------------------------------------------------------------
// 状态类型（与服务端 src/status.ts 一致）
// ---------------------------------------------------------------------------

export interface HerdrAgentStatus {
  pane_id: string
  workspace_id?: string
  agent: string
  status: string
  message?: string
  output: string
  updated_at: number
}

export interface HerdrServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  socket: string | null
  session: string | null
  checked_at: number
}

export interface HerdrWorkspaceView {
  workspace_id: string
  label?: string
  active_tab_id?: string
}

export interface HerdrTabView {
  tab_id: string
  workspace_id: string
  label?: string
  active_pane_id?: string
  pane_count?: number
}

export interface HerdrPaneView {
  pane_id: string
  workspace_id: string
  tab_id?: string
  title?: string
  cwd?: string
  foreground_cwd?: string
  focused: boolean
  agent_status?: string
}

export interface HerdrTopology {
  workspaces: HerdrWorkspaceView[]
  tabs: HerdrTabView[]
  panes: HerdrPaneView[]
}

export interface HerdrStatusSnapshot {
  agents: HerdrAgentStatus[]
  updated_at: number
  connected: boolean
  cli?: {
    available: boolean
    path: string
    version?: string
  }
  server?: HerdrServerInfo
  topology?: HerdrTopology
}

// ---------------------------------------------------------------------------
// 数据获取：模块级共享轮询（多组件订阅同一数据源；逻辑见 client-logic.ts）
// ---------------------------------------------------------------------------

async function fetchStatus(signal: AbortSignal): Promise<HerdrStatusSnapshot> {
  const resp = await fetch('/herdr-status', { signal })
  if (!resp.ok) throw new Error(`herdr-status HTTP ${resp.status}`)
  return (await resp.json()) as HerdrStatusSnapshot
}

const statusStore = createStatusStore<HerdrStatusSnapshot>({ fetch: fetchStatus })

function useHerdrStatus(): { snap: HerdrStatusSnapshot | null; error: string | null; refresh: () => void } {
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

function useHerdrStart(): { starting: boolean; startError: string | null; start: () => Promise<boolean> } {
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
// 浮动拖动：面板/折叠按钮可拖动，松手水平吸附到最近的页面边界
// （纯数学见 client-logic.ts 的 computeSnapPosition / isDragMovement）
// ---------------------------------------------------------------------------

interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
}

type ReactPointerEvent = {
  button?: number
  clientX: number
  clientY: number
  pointerId: number
  currentTarget: { setPointerCapture(id: number): void; releasePointerCapture(id: number): void }
}

const SNAP = 16

/**
 * 拖动 + 吸附（position: fixed 元素；ref 提供元素尺寸）。
 * pos/setPos 由调用方传入——面板与折叠圆钮共享同一位置，折叠/展开不丢失位置。
 * consumeDragged()：读取并清除"本次指针序列是否发生拖动"（pointerup 设、click 读），
 * 防止拖动后的 click 误触（如拖动 logo 圆钮不应展开面板）。
 */
function useFloatingDrag<T extends HTMLElement>(
  ref: { current: T | null },
  pos: { x: number; y: number } | null,
  setPos: (p: { x: number; y: number } | null) => void,
  enabled: boolean,
): { handlers: DragHandlers; consumeDragged: () => boolean } {
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && isDragMovement(dx, dy)) d.moved = true
    if (d.moved) setPos({ x: d.baseX + dx, y: d.baseY + dy })
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!d) return
    if (d.moved) {
      draggedRef.current = true
      const el = ref.current
      if (!el) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const x = d.baseX + (e.clientX - d.startX)
      const y = d.baseY + (e.clientY - d.startY)
      // 分左右吸附：右侧 → 视口右边界；左侧 → 侧边栏右缘（AppFrame 的
      // sidebar col，overlay 层的父级 frame 的首个子元素）
      let sidebarW = 0
      if (x + el.offsetWidth / 2 < vw / 2) {
        const overlay = document.querySelector('[data-shell-overlay]')
        const sidebar = overlay?.parentElement?.firstElementChild
        sidebarW = sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
      }
      setPos(computeSnapPosition({
        x, y,
        w: el.offsetWidth,
        h: el.offsetHeight,
        vw, vh,
        sidebarW,
        snap: SNAP,
      }))
    }
  }

  const consumeDragged = (): boolean => {
    const v = draggedRef.current
    draggedRef.current = false
    return v
  }

  return { handlers: { onPointerDown, onPointerMove, onPointerUp }, consumeDragged }
}

// ---------------------------------------------------------------------------
// Herdr Tab 跳转：切换到 Herdr 视图并定位对应 pane
// ---------------------------------------------------------------------------

/** 待定位的 pane（Herdr 视图挂载时消费；面板点击 → 切 tab 的时序兜底）。 */
let pendingFocusPane: string | null = null

function focusPaneInHerdrTab(paneId: string): void {
  pendingFocusPane = paneId
  // 切换到 Herdr 视图 tab（模拟用户点击 header tab）
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(t => (t.textContent ?? '').trim() === 'Herdr')
  if (tab instanceof HTMLElement) tab.click()
  // 事件广播：Herdr 视图已挂载时直接定位
  document.dispatchEvent(new CustomEvent('herdr:focus-pane', { detail: { paneId } }))
}

// ---------------------------------------------------------------------------
// 服务状态看板条（会话页 Herdr Tab 顶部 + 新建会话浮层卡片复用）
// ---------------------------------------------------------------------------

function HerdrServerBanner({ snap, error, onStarted }: { snap: HerdrStatusSnapshot | null; error: string | null; onStarted?: () => void }) {
  const { starting, startError, start } = useHerdrStart()
  const server = snap?.server
  const cliAvailable = snap?.cli?.available !== false

  const handleStart = async () => {
    const ok = await start()
    if (ok) onStarted?.()
  }

  let body: ReactNode
  if (!snap) {
    body = (
      <>
        <span className="herdr-conn-dot" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
        <span className="herdr-server-title">检查 herdr 服务…</span>
      </>
    )
  } else if (error) {
    body = (
      <>
        <span className="herdr-conn-dot bad" />
        <span className="herdr-server-title">herdr 服务状态不可用</span>
        <span className="herdr-server-error">{error}</span>
      </>
    )
  } else if (!cliAvailable) {
    body = (
      <>
        <span className="herdr-conn-dot" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
        <span className="herdr-server-title">herdr CLI 未安装</span>
        <span className="herdr-server-note">安装后自动出现启动按钮</span>
      </>
    )
  } else if (server?.running) {
    body = (
      <>
        <span className="herdr-conn-dot ok" />
        <span className="herdr-server-title">herdr 服务运行中</span>
        <span className="herdr-server-meta">
          {server.version ? `v${server.version}` : ''}
          {server.session ? ` · ${server.session}` : ''}
          {snap ? ` · ${snap.agents.length} agent` : ''}
        </span>
      </>
    )
  } else {
    body = (
      <>
        <span className="herdr-conn-dot bad" />
        <span className="herdr-server-title">herdr 服务未启动</span>
        <Button variant="primary" size="sm" disabled={starting} onClick={() => void handleStart()}>
          {starting ? '启动中…' : '启动 herdr'}
        </Button>
      </>
    )
  }

  const bannerClass = !snap || error ? 'herdr-server-banner' : server?.running
    ? 'herdr-server-banner herdr-banner-running'
    : !cliAvailable
      ? 'herdr-server-banner'
      : server && (server.status === 'not_running' || server.status === 'unknown')
        ? 'herdr-server-banner herdr-banner-stopped'
        : 'herdr-server-banner'

  return (
    <div>
      <div className={bannerClass}>{body}</div>
      {startError ? <div className="herdr-server-error">启动失败：{startError}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 会话页 header 状态胶囊（conversation.session.header.actions）
// ---------------------------------------------------------------------------

function HerdrHeaderPill() {
  const { snap, refresh } = useHerdrStatus()
  const { starting, startError, start } = useHerdrStart()
  const server = snap?.server
  const running = server?.running === true
  const stopped = snap !== null && server !== null && !running
  const dotCls = running ? 'ok' : stopped ? 'bad' : ''

  return (
    <span className="herdr-pill">
      <span className={`herdr-conn-dot ${dotCls}`} />
      {running ? 'herdr 运行中' : stopped ? 'herdr 未启动' : 'herdr …'}
      {stopped ? (
        <button
          disabled={starting}
          onClick={() => {
            void start().then(ok => {
              if (ok) refresh()
            })
          }}
        >
          {starting ? '启动中…' : '启动'}
        </button>
      ) : null}
      {startError ? <span className="herdr-server-error">{startError}</span> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Herdr 视图（Herdr Tab）：workspace / pane 列表
// ---------------------------------------------------------------------------

function PaneRow({ pane, agent, open, onToggle }: {
  pane: HerdrPaneView
  agent: HerdrAgentStatus | undefined
  open: boolean
  onToggle: () => void
}) {
  const status = agent?.status ?? pane.agent_status
  const muted = !status || status === 'unknown'
  return (
    <>
      <div
        className="herdr-pane"
        data-focused={pane.focused || undefined}
        data-open={open || undefined}
        data-pane-id={pane.pane_id}
        onClick={onToggle}
      >
        <StateDot state={dotState(status)} className={muted ? 'herdr-dot-muted' : undefined} />
        <span className="herdr-pane-id">{pane.pane_id}</span>
        {pane.focused ? <span className="herdr-pane-focus">焦点</span> : null}
        {agent ? (
          <Pill className="herdr-agent-pill">
            <span className="herdr-agent-name">{agent.agent}</span>
            <span className="herdr-state-text" data-state={dotState(status)}>{status ?? 'unknown'}</span>
          </Pill>
        ) : (
          <Pill className="herdr-agent-pill"><span className="herdr-agent-name">—</span></Pill>
        )}
        <span className="herdr-pane-meta">
          <span className="herdr-pane-cwd">{pane.cwd ?? pane.foreground_cwd ?? ''}</span>
          {agent ? <span className="herdr-pane-time">{formatTime(agent.updated_at)}</span> : null}
          <svg className="herdr-pane-chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
        </span>
      </div>
      <div className="herdr-pane-out">
        {agent?.message ? <div className="herdr-pane-message">{agent.message}</div> : null}
        <TerminalBlock
          command={pane.title || `${pane.pane_id} 输出`}
          cwd={pane.cwd}
          output={agent?.output}
          running={agent?.status === 'working'}
          maxLines={16}
        />
      </div>
    </>
  )
}

export function HerdrView() {
  const { snap, error, refresh } = useHerdrStatus()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [openPanes, setOpenPanes] = useState<Set<string>>(new Set())

  // 面板跳转：展开对应 workspace/pane 并滚动高亮（挂载时消费 pending）
  useEffect(() => {
    const focusPane = (paneId: string) => {
      setCollapsed(new Set())
      setOpenPanes(prev => {
        const next = new Set(prev)
        next.add(paneId)
        return next
      })
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-pane-id="${paneId}"]`)
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          el.classList.add('herdr-pane-flash')
          window.setTimeout(() => el.classList.remove('herdr-pane-flash'), 1400)
        }
      })
    }
    const handler = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId: string }>).detail?.paneId
      if (paneId) focusPane(paneId)
    }
    document.addEventListener('herdr:focus-pane', handler)
    if (pendingFocusPane) {
      focusPane(pendingFocusPane)
      pendingFocusPane = null
    }
    return () => document.removeEventListener('herdr:focus-pane', handler)
  }, [])

  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  const groups = buildGroups(snap?.topology)
  const paneCount = snap?.topology?.panes.length ?? snap?.agents.length ?? 0
  const wsCount = snap?.topology?.workspaces.length ?? 0
  const agentCount = snap?.agents.length ?? 0
  const cli = snap?.cli

  const toggleWs = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const togglePane = (id: string) => {
    setOpenPanes(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="herdr-root">
      <HerdrServerBanner snap={snap} error={error} onStarted={refresh} />

      <div className="herdr-head">
        <span className="herdr-head-title">Herdr</span>
        <span className="herdr-head-stats">{wsCount} workspaces · {paneCount} panes · {agentCount} agents</span>
        <span className="herdr-head-actions">
          <Button variant="outline" size="sm" onClick={refresh}>刷新</Button>
        </span>
      </div>

      {error ? <div className="herdr-server-error">herdr status: {error}</div> : null}

      {snap && cli && !cli.available ? (
        <div className="herdr-install">
          <div className="herdr-install-title">herdr CLI is not installed</div>
          The Herdr panel needs the <code>herdr</code> binary to inspect and control panes. Install it:
          <br />
          <code>curl -fsSL https://herdr.dev/install.sh | sh</code>
          <br />
          Windows: <code>powershell -ExecutionPolicy Bypass -c &quot;irm https://herdr.dev/install.ps1 | iex&quot;</code>
          <br />
          Homebrew / mise / Nix and verification: <a href="https://herdr.dev/docs/install/" target="_blank" rel="noreferrer">herdr.dev/docs/install</a>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="herdr-empty">
          No panes yet.
          <br />
          Start a coding agent in a Herdr pane (e.g. <code>claude</code>) and it will appear here with live output.
        </div>
      ) : (
        <div className="herdr-ws-list">
          {groups.map(g => (
            <section key={g.workspace.workspace_id} className="herdr-ws" data-collapsed={collapsed.has(g.workspace.workspace_id) || undefined}>
              <div className="herdr-ws-head" onClick={() => toggleWs(g.workspace.workspace_id)}>
                <svg className="herdr-ws-chev" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
                <span className="herdr-ws-label">{g.workspace.label || g.workspace.workspace_id}</span>
                <span className="herdr-ws-id">{g.workspace.workspace_id}</span>
                <span className="herdr-ws-stats">
                  <b>{g.panes.length}</b> panes · <b>{g.panes.filter(p => agentByPane.has(p.pane_id)).length}</b> agents
                  {g.tabs.length > 0 ? ` · tab ${g.tabs[0].tab_id}` : ''}
                </span>
              </div>
              <div className="herdr-ws-body">
                {g.panes.map(pane => (
                  <PaneRow
                    key={pane.pane_id}
                    pane={pane}
                    agent={agentByPane.get(pane.pane_id)}
                    open={openPanes.has(pane.pane_id)}
                    onToggle={() => togglePane(pane.pane_id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 会话页右侧 pane 状态列表面板（shell.overlay）
// ---------------------------------------------------------------------------

/** 当前会话 id 读取器（apply 时经 sessions 服务注入）。 */
let getSessionId: () => string | undefined = () => undefined

/**
 * Herdr 官方 logo（assets/logo.svg，剥掉背景色块后以 currentColor 渲染，
 * 随主题取色；浅色主题深色图形、深色主题浅色图形）。
 */
function HerdrLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? 'logo-svg'}
      role="img"
      aria-label="Herdr"
      xmlns="http://www.w3.org/2000/svg"
      width="512"
      height="512"
      viewBox="0 0 512 512"
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="currentColor" transform="translate(0 512) scale(.1 -.1)" stroke="none">
        <path d="M2794 3710 c-129 -33 -299 -135 -359 -214 -21 -28 -26 -42 -21 -63 9 -38 154 -178 199 -192 32 -11 41 -9 104 23 171 86 354 70 475 -43 150 -138 150 -379 0 -511 -107 -95 -278 -94 -386 2 l-46 40 -11 -29 c-16 -40 -14 -122 4 -164 60 -144 264 -222 452 -174 360 92 559 494 430 868 -36 103 -81 173 -175 267 -71 72 -100 93 -180 132 -52 26 -127 54 -167 62 -96 21 -230 20 -319 -4z M2183 3695 c-116 -32 -221 -108 -273 -199 -17 -28 -30 -54 -30 -58 0 -4 20 1 45 12 66 28 220 68 294 76 64 7 65 7 137 83 40 41 71 77 69 79 -2 2 -21 8 -42 13 -55 12 -140 10 -200 -6z M2212 3388 c-159 -22 -390 -122 -559 -241 -299 -210 -585 -600 -609 -828 -12 -118 40 -251 125 -318 96 -76 178 -98 426 -116 110 -8 224 -21 254 -29 125 -34 230 -115 272 -211 11 -24 24 -81 30 -127 20 -170 65 -271 166 -374 34 -35 63 -65 63 -67 0 -1 -10 -27 -22 -57 -29 -76 -37 -259 -14 -350 42 -170 158 -318 311 -397 44 -23 98 -46 120 -52 22 -6 45 -14 51 -18 5 -5 15 -48 22 -96 6 -48 14 -92 17 -97 4 -6 415 -10 1131 -10 l1124 0 0 1584 0 1585 -55 -19 c-84 -29 -143 -68 -232 -154 l-83 -78 -54 49 c-111 102 -233 151 -391 160 -113 6 -199 -10 -298 -54 l-60 -27 -26 34 c-37 51 -120 134 -127 128 -3 -4 0 -34 7 -67 17 -89 7 -268 -21 -356 -103 -328 -377 -545 -688 -545 -161 0 -273 41 -373 137 -37 35 -66 75 -85 116 -79 173 -8 407 124 407 44 0 68 -14 117 -66 74 -78 167 -82 238 -9 60 62 72 147 33 231 -42 90 -120 130 -238 122 -50 -4 -85 -14 -131 -37 -89 -45 -122 -52 -176 -40 -92 20 -262 163 -302 253 -11 25 -21 45 -22 45 -1 -1 -30 -6 -65 -11z m-256 -505 c115 -88 129 -102 132 -131 2 -18 -2 -40 -9 -49 -7 -8 -69 -55 -138 -105 -103 -73 -130 -88 -151 -83 -35 8 -51 34 -48 74 3 31 12 42 83 92 44 31 80 61 82 66 1 4 -30 31 -69 58 -39 28 -77 56 -85 63 -18 19 -16 72 4 94 32 35 63 23 199 -79z m528 -88 c23 -24 28 -52 14 -82 l-13 -28 -141 -3 c-130 -2 -142 -1 -158 17 -23 26 -24 66 -1 91 16 18 32 20 151 20 105 0 136 -3 148 -15z" />
      </g>
    </svg>
  )
}

function HerdrPaneList() {
  const { snap, error } = useHerdrStatus()
  const [collapsed, setCollapsed] = useState(false)
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set())
  const [selfPaneId, setSelfPaneId] = useState<string | null>(null)
  const [inSession, setInSession] = useState(false)
  const lastSessionId = useRef<string | undefined>(undefined)
  const prevStatus = useRef<string | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const minRef = useRef<HTMLButtonElement | null>(null)
  const initPosRef = useRef(false)
  // 位置 state：面板与折叠圆钮共享（折叠/展开不丢失位置）
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const { handlers: dragHandlers } = useFloatingDrag<HTMLDivElement>(panelRef, pos, setPos, true)
  const minDrag = useFloatingDrag<HTMLButtonElement>(minRef, pos, setPos, true)

  // 初始位置：面板顶部置于「对话/轨迹/Herdr」Tab 栏分割线以下 12px。
  // 分割线 = Tab 栏（role=tablist）底边 + 1px 边框；tablist 未渲染（blank/settling
  // 隐藏）时重试；滚出视口时退回固定 top。
  useEffect(() => {
    if (!inSession || initPosRef.current) return
    const tryInit = (): boolean => {
      const tablist = document.querySelector('[role="tablist"]')
      const bottom = tablist instanceof HTMLElement ? tablist.getBoundingClientRect().bottom + 1 : 0
      if (bottom <= 40) return false // Tab 栏尚未渲染
      const vw = window.innerWidth
      const w = panelRef.current?.offsetWidth ?? 264
      const y = bottom > 40 && bottom < window.innerHeight ? bottom + 12 : 68
      setPos({ x: Math.max(SNAP, vw - w - SNAP), y: Math.max(SNAP, y) })
      initPosRef.current = true
      return true
    }
    if (tryInit()) return
    const timer = setInterval(() => {
      if (tryInit()) clearInterval(timer)
    }, 300)
    return () => clearInterval(timer)
  }, [inSession])

  // 折叠：logo 主动吸附到最近的左/右边缘（左侧 → 侧边栏右缘；右侧 → 视口右缘）
  const collapsePanel = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const panelW = panelRef.current?.offsetWidth ?? 264
    const curX = pos?.x ?? vw - panelW - SNAP
    let x: number
    if (curX + panelW / 2 < vw / 2) {
      const overlay = document.querySelector('[data-shell-overlay]')
      const sidebar = overlay?.parentElement?.firstElementChild
      const sidebarW = sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
      x = sidebarW + SNAP
    } else {
      x = vw - 36 - SNAP
    }
    const y = Math.max(SNAP, Math.min(pos?.y ?? 56, vh - 36 - SNAP))
    setPos({ x, y })
    setCollapsed(true)
  }

  // 会话页面检测（conversation root 存在且非 hero 相位）
  useEffect(() => {
    const check = () => {
      const root = document.querySelector('[data-phase]')
      setInSession(Boolean(root && root.getAttribute('data-phase') !== 'hero'))
    }
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [])

  // 当前会话 id（sessions 服务；变化时查询绑定 pane）
  useEffect(() => {
    const timer = setInterval(() => {
      const id = getSessionId()
      if (id === lastSessionId.current) return
      lastSessionId.current = id
      if (!id) {
        setSelfPaneId(null)
        return
      }
      fetch('/herdr-session-pane?agent=' + encodeURIComponent(id))
        .then(r => r.json())
        .then((d: { pane_id?: string | null }) => setSelfPaneId(d.pane_id ?? null))
        .catch(() => setSelfPaneId(null))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 自动展开：本对话 pane 状态 working 边沿（非 working → working 且处于折叠）
  const selfStatus = snap?.agents.find(a => a.pane_id === selfPaneId)?.status
  useEffect(() => {
    if (shouldAutoExpand(prevStatus.current, selfStatus, collapsed)) {
      setCollapsed(false)
    }
    if (selfStatus !== undefined) prevStatus.current = selfStatus
  }, [selfStatus, collapsed])

  if (!inSession) return null

  // 折叠态：仅 Herdr logo（可拖动、吸附）
  if (collapsed) {
    return (
      <button
        ref={minRef}
        className="pane-list-min"
        title="Herdr panes"
        style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
        onClick={() => {
          if (minDrag.consumeDragged()) return
          setCollapsed(false)
        }}
        {...minDrag.handlers}
      >
        <HerdrLogo />
      </button>
    )
  }

  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  const groups = buildGroups(snap?.topology)
  const paneCount = snap?.topology?.panes.length ?? 0
  const wsCount = snap?.topology?.workspaces.length ?? 0

  const toggleWs = (id: string) => {
    setCollapsedWs(prev => toggleCollapse(prev, id))
  }

  return (
    <aside
      ref={panelRef}
      className="pane-list-panel"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
    >
      <div className="pane-list-head" {...dragHandlers}>
        <button
          className="pane-list-logo"
          title="折叠为 logo"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation()
            collapsePanel()
          }}
        >
          <HerdrLogo className="logo-svg" />
        </button>
        <span className="pane-list-title">Herdr panes</span>
        <span className="pane-list-meta">{wsCount} ws · {paneCount} panes</span>
        <button
          className="pane-list-collapse"
          title="最小化"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation()
            collapsePanel()
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {error ? <div className="herdr-server-error" style={{ padding: '0 12px 6px' }}>herdr status: {error}</div> : null}
      <div className="pane-list-body">
        {groups.length === 0 ? (
          <div style={{ padding: '14px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center' }}>
            暂无 pane
          </div>
        ) : groups.map(g => (
          <div key={g.workspace.workspace_id} className="pl-group" data-collapsed={collapsedWs.has(g.workspace.workspace_id) || undefined}>
            <div className="pl-group-head" onClick={() => toggleWs(g.workspace.workspace_id)}>
              <svg className="chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
              <span>{g.workspace.label || g.workspace.workspace_id}</span>
              <span className="ws">{g.workspace.workspace_id}</span>
              <span className="n">{g.panes.length}</span>
            </div>
            <div className="pl-group-body">
              {g.panes.map(pane => {
                const agent = agentByPane.get(pane.pane_id)
                const status = agent?.status ?? pane.agent_status
                const isSelf = pane.pane_id === selfPaneId
                const muted = !status || status === 'unknown'
                return (
                  <div
                    key={pane.pane_id}
                    className="pl-row"
                    data-self={isSelf || undefined}
                    data-pane-id={pane.pane_id}
                    title={isSelf ? `${pane.pane_id}（本对话）· 点击在 Herdr 中定位` : `${pane.pane_id} · 点击在 Herdr 中定位`}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => focusPaneInHerdrTab(pane.pane_id)}
                  >
                    <StateDot state={dotState(status)} className={muted ? 'herdr-dot-muted' : undefined} />
                    <span className="pl-paneid">{pane.pane_id}</span>
                    <span className="pl-agent">{agent?.agent ?? '—'}</span>
                    {isSelf ? <span className="pl-self-tag">本对话</span> : null}
                    <span className="pl-state" data-state={agent ? dotState(status) : undefined}>
                      {status ?? '纯终端'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// 新建会话（hero 相位）浮层看板：shell.overlay 槽位注册
// ---------------------------------------------------------------------------

function HerdrHeroStatus() {
  const { snap, error, refresh } = useHerdrStatus()
  const [hero, setHero] = useState(false)

  // hero 相位检测：conversation root 的 data-phase 属性（无活动会话时 = "hero"）
  useEffect(() => {
    const check = () => setHero(Boolean(document.querySelector('[data-phase="hero"]')))
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [])

  if (!hero) return null
  return (
    <div className="herdr-hero-card">
      <HerdrServerBanner snap={snap} error={error} onStarted={refresh} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 客户端插件入口
// ---------------------------------------------------------------------------

export function apply(ctx: ClientCtx) {
  // sessions 服务就绪后注入当前会话 id 读取器
  ctx.inject(['sessions'], (scope: unknown) => {
    const sessions = (scope as { sessions?: { list?: { getSnapshot?: () => { current?: string } } } }).sessions
    getSessionId = () => sessions?.list?.getSnapshot?.()?.current
  })

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'herdr',
        order: 20,
        label: () => 'Herdr',
      },
      HerdrView,
    ),
  )
  // 会话页 header 状态胶囊
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'herdr-status',
        order: 30,
      },
      HerdrHeaderPill,
    ),
  )
  // 新建会话（hero）看板浮层
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'herdr-server',
        order: 30,
      },
      HerdrHeroStatus,
    ),
  )
  // 会话页右侧 pane 状态列表面板（可拖动吸附；折叠为 logo；任务开始自动展开）
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'herdr-pane-list',
        order: 40,
      },
      HerdrPaneList,
    ),
  )
}

export const inject = ['slots']