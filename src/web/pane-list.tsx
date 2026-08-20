// 会话页右侧 pane 状态列表面板（shell.overlay）+ 新建会话（hero）浮层看板 + Herdr logo。

import { useEffect, useId, useRef, useState } from 'react'
import { Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  agentTheme,
  ariaStateLabel,
  dotState,
  filterGroupsToSession,
  paneDisplayName,
  paneDisplayState,
  paneKeyboardHandlers,
  shouldAutoExpand,
  toggleCollapse,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { useFloatingDrag, SNAP } from './floating-drag.ts'
import { HERDR_LOGO_PATH_D } from './logo-path.ts'
import { useHerdrMode } from './mode.ts'
import { getSessionId } from './navigation.ts'
import { fetchSelfPaneId } from './session-pane.ts'
import { useHerdrStatus, useGlobalDashboardOpen } from './store.ts'
import { PaneTerminal } from './pane-terminal.tsx'
import type { HerdrAgentStatus } from './types.ts'

/**
 * Herdr 官方 logo（assets/logo.svg，剥掉背景色块后以 currentColor 渲染，
 * 随主题取色；浅色主题深色图形、深色主题浅色图形）。
 */
export function HerdrLogo({ className }: { className?: string }) {
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
        <path d={HERDR_LOGO_PATH_D} />
      </g>
    </svg>
  )
}

