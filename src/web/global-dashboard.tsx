// 全局面板（design: dashboard-global v4 —— 插件-only：marker 注入 sidebar 文档流 +
// shell.overlay 右侧工作区完整 surface）。宿主 DSH 零改动。
// 按钮：原生 DOM marker 插到 New Session 与 regionArea 之间（同一文档流），带三态
// 状态点（运行中/已停止/未安装/检查中，复用 statusStore 快照——P1-1）；surface：
// shell.overlay 内从 sidebar 右边界覆盖整个右侧工作区，header 含状态+版本+启动，
// 复用 DashboardContent；workspace 卡片点击关闭 surface 返回 conversation。

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  computeGlobalSurfaceBounds,
  deriveMarkerPressed,
  deriveMarkerServerState,
  formatTime,
  isSidebarRail,
  NEW_SESSION_SELECTORS,
  REGION_AREA_SELECTOR,
  resolveSidebarMarker,
  SIDEBAR_MARKER_DATA,
  type GlobalSurfaceBounds,
  type MarkerServerState,
} from '../client-logic.ts'
import { subscribeHerdrLang, t, useHerdrLang } from './i18n.ts'
import {
  closeGlobalDashboard,
  globalDashboardStore,
  openGlobalDashboard,
  statusStore,
  useGlobalDashboardOpen,
  useHerdrDashboard,
  useHerdrStart,
} from './store.ts'
import { useGlobalDashboardAvailable } from './mode.ts'
import { getSessionId, navigateToPane } from './navigation.ts'
import { fetchPaneSession, fetchSelfPaneId } from './session-pane.ts'
import { DashboardContent } from './dashboard-view.tsx'
import { HerdrLogo } from './pane-list.tsx'
import type { HerdrDashboardPaneRef } from './dashboard-types.ts'

// ---------------------------------------------------------------------------
// DOM 查询（controller 与 surface 共用）
// ---------------------------------------------------------------------------

/** 定位 New Session 锚点按钮（优先 CSS module 类名子串，兜底双语 aria-label；要求可见）。 */
export function findNewSessionButton(): HTMLElement | null {
  for (const selector of NEW_SESSION_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el && el.getBoundingClientRect().width > 0) return el
  }
  return null
}

/** 定位 workspace/session 浏览区容器（sidebar.workspaces 渲染点）。 */
export function findRegionArea(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(REGION_AREA_SELECTOR)
  return el && el.getBoundingClientRect().width > 0 ? el : null
}

/** 定位 sidebar column（surface 左边界测量源；regionArea 的祖先链上的侧栏列）。 */
function findSidebarColumn(): HTMLElement | null {
  const regionArea = findRegionArea()
  const sidebarCol = regionArea?.closest<HTMLElement>('[class*="sidebarCol"]')
  if (sidebarCol) return sidebarCol
  // 兜底：regionArea 祖先链里宽度 ≤400 的固定列（rail 56 / wide 240）
  let node: HTMLElement | null = regionArea
  while (node) {
    const w = node.getBoundingClientRect().width
    if (w > 0 && w <= 400 && node !== document.body) return node
    node = node.parentElement
  }
  return null
}

