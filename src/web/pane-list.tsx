// 会话页右侧 pane 状态列表面板（shell.overlay）+ 新建会话（hero）浮层看板 + Herdr logo。

import { useEffect, useRef, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildGroups, dotState, shouldAutoExpand, toggleCollapse } from '../client-logic.ts'
import { useFloatingDrag, SNAP } from './floating-drag.ts'
import { focusPaneInHerdrTab, getSessionId } from './navigation.ts'
import { HerdrServerBanner } from './server-banner.tsx'
import { getStatusScope, useHerdrStatus } from './store.ts'
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
        <path d="M2794 3710 c-129 -33 -299 -135 -359 -214 -21 -28 -26 -42 -21 -63 9 -38 154 -178 199 -192 32 -11 41 -9 104 23 171 86 354 70 475 -43 150 -138 150 -379 0 -511 -107 -95 -278 -94 -386 2 l-46 40 -11 -29 c-16 -40 -14 -122 4 -164 60 -144 264 -222 452 -174 360 92 559 494 430 868 -36 103 -81 173 -175 267 -71 72 -100 93 -180 132 -52 26 -127 54 -167 62 -96 21 -230 20 -319 -4z M2183 3695 c-116 -32 -221 -108 -273 -199 -17 -28 -30 -54 -30 -58 0 -4 20 1 45 12 66 28 220 68 294 76 64 7 65 7 137 83 40 41 71 77 69 79 -2 2 -21 8 -42 13 -55 12 -140 10 -200 -6z M2212 3388 c-159 -22 -390 -122 -559 -241 -299 -210 -585 -600 -609 -828 -12 -118 40 -251 125 -318 96 -76 178 -98 426 -116 110 -8 224 -21 254 -29 125 -34 230 -115 272 -211 11 -24 24 -81 30 -127 20 -170 65 -271 166 -374 34 -35 63 -65 63 -67 0 -1 -10 -27 -22 -57 -29 -76 -37 -259 -14 -350 42 -170 158 -318 311 -397 44 -23 98 -46 120 -52 22 -6 45 -14 51 -18 5 -5 15 -48 22 -96 6 -48 14 -92 17 -97 4 -6 415 -10 1131 -10 l1124 0 0 1584 0 1585 -55 -19 c-84 -29 -143 -68 -232 -154 l-83 -78 -54 49 c-111 102 -233 151 -391 160 -113 6 -199 -10 -298 -54 l-60 -27 -26 34 c-37 51 -120 134 -127 128 -3 -4 0 -34 7 -67 17 -89 7 -268 -21 -356 -103 -328 -377 -545 -688 -545 -161 0 -273 41 -373 137 -37 35 -66 75 -85 116 -79 173 -8 407 124 407 44 0 68 -14 117 -66 74 -78 167 -82 238 -9 60 62 72 147 33 231 -42 90 -120 130 -238 122 -50 -4 -85 -14 -131 -37 -89 -45 -122 -52 -176 -40 -92 20 -262 163 -302 253 -11 25 -21 45 -22 45 -1 -1 -30 -6 -65 -11z m-256 -505 c115 -88 129 -102 132 -131 2 -18 -2 -40 -9 -49 -7 -8 -69 -55 -138 -105 -103 -73 -130 -88 -151 -83 -35 8 -51 34 -48 74 3 31 12 42 83 92 44 31 80 61 82 66 1 4 -30 31 -69 58 -39 28 -77 56 -85 63 -18 19 -16 72 4 94 32 35 63 23 199 -79z m528 -88 c23 -24 28 -52 14 -82 l-13 -28 -141 -3 c-130 -2 -142 -1 -158 17 -23 26 -24 66 -1 91 16 18 32 20 151 20 105 0 136 -3 148 -15z" />
      </g>
    </svg>
  )
}

export function HerdrPaneList() {
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

  if (!inSession) return null

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

  // 过滤提示（与 HerdrView 一致，design-v2 §7.4）：仅本项目 matched/total；scope=all 时显示全部（total）。
  // 悬浮面板自身不提供 scope 切换（切换在 Herdr Tab 工具栏），只做提示展示。
  const filter = snap?.filter
  const scope = getStatusScope()
  const paneListFilterHint =
    scope === 'project' && !!filter && filter.total > 0 ? (
      <span className="herdr-filter-hint" title="在项目目录内打开的 herdr 只显示本目录 workspace（仅本项目 / 全部）">
        仅本项目（{filter.matched}/{filter.total}）
      </span>
    ) : scope === 'all' && !!filter && filter.total > 0 ? (
      <span className="herdr-filter-hint" title="当前显示全部 workspace">
        全部（{filter.total}）
      </span>
    ) : null

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
        <span className="pane-list-title">herdr</span>
        <span className="pane-list-meta">{wsCount} ws · {paneCount} panes</span>
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
      </div>
      {error ? <div className="herdr-server-error" style={{ padding: '0 12px 6px' }}>herdr status: {error}</div> : null}
      <div className="pane-list-body">
        {paneListFilterHint ? <div className="pane-list-filter">{paneListFilterHint}</div> : null}
        {groups.length === 0 ? (
          <div className="herdr-empty">
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

// 新建会话（hero 相位）浮层看板：shell.overlay 槽位注册
export function HerdrHeroStatus() {
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