export function HerdrPaneList() {
  // 语言订阅：切语言时面板文案跟随
  void useHerdrLang()
  const herdrMode = useHerdrMode()
  const gdOpen = useGlobalDashboardOpen()
  const { snap, error } = useHerdrStatus()
  const [collapsed, setCollapsed] = useState(false)
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set())
  const [selfPaneId, setSelfPaneId] = useState<string | null>(null)
  const [inSession, setInSession] = useState(false)
  // 连续未命中计数：查询多次仍 null 才判定「未绑定」（bind 异步完成前的短暂空窗不算）
  const [paneMisses, setPaneMisses] = useState(0)
  const lastSessionId = useRef<string | undefined>(undefined)
  const selfPaneIdRef = useRef<string | null>(null)
  const prevStatus = useRef<string | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const minRef = useRef<HTMLButtonElement | null>(null)
  const initPosRef = useRef(false)
  const [viewingPaneId, setViewingPaneId] = useState<string | null>(null)
  const viewerTriggerRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const bodyScrollRef = useRef<number>(0)
  const preViewerPosRef = useRef<{ x: number; y: number } | null>(null)
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

  // 会话页面检测（conversation root 存在且非 hero 相位；且激活 tab 为「对话」——
  // 轨迹 / Herdr tab 激活时浮层面板隐藏：DSH 的 tab 面板叠加渲染，root 始终可见，
  // 只能以激活 tab（aria-selected）判定当前视图）
  useEffect(() => {
    const check = () => {
      const root = document.querySelector('[data-phase]')
      const tablist = document.querySelector('[role="tablist"]')
      const activeTab = tablist?.querySelector('[role="tab"][aria-selected="true"]')
      const firstTab = tablist?.querySelector('[role="tab"]')
      const onConvTab = Boolean(
        activeTab &&
        firstTab &&
        // 首 tab 兜底 + 双语文案命中（locale 服务 zh/en）；herdr-tab 显式排除
        (activeTab === firstTab || /^(对话|Conversation)$/.test(activeTab.textContent?.trim() ?? '')) &&
        !activeTab.classList.contains('herdr-tab'),
      )
      setInSession(Boolean(root && root.getAttribute('data-phase') !== 'hero' && onConvTab))
    }
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [])

  // 当前会话 id（sessions 服务；变化时重置查询）。
  // 同一会话下持续查询直到命中：bind 在 agent/created 或首个模型请求（兜底）时
  // 才完成，首次查询可能早于绑定——只查一次会导致面板永远停留在空态。
  useEffect(() => {
    const timer = setInterval(() => {
      const id = getSessionId()
      if (id !== lastSessionId.current) {
        lastSessionId.current = id
        setSelfPaneId(null)
        setPaneMisses(0)
        return
      }
      if (!id || selfPaneIdRef.current) return
      void fetchSelfPaneId(id).then(paneId => {
        setSelfPaneId(paneId)
        if (!paneId) setPaneMisses(m => m + 1)
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    selfPaneIdRef.current = selfPaneId
  }, [selfPaneId])

  // 自动展开：本对话 pane 状态 working 边沿（非 working → working 且处于折叠）
  const selfStatus = snap?.agents.find(a => a.pane_id === selfPaneId)?.status
  useEffect(() => {
    if (shouldAutoExpand(prevStatus.current, selfStatus, collapsed)) {
      setCollapsed(false)
    }
    if (selfStatus !== undefined) prevStatus.current = selfStatus
  }, [selfStatus, collapsed])

  // 展开后把面板完整拉回视口内：折叠圆钮吸附边缘时位置被共享（collapsePanel 把
  // pos 设为圆钮位置），直接展开会以圆钮位置为左上角，导致面板超出视口被截断；
  // 点击展开与自动展开（shouldAutoExpand）两条路径都经此修正。仅折叠→展开瞬间
  // 触发，拖动中的 pos 变化不受影响（依赖只有 collapsed）。
  useEffect(() => {
    if (collapsed || !pos) return
    const el = panelRef.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = el.offsetWidth
    const h = el.offsetHeight
    const x = Math.min(Math.max(pos.x, SNAP), Math.max(SNAP, vw - w - SNAP))
    const y = Math.min(Math.max(pos.y, SNAP), Math.max(SNAP, vh - h - SNAP))
    if (x !== pos.x || y !== pos.y) setPos({ x, y })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  // viewer 展开 264→400 后把面板拉回视口内：必须用目标尺寸 400×267
  // 做 clamp，不能在 rAF 里读 offsetWidth（过渡中仍 ~264，会少算 136px 溢出）。
  useEffect(() => {
    if (!viewingPaneId) return
    if (!preViewerPosRef.current && pos) preViewerPosRef.current = pos
    const VIEWER_W = 400
    const VIEWER_H = Math.round(VIEWER_W * 6 / 9) // 267
    const targetH = VIEWER_H + 80 // header+padding
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x = pos ? pos.x : vw - 264 - SNAP
    let y = pos ? pos.y : SNAP
    x = Math.min(Math.max(x, SNAP), Math.max(SNAP, vw - VIEWER_W - SNAP))
    y = Math.min(Math.max(y, SNAP), Math.max(SNAP, vh - targetH - SNAP))
    const overlay = document.querySelector('[data-shell-overlay]')
    const sidebar = overlay?.parentElement?.firstElementChild
    const sidebarW = sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
    if (x + VIEWER_W / 2 < vw / 2) x = Math.max(sidebarW + SNAP, x)
    if (pos && (x !== pos.x || y !== pos.y)) setPos({ x, y })
    else if (!pos) setPos({ x, y })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingPaneId])

  const closeViewer = () => {
    const restore = preViewerPosRef.current
    preViewerPosRef.current = null
    setViewingPaneId(null)
    requestAnimationFrame(() => {
      viewerTriggerRef.current?.focus()
      if (bodyRef.current) bodyRef.current.scrollTop = bodyScrollRef.current
      if (restore) setPos(restore)
    })
  }

  useEffect(() => {
    if (!viewingPaneId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingPaneId])

  const panelIdPrefix = useId()

  // 面板会话聚焦（design: herdr-mode-gating §4.4）：只显示包含本会话绑定 pane 的
  // workspace 组；selfPaneId 未决/无匹配时显示空态。scope 切换保留在 Herdr Tab 工具栏。
  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  const groups = filterGroupsToSession(snap?.topology, selfPaneId)
  const paneCount = groups.reduce((n, g) => n + g.panes.length, 0)
  const wsCount = groups.length

  const toggleWs = (id: string) => {
    setCollapsedWs(prev => toggleCollapse(prev, id))
  }

  useEffect(() => {
    if (!viewingPaneId) return
    if (!snap?.topology) return
    const inGroups = groups.some(g => g.panes.some(p => p.pane_id === viewingPaneId))
    if (inGroups) return
    const inTopology = snap.topology.panes.some(p => p.pane_id === viewingPaneId)
    if (!inTopology) setViewingPaneId(null)
  }, [viewingPaneId, groups, snap?.topology])

  // 消失自动关闭也需还原位置（非 closeViewer 路径）
  useEffect(() => {
    if (viewingPaneId) return
    if (!preViewerPosRef.current) return
    const restore = preViewerPosRef.current
    preViewerPosRef.current = null
    requestAnimationFrame(() => setPos(restore))
  }, [viewingPaneId])

  const viewingPane = viewingPaneId
    ? (groups.flatMap(g => g.panes).find(p => p.pane_id === viewingPaneId)
      ?? snap?.topology?.panes.find(p => p.pane_id === viewingPaneId)
      ?? null)
    : null
  const viewingAgent = viewingPaneId ? agentByPane.get(viewingPaneId) : undefined

  // 非 herdr 模式不渲染面板（D1 已确认：与 Tab/胶囊一致门控）；全局面板打开时隐藏
  if (!inSession || !herdrMode || gdOpen) return null

  // 折叠态：仅 Herdr logo（可拖动、吸附）
  if (collapsed) {
    return (
      <button
        ref={minRef}
        className="pane-list-min"
        title="herdr"
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

  return (
    <aside
      ref={panelRef}
      className="pane-list-panel"
      data-viewer={viewingPaneId ? '1' : undefined}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
    >
      <div className="pane-list-head" {...dragHandlers}>
        <span className="pane-list-title">herdr</span>
        <span className="pane-list-meta">{t('view.listMeta', { workspaces: wsCount, panes: paneCount })}</span>
        <button
          className="pane-list-logo"
          title={t('panel.collapseToLogo')}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation()
            collapsePanel()
          }}
        >
          <HerdrLogo className="logo-svg" />
        </button>
      </div>
      {error ? <div className="herdr-pane-list-error">{t('view.statusError', { error })}</div> : null}
      {viewingPaneId ? (() => {
        const viewerStatus = viewingAgent?.status ?? viewingPane?.agent_status
        const viewerDisplayState = paneDisplayState(viewerStatus)
        const viewerStateLabel = t(ariaStateLabel(viewerDisplayState))
        const viewerMuted = viewerDisplayState === 'unknown'
        const viewerIsSelf = viewingPaneId === selfPaneId
        const viewerName = viewingPane ? paneDisplayName(viewingPane, viewingAgent) : viewingPaneId
        return (
          <div className="pane-list-viewer" data-pane-id={viewingPaneId}>
            <div className="pane-list-viewer-head" {...dragHandlers}>
              <StateDot state={dotState(viewerStatus)} className={viewerMuted ? 'herdr-dot-muted' : undefined} />
              {viewingAgent ? <span className="herdr-agent-accent" data-accent={agentTheme(viewingAgent.agent)} title={viewingAgent.agent} /> : null}
              <span className="pane-list-viewer-title" title={viewingPaneId}>{viewerName}</span>
              <Pill className="herdr-agent-pill">
                {viewingAgent ? <span className="herdr-agent-name">{viewingAgent.agent}</span> : <span className="herdr-agent-name">—</span>}
                <span className="herdr-state-text" data-state={viewerDisplayState} aria-label={viewerStateLabel}>{viewerStateLabel}</span>
              </Pill>
              {viewerIsSelf ? <span className="pl-self-tag">{t('panel.selfTag')}</span> : null}
              <button type="button" className="pane-list-viewer-close" aria-label={t('panel.viewerClose')} onPointerDown={e => e.stopPropagation()} onClick={closeViewer}>✕</button>
            </div>
            <div className="pane-list-viewer-body">
              <PaneTerminal paneId={viewingPaneId} readOnly status={viewerStatus} accent={viewingAgent ? agentTheme(viewingAgent.agent) : undefined} />
            </div>
          </div>
        )
      })() : (
        <div ref={bodyRef} className="pane-list-body">
          {groups.length === 0 ? (
            <div className="herdr-empty">
              {selfPaneId || paneMisses >= 3 ? t('panel.noPane') : t('panel.fetchingPane')}
            </div>
          ) : groups.map(g => (
            <div key={g.workspace.workspace_id} className="pl-group" data-collapsed={collapsedWs.has(g.workspace.workspace_id) || undefined}>
              <div
                id={`${panelIdPrefix}-${g.workspace.workspace_id}-toggle`}
                className="pl-group-head"
                role="button"
                tabIndex={0}
                aria-expanded={!collapsedWs.has(g.workspace.workspace_id)}
                aria-controls={`${panelIdPrefix}-${g.workspace.workspace_id}-body`}
                onClick={() => toggleWs(g.workspace.workspace_id)}
                onKeyDown={e => {
                  const action = paneKeyboardHandlers(e.key)
                  if (!action.trigger) return
                  if (action.preventDefault) e.preventDefault()
                  toggleWs(g.workspace.workspace_id)
                }}
              >
                <svg className="chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
                <span>{g.workspace.label || g.workspace.workspace_id}</span>
                <span className="ws">{g.workspace.workspace_id}</span>
                <span className="n">{g.panes.length}</span>
              </div>
              <div
                id={`${panelIdPrefix}-${g.workspace.workspace_id}-body`}
                className="pl-group-body"
              >
                {g.panes.map(pane => {
                  const agent = agentByPane.get(pane.pane_id)
                  const status = agent?.status ?? pane.agent_status
                  const displayState = paneDisplayState(status)
                  const isSelf = pane.pane_id === selfPaneId
                  const muted = displayState === 'unknown'
                  const stateLabel = t(ariaStateLabel(displayState))
                  const displayName = paneDisplayName(pane, agent)
                  const rowLabel = isSelf ? t('panel.selfTitle', { id: displayName }) : t('panel.paneTitle', { id: displayName })
                  return (
                    <div
                      key={pane.pane_id}
                      className="pl-row"
                      role="button"
                      tabIndex={isSelf ? -1 : 0}
                      data-self={isSelf || undefined}
                      data-disabled={isSelf || undefined}
                      aria-disabled={isSelf ? 'true' as const : undefined}
                      data-pane-id={pane.pane_id}
                      aria-label={rowLabel}
                      title={isSelf ? t('panel.viewerSelfDisabled') : rowLabel}
                      onPointerDown={e => e.stopPropagation()}
                      onClick={e => {
                        if (isSelf) return
                        bodyScrollRef.current = bodyRef.current?.scrollTop ?? 0
                        viewerTriggerRef.current = e.currentTarget as HTMLElement
                        setViewingPaneId(pane.pane_id)
                      }}
                      onKeyDown={e => {
                        const action = paneKeyboardHandlers(e.key)
                        if (!action.trigger) return
                        if (action.preventDefault) e.preventDefault()
                        if (isSelf) return
                        bodyScrollRef.current = bodyRef.current?.scrollTop ?? 0
                        viewerTriggerRef.current = e.currentTarget as HTMLElement
                        setViewingPaneId(pane.pane_id)
                      }}
                    >
                      <StateDot state={dotState(status)} className={muted ? 'herdr-dot-muted' : undefined} />
                      <span className="pl-paneid" title={pane.pane_id}>{paneDisplayName(pane, agent)}</span>
                      <span className="pl-agent">{agent?.agent ?? '—'}</span>
                      {isSelf ? <span className="pl-self-tag">{t('panel.selfTag')}</span> : null}
                      <span className="pl-state" data-state={displayState} aria-label={stateLabel}>
                        {stateLabel}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

