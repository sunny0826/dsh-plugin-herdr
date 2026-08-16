// 会话页右侧 pane 状态列表面板（shell.overlay）+ 新建会话（hero）浮层看板 + Herdr logo。

import { useEffect, useRef, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { dotState, filterGroupsToSession, shouldAutoExpand, toggleCollapse } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { useFloatingDrag, SNAP } from './floating-drag.ts'
import { HERDR_LOGO_PATH_D } from './logo-path.ts'
import { useHerdrMode } from './mode.ts'
import { focusPaneInHerdrTab, getSessionId } from './navigation.ts'
import { fetchSelfPaneId } from './session-pane.ts'
import { HerdrServerBanner } from './server-banner.tsx'
import { useHerdrStatus } from './store.ts'
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

  // 非 herdr 模式不渲染面板（D1 已确认：与 Tab/胶囊一致门控）
  if (!inSession || !herdrMode) return null

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

  // 面板会话聚焦（design: herdr-mode-gating §4.4）：只显示包含本会话绑定 pane 的
  // workspace 组；selfPaneId 未决/无匹配时显示空态。scope 切换保留在 Herdr Tab 工具栏。
  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  const groups = filterGroupsToSession(snap?.topology, selfPaneId)
  const paneCount = groups.reduce((n, g) => n + g.panes.length, 0)
  const wsCount = groups.length

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
      {error ? <div className="herdr-server-error" style={{ padding: '0 12px 6px' }}>herdr status: {error}</div> : null}
      <div className="pane-list-body">
        {groups.length === 0 ? (
          <div className="herdr-empty">
            {selfPaneId || paneMisses >= 3 ? t('panel.noPane') : t('panel.fetchingPane')}
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
                    title={isSelf ? t('panel.selfTitle', { id: pane.pane_id }) : t('panel.paneTitle', { id: pane.pane_id })}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => focusPaneInHerdrTab(pane.pane_id)}
                  >
                    <StateDot state={dotState(status)} className={muted ? 'herdr-dot-muted' : undefined} />
                    <span className="pl-paneid">{pane.pane_id}</span>
                    <span className="pl-agent">{agent?.agent ?? '—'}</span>
                    {isSelf ? <span className="pl-self-tag">{t('panel.selfTag')}</span> : null}
                    <span className="pl-state" data-state={agent ? dotState(status) : undefined}>
                      {status ?? t('panel.plainTerminal')}
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