/** 已注入的 marker 根元素（幂等查重与 surface 关闭焦点回收）。 */
function findMarker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${SIDEBAR_MARKER_DATA}]`)
}

// ---------------------------------------------------------------------------
// Step 2：sidebar marker controller（原生 DOM，按钮进入 sidebar 文档流）
// ---------------------------------------------------------------------------

/** marker 按钮：与 New Session 视觉对齐（胶囊/行，rail/wide 双形态），i18n 双语。 */
function buildMarkerButton(onActivate: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'herdr-sb-marker-button'
  const icon = document.createElement('span')
  icon.className = 'herdr-sb-marker-icon'
  const dot = document.createElement('span')
  dot.className = 'herdr-sb-marker-dot'
  dot.setAttribute('data-state', 'checking')
  const label = document.createElement('span')
  label.className = 'herdr-sb-marker-label'
  const applyCopy = () => {
    const stateText = markerStateText(deriveMarkerServerState(statusStore.getSnap()))
    label.textContent = t('global.title')
    btn.title = `${t('global.title')} · ${stateText}`
    btn.setAttribute('aria-label', `${t('global.title')} · ${stateText}`)
  }
  applyCopy()
  // toggle 按钮初始未按下（open/close 由 store 订阅同步）
  btn.setAttribute('aria-pressed', deriveMarkerPressed(false))
  btn.append(icon, dot, label)
  btn.addEventListener('click', onActivate)
  return btn
}

/** 三态状态文本（v4 需求 2：按钮 title/aria 附状态，颜色不是唯一信息）。 */
function markerStateText(state: MarkerServerState): string {
  switch (state) {
    case 'running': return t('global.stateRunning')
    case 'stopped': return t('global.stateStopped')
    case 'not-installed': return t('global.stateNotInstalled')
    default: return t('global.stateChecking')
  }
}

/**
 * marker 注入控制器：把按钮 DOM 插入 New Session 与 regionArea 之间的文档流。
 * - MutationObserver（rAF 合并）维持：React 重渲染/会话切换/折叠后幂等重插；
 * - ResizeObserver（锚点 + regionArea）同步 rail/wide 形态（data-rail）；
 * - 找不到合法插入点 → 隐藏（不注入），锚点恢复后由 observer 重插；
 * - 销毁：解除 observer/监听并移除 marker。
 */
export function startSidebarMarkerController(opts: { onActivate: () => void }): () => void {
  const onActivate = opts.onActivate
  let markerButton: HTMLButtonElement | null = null
  let observers: Array<MutationObserver | ResizeObserver> = []
  let raf = 0
  // i18n / open-state / server-state 订阅（stop 时退订）
  let unsubLang: (() => void) | null = null
  let unsubOpen: (() => void) | null = null
  let unsubStatus: (() => void) | null = null

  /** v4：按 statusStore 最近快照同步按钮状态点（data-state）+ title/aria 状态文本。 */
  const syncServerState = (marker: HTMLElement) => {
    const state = deriveMarkerServerState(statusStore.getSnap())
    const dot = marker.querySelector<HTMLElement>('.herdr-sb-marker-dot')
    dot?.setAttribute('data-state', state)
    const btn = marker.querySelector<HTMLElement>('.herdr-sb-marker-button')
    if (btn) btn.title = `${t('global.title')} · ${markerStateText(state)}`
  }

  /** P1-1：按当前全局 open 状态同步按钮 aria-pressed（原生 DOM 非 React）。 */
  const syncPressed = (marker: HTMLElement) => {
    const btn = marker.querySelector<HTMLElement>('.herdr-sb-marker-button')
    btn?.setAttribute('aria-pressed', deriveMarkerPressed(globalDashboardStore.getOpen()))
  }

  const ensureMarker = () => {
    // 幂等：已注入且位置正确 → 不动（防 observer 自激循环）
    if (findMarker()) return
    const anchor = findNewSessionButton()
    const regionArea = findRegionArea()
    const regionParent = regionArea?.parentElement ?? null
    const resolution = resolveSidebarMarker(
      regionParent,
      anchor,
      (container, node) => container instanceof Node && node instanceof Node && container.contains(node),
    )
    if (!resolution.ok || regionArea === null || regionParent === null || anchor === null) {
      // 找不到稳定插入点 → 隐藏而非孤儿浮层；observer 恢复后重插
      return
    }
    const marker = document.createElement('div')
    marker.setAttribute(SIDEBAR_MARKER_DATA, '')
    marker.className = 'herdr-sb-marker'
    markerButton = buildMarkerButton(onActivate)
    marker.appendChild(markerButton)
    regionParent.insertBefore(marker, regionArea)
    syncRailState(anchor, marker)
    syncPressed(marker) // 建立时按当前状态同步（可能已从旧入口打开）
    syncServerState(marker) // 建立时按最近快照恢复状态点（不等待下一轮请求）
  }

  const syncRailState = (anchor: HTMLElement, marker: HTMLElement) => {
    const rail = isSidebarRail(anchor.getBoundingClientRect().width)
    if (rail) marker.setAttribute('data-rail', '')
    else marker.removeAttribute('data-rail')
  }

  const scheduleEnsure = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      raf = 0
      ensureMarker()
    })
  }

  const stop = () => {
    cancelAnimationFrame(raf)
    for (const obs of observers) obs.disconnect()
    observers = []
    unsubLang?.()
    unsubLang = null
    unsubOpen?.()
    unsubOpen = null
    unsubStatus?.()
    unsubStatus = null
    findMarker()?.remove()
    markerButton = null
  }

  // 观察 body 子树：React 重渲染清除 marker 后重插；自身插入是 mutation → 幂等查重
  const mo = new MutationObserver(scheduleEnsure)
  mo.observe(document.body, { childList: true, subtree: true })
  observers.push(mo)
  // 锚点/浏览区尺寸变化 → rail/wide 形态同步（折叠 settle 后 anchor 宽 36px）
  const ro = new ResizeObserver(() => {
    const marker = findMarker()
    const anchor = findNewSessionButton()
    if (marker && anchor) syncRailState(anchor, marker)
    else scheduleEnsure()
  })
  const target = findNewSessionButton()
  const regionArea = findRegionArea()
  if (target) ro.observe(target)
  if (regionArea) ro.observe(regionArea)
  observers.push(ro)
  unsubLang = subscribeHerdrLang(() => {
    const marker = findMarker()
    if (marker) {
      const label = marker.querySelector('.herdr-sb-marker-label')
      if (label) label.textContent = t('global.title')
      syncServerState(marker) // 状态文本随语言切换
    }
  })
  // P1-1：全局面板 open/close 时同步 marker 按钮 aria-pressed（active 样式经
  // styles.ts 的 [aria-pressed='true'] 选择器）；marker 重插后由 syncPressed 重建同步。
  unsubOpen = globalDashboardStore.subscribe(() => {
    const marker = findMarker()
    if (marker) syncPressed(marker)
  })
  // v4 需求 2：订阅 statusStore 最近快照更新状态点（复用会话 UI 同一轮询源，
  // marker 不另起全量轮询——P1-1 定案；代价是 statusStore 页面级活跃，见 store.ts）。
  unsubStatus = statusStore.subscribe(() => {
    const marker = findMarker()
    if (marker) syncServerState(marker)
  })

  ensureMarker()
  return stop
}

// ---------------------------------------------------------------------------
// Step 3：右侧工作区完整 surface
// ---------------------------------------------------------------------------

/** shell.overlay 承载的右侧完整页面（不覆盖 sidebar；复用 DashboardContent）。 */
export function GlobalDashboardSurface() {
  void useHerdrLang()
  const panelRef = useRef<HTMLElement | null>(null)
  const [bounds, setBounds] = useState<GlobalSurfaceBounds>(() =>
    computeGlobalSurfaceBounds(null, window.innerWidth, window.innerHeight))

  // 左边界实时跟踪 sidebar column（折叠/拖拽/窗口 resize 重算）
  useEffect(() => {
    const measure = () => {
      const col = findSidebarColumn()
      const rect = col?.getBoundingClientRect()
      setBounds(computeGlobalSurfaceBounds(
        rect ? { left: rect.left, right: rect.right } : null,
        window.innerWidth,
        window.innerHeight,
      ))
    }
    measure()
    const ro = new ResizeObserver(measure)
    const col = findSidebarColumn()
    if (col) ro.observe(col)
    window.addEventListener('resize', measure)
    const onTransition = (e: TransitionEvent) => {
      if (e.propertyName === 'grid-template-columns' || e.propertyName === 'width') measure()
    }
    document.addEventListener('transitionend', onTransition, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      document.removeEventListener('transitionend', onTransition, true)
    }
  }, [])

  // 关闭：先恢复焦点（marker 按钮仍在 sidebar 流内）再关 surface
  const close = () => {
    findMarker()?.querySelector<HTMLElement>('.herdr-sb-marker-button')?.focus()
    closeGlobalDashboard()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // 点击左侧 sidebar 会话树（treeitem）或新建会话按钮 → 关闭 surface
    // （capture 先于 surface 内部分发；surface 内部点击不受影响）
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null
      if (!el) return
      if (el.closest('.herdr-gds')) return
      const isSidebarNav =
        el.closest('[role="treeitem"]') !== null ||
        NEW_SESSION_SELECTORS.some(sel => el.closest(sel) !== null)
      if (isSidebarNav) close()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 打开时焦点进 surface（键盘可立即操作；surface 不锁 body 滚动）
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // v5 交互：pane 点击跳转（含跨会话切换）。反查 pane 归属（/herdr-pane-session）：
  // self → 关闭 surface 并在本会话 Herdr Tab 定位；foreign → 关闭 surface 并切换到
  // 该 pane 所属会话（sessions.open）+ 延迟定位；unbound → 关闭 surface 并在本会话
  // Herdr Tab 尽力定位（pane 属于当前 herdr server，通常在本会话 workspace 内；
  // 跨 workspace 时定位 no-op，落在 Herdr Tab）。
  // 注：workspace 卡片（含头部）不承载「返回当前会话」——返回由 header ✕ 关闭按钮承担。
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const showNotice = (message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000)
  }
  useEffect(() => {
    return () => window.clearTimeout(noticeTimer.current)
  }, [])

  // 本会话绑定 pane（self-pane）：用于隐藏 ✕（自 pane/自 workspace 由服务端兜底拒绝）。
  const [selfPaneId, setSelfPaneId] = useState<string | null>(null)
  const selfPaneIdRef = useRef<string | null>(null)
  const lastSessionId = useRef<string | undefined>(undefined)
  useEffect(() => {
    const timer = setInterval(() => {
      const id = getSessionId()
      if (id !== lastSessionId.current) {
        lastSessionId.current = id
        setSelfPaneId(null)
        selfPaneIdRef.current = null
        return
      }
      if (!id || selfPaneIdRef.current) return
      void fetchSelfPaneId(id).then(paneId => {
        setSelfPaneId(paneId)
        if (paneId) selfPaneIdRef.current = paneId
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 关闭（workspace / pane）：乐观隐藏 + POST /herdr-close + 失败回滚 + 错误横幅 + refresh
  const [hiddenWorkspaceIds, setHiddenWorkspaceIds] = useState<Set<string>>(new Set())
  const [hiddenPaneIds, setHiddenPaneIds] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<{ message: string; key: number } | null>(null)
  const showErr = (message: string) => setActionError(prev => ({ message, key: (prev?.key ?? 0) + 1 }))
  const postClose = async (kind: 'workspace' | 'pane', id: string): Promise<void> => {
    if (kind === 'workspace') setHiddenWorkspaceIds(prev => new Set(prev).add(id))
    else setHiddenPaneIds(prev => new Set(prev).add(id))
    try {
      const resp = await fetch('/herdr-close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      })
      const body = (await resp.json()) as { ok?: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `herdr-close HTTP ${resp.status}`)
      refreshDash()
    } catch (e) {
      if (kind === 'workspace') setHiddenWorkspaceIds(prev => { const n = new Set(prev); n.delete(id); return n })
      else setHiddenPaneIds(prev => { const n = new Set(prev); n.delete(id); return n })
      showErr(e instanceof Error ? e.message : String(e))
    }
  }
  const onCloseWorkspace = (id: string) => { void postClose('workspace', id) }
  const onClosePane = (id: string) => { void postClose('pane', id) }

  const onPaneClick = (target: HerdrDashboardPaneRef) => {
    const sid = getSessionId()
    void fetchPaneSession(target.pane_id).then(paneSessionId => {
      let state
      try {
        state = navigateToPane(target.pane_id, { selfSessionId: sid, paneSessionId })
      } catch (e) {
        showNotice(e instanceof Error ? e.message : String(e))
        return
      }
      // unbound（无会话归属）同样关闭面板并跳转：navigateToPane 已在本会话
      // Herdr Tab 尽力定位；归属查询失败（fetch 异常）也会落到 unbound，
      // 此时定位是 no-op 但面板已关闭——可接受（不再提示「无法跳转」）。
      closeGlobalDashboard()
    })
  }

  // v4 需求 3：surface header 状态行（状态点 + 状态文本 + 版本 + 启动按钮）；
  // 复用 dashboardStore（与 DashboardContent 共享单飞轮询）与 useHerdrStart。
  const { snap: dashSnap, refresh: refreshDash } = useHerdrDashboard()
  const { starting, startError, start } = useHerdrStart()
  const server = dashSnap?.server
  const serverState = deriveMarkerServerState(dashSnap)
  const stateText = markerStateText(serverState)
  const handleStart = async () => {
    const ok = await start()
    if (ok) {
      refreshDash()
      statusStore.refresh()
    }
  }

  return (
    <section
      ref={panelRef}
      className="herdr-gds"
      role="dialog"
      aria-modal="false"
      aria-label={t('global.title')}
      tabIndex={-1}
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } as CSSProperties}
    >
      <header className="herdr-gds-head">
        <span className="herdr-gds-title">
          <HerdrLogo className="herdr-gds-logo" />
          {t('global.title')}
        </span>
        <span className="herdr-gds-state" data-state={serverState}>
          <span className="herdr-state-dot" data-state={serverState} aria-hidden />
          <span>{stateText}</span>
          {server?.version ? <span className="herdr-gds-version">v{server.version}</span> : null}
        </span>
        {serverState === 'stopped' || serverState === 'not-installed' ? (
          <Button variant="primary" size="sm" disabled={starting} onClick={() => void handleStart()}>
            {starting ? t('view.starting') : t('banner.start')}
          </Button>
        ) : null}
        {startError ? <span className="herdr-gds-start-error">{t('banner.startFailed', { error: startError })}</span> : null}
        {dashSnap ? (
          <span className="herdr-gds-fresh">
            {dashSnap.stale ? <span className="herdr-dash-stale-badge">{t('dashboard.stale')}</span> : null}
            <span className="herdr-gds-fresh-time">
              {dashSnap.updated_at > 0 ? t('dashboard.lastUpdated', { time: formatTime(dashSnap.updated_at) }) : t('dashboard.noData')}
            </span>
            <Button variant="outline" size="sm" onClick={refreshDash}>{t('dashboard.refresh')}</Button>
          </span>
        ) : null}
        <button type="button" className="herdr-gds-close" aria-label={t('global.close')} onClick={close}>
          ✕
        </button>
      </header>
      {notice ? (
        <div className="herdr-gds-notice" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="herdr-action-error" key={actionError.key}>
          <span>{actionError.message}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label={t('view.close')}>✕</button>
        </div>
      ) : null}
      <div className="herdr-gds-body">
        <DashboardContent
          onPaneClick={onPaneClick}
          selfPaneId={selfPaneId}
          hiddenWorkspaceIds={hiddenWorkspaceIds}
          hiddenPaneIds={hiddenPaneIds}
          onCloseWorkspace={onCloseWorkspace}
          onClosePane={onClosePane}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// shell.overlay 注册宿主（无视觉 DOM 的 controller host）
// ---------------------------------------------------------------------------

/**
 * 注册到 shell.overlay 的宿主组件：自身无可见输出（返回 null），副作用为
 * ① 注入 sidebar marker 按钮（进入文档流）；② open 时渲染右侧工作区 surface。
 */
export function SidebarButtonHost() {
  void useHerdrLang()
  const open = useGlobalDashboardOpen()
  const available = useGlobalDashboardAvailable()
  useEffect(() => {
    if (!available) return
    return startSidebarMarkerController({ onActivate: openGlobalDashboard })
  }, [available])
  // surface 由 open store 驱动；关闭后退订 dashboardStore（DashboardContent 卸载）
  return open ? <GlobalDashboardSurface /> : null
}
