import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  agentTheme,
  applyPaneOrder,
  filterGroupsToSession,
  isDshPane,
  loadPaneOrder,
  paneDisplayName,
  reorderPanes,
  savePaneOrder,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { getPendingFocusPane, setPendingFocusPane } from './navigation.ts'
import { useSelfPaneId } from './self-pane-store.ts'
import { HerdrServerBanner } from './server-banner.tsx'
import { HerdrLogo } from './pane-list.tsx'
import { fetchPaneOutputsDetailed, subscribeHerdrEvents, useHerdrStatus, useHerdrStart } from './store.ts'
import { useHerdrMode } from './mode.ts'
import { getActivePane, setActivePane, useLayoutMode } from './layout-mode.ts'
import type { HerdrAgentStatus, HerdrPaneView } from './types.ts'
import { PaneTerminal } from './pane-terminal.tsx'
import { PaneGridView } from './pane-grid-view.tsx'
import { PaneListView } from './pane-list-view.tsx'

// 会话页 header 状态胶囊（conversation.session.header.actions）
// 已移除顶栏「herdr 运行中」显示（需求：会话页面顶栏不再展示该胶囊）
export function HerdrHeaderPill() {
  return null
}

// ── 操作错误采集（关闭失败等，显示在工具栏下方一条横幅） ─────────────
type ActionError = { message: string; key: number }

// ── Herdr tab 内容（design: dashboard-global §4.2/§5 落地调整） ──
// 全局 Dashboard 入口在左侧边栏「新会话」下方（全局面板）；Herdr tab 内曾有的
// 「打开全局仪表盘」降级按钮已移除（用户定案），tab 只保留会话级 Panes 视图。
// 门控在 HerdrPanesView 内：非 herdr 模式整页不渲染。
export function HerdrView() {
  return <HerdrPanesView />
}

export function HerdrPanesView() {
  void useHerdrLang()
  const herdrMode = useHerdrMode()
  const { snap, error, refresh } = useHerdrStatus()
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const maximizedTriggerRef = useRef<HTMLElement | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [insertPos, setInsertPos] = useState<'before' | 'after' | null>(null)

  // ── T11 本地乐观状态 ──────────────────────────────────────────────
  // selfPaneId：本对话绑定 pane（不渲染 ✕）— 单例订阅，退避由 store 驱动
  const selfPaneIdRaw = useSelfPaneId()
  const selfPaneId = selfPaneIdRaw ?? null
  // 关闭成功后的本地隐藏集（乐观移除；轮询收敛/失败回滚前过滤展示）
  const [hiddenPaneIds, setHiddenPaneIds] = useState<Set<string>>(new Set())
  // 重命名本地覆盖：Map<id, string | null>（null = 清除名称；undefined = 无覆盖）
  const [labelOverrides, setLabelOverrides] = useState<Map<string, string | null>>(new Map())
  const [actionError, setActionError] = useState<ActionError | null>(null)
  // 跨 workspace drop 提示（T15）：拖动手柄拖动但未在同 workspace 内落位时显示的顶部横幅
  const [dropHint, setDropHint] = useState<string | null>(null)
  const dropHintTimerRef = useRef<number | undefined>(undefined)
  // 本次拖拽是否已在同 workspace 内成功落位（用于区分「跨 ws / 未落位」与「正常排序」）
  const droppedRef = useRef(false)

  // 卸载时清理 drop 提示定时器
  useEffect(() => () => {
    window.clearTimeout(dropHintTimerRef.current)
  }, [])

  const showErr = useCallback((message: string) => {
    setActionError(prev => ({ message, key: (prev?.key ?? 0) + 1 }))
  }, [])

  // 面板跳转：滚动高亮对应 pane（挂载时消费 pending）
  useEffect(() => {
    const focusPane = (paneId: string) => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-pane-id='${paneId}']`)
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
    if (getPendingFocusPane()) {
      focusPane(getPendingFocusPane()!)
      setPendingFocusPane(null)
    }
    return () => document.removeEventListener('herdr:focus-pane', handler)
  }, [])

  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  // panes → workspace_id 映射（跨 workspace drop 校验用）
  const paneWsByPane = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of snap?.topology?.panes ?? []) m.set(p.pane_id, p.workspace_id)
    return m
  }, [snap?.topology])
  // 会话聚焦（design: herdr-mode-gating）：Tab 只显示本会话专属 workspace 及其 pane；
  // 随后按隐藏集过滤 + 持久化顺序覆盖每个 ws 的 pane 顺序
  const groups = useMemo(() => filterGroupsToSession(snap?.topology, selfPaneId), [snap?.topology, selfPaneId])
  const orderedByWs = useMemo(() => {
    const m = new Map<string, HerdrPaneView[]>()
    for (const g of groups) {
      // 过滤隐藏 + dsh 基础设施 pane（插件自身 pane，如绑定根 pane）+ 应用 label override
      let panes = g.panes
      if (hiddenPaneIds.size > 0) panes = panes.filter(p => !hiddenPaneIds.has(p.pane_id))
      panes = panes.filter(p => !isDshPane(p, agentByPane.get(p.pane_id)))
      if (labelOverrides.size > 0) {
        panes = panes.map(p => {
          const ov = labelOverrides.get(p.pane_id)
          if (ov === undefined) return p
          return { ...p, label: ov === null ? undefined : ov }
        })
      }
      m.set(g.workspace.workspace_id, applyPaneOrder(panes, loadPaneOrder(g.workspace.workspace_id)))
    }
    return m
  }, [groups, hiddenPaneIds, labelOverrides, agentByPane])
  // workspace 组 label override（v3：单一会话 workspace，无组头/折叠）
  const visibleGroups = useMemo(() => {
    return groups.map(g => {
      const ov = labelOverrides.get(g.workspace.workspace_id)
      if (ov === undefined) return g
      return { ...g, workspace: { ...g.workspace, label: ov === null ? undefined : ov } }
    })
  }, [groups, labelOverrides])
  // 扁平 pane 网格：全部可见 pane（按 ws 持久化顺序合并）
  const wsId = visibleGroups[0]?.workspace.workspace_id ?? ''
  const allPanes = useMemo(
    () => visibleGroups.flatMap(g => orderedByWs.get(g.workspace.workspace_id) ?? g.panes),
    [visibleGroups, orderedByWs],
  )

  const [paneOutputs, setPaneOutputs] = useState<Map<string, { text: string; truncated: boolean }>>(new Map())
  const gridRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(false)
  const pendingOutputIdsRef = useRef<Set<string>>(new Set())
  // SSE handler 需稳定挂载（共享流常驻），allPanes 经 ref 读取避免 effect 反复重建
  const allPanesRef = useRef(allPanes)
  allPanesRef.current = allPanes

  const fetchVisibleOutputs = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    const uniq = [...new Set(ids)]
    try {
      const map = await fetchPaneOutputsDetailed(uniq, 40)
      if (map.size === 0) return
      setPaneOutputs(prev => {
        const next = new Map(prev)
        for (const [k, v] of map) next.set(k, v)
        return next
      })
    } catch { /* empty map fallback handled in store */ }
  }, [])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      visibleRef.current = true
      if (allPanes.length > 0) void fetchVisibleOutputs(allPanes.map(p => p.pane_id))
      return
    }
    const el = gridRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      const isVis = entries.some(e => e.isIntersecting)
      visibleRef.current = isVis
      if (isVis) {
        const pending = [...pendingOutputIdsRef.current]
        pendingOutputIdsRef.current.clear()
        const ids = pending.length > 0 ? pending : allPanes.map(p => p.pane_id)
        if (ids.length > 0) void fetchVisibleOutputs(ids)
      }
    }, { threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [allPanes, fetchVisibleOutputs])

  useEffect(() => {
    if (allPanes.length === 0) return
    if (visibleRef.current) void fetchVisibleOutputs(allPanes.map(p => p.pane_id))
  }, [allPanes, fetchVisibleOutputs])

  useEffect(() => {
    if (typeof window === 'undefined') return
    return subscribeHerdrEvents(ev => {
      if (ev.type !== 'output') return
      const pid = ev.pane_id
      if (!pid) return
      if (!allPanesRef.current.some(p => p.pane_id === pid)) return
      if (visibleRef.current) {
        void fetchVisibleOutputs([pid])
      } else {
        pendingOutputIdsRef.current.add(pid)
      }
    })
  }, [fetchVisibleOutputs])

  const agentByPaneWithOutputs = useMemo(() => {
    if (paneOutputs.size === 0) return agentByPane
    const m = new Map(agentByPane)
    for (const [paneId, v] of paneOutputs) {
      const prev = m.get(paneId)
      if (prev) m.set(paneId, { ...prev, output: v.text, outputTruncated: v.truncated })
    }
    return m
  }, [agentByPane, paneOutputs])

  // ── 双布局模式（按 workspace 隔离，默认 window 兼容现行为） ─────────────
  const [layoutMode, setLayoutMode] = useLayoutMode(wsId || undefined)
  const [activePaneId, setActivePaneIdState] = useState<string | null>(null)
  const selectActive = useCallback((paneId: string) => {
    setActivePaneIdState(paneId)
    if (wsId) setActivePane(wsId, paneId)
  }, [wsId])
  useEffect(() => {
    if (!wsId || allPanes.length === 0) return
    const stored = getActivePane(wsId)
    if (stored && allPanes.some(p => p.pane_id === stored)) {
      setActivePaneIdState(stored)
      return
    }
    // fallback: 首 pane 且更新记忆
    const fallback = allPanes[0]?.pane_id ?? null
    if (fallback) {
      setActivePaneIdState(fallback)
      setActivePane(wsId, fallback)
    }
  }, [wsId, allPanes])
  // 外部聚焦事件同步到列表选中
  useEffect(() => {
    const handler = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId: string }>).detail?.paneId
      if (!paneId) return
      if (layoutMode === 'list' && allPanes.some(p => p.pane_id === paneId)) {
        selectActive(paneId)
      }
    }
    document.addEventListener('herdr:focus-pane', handler)
    return () => document.removeEventListener('herdr:focus-pane', handler)
  }, [layoutMode, allPanes, selectActive])
  useEffect(() => {
    const ev = new CustomEvent('herdr:layout-changed')
    window.dispatchEvent(ev)
    document.dispatchEvent(ev)
  }, [layoutMode])

  const paneCount = allPanes.length
  const wsCount = visibleGroups.length
  const agentCount = allPanes.filter(p => agentByPaneWithOutputs.has(p.pane_id)).length
  const serverRunning = snap?.server?.running === true

  // ── T11 关闭交互 ──────────────────────────────────────────────────
  // 通用：POST + 乐观移除 + 失败回滚 + 错误横幅 + refresh（v3：仅 pane 级关闭）
  const postClose = useCallback(async (paneId: string): Promise<void> => {
    setHiddenPaneIds(prev => new Set(prev).add(paneId))
    try {
      const resp = await fetch('/herdr-close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pane', id: paneId }),
      })
      const body = (await resp.json()) as { ok?: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `herdr-close HTTP ${resp.status}`)
      refresh()
    } catch (e) {
      // 回滚乐观移除
      setHiddenPaneIds(prev => { const n = new Set(prev); n.delete(paneId); return n })
      showErr(e instanceof Error ? e.message : String(e))
    }
  }, [refresh, showErr])

  const onClosePane = useCallback((paneId: string) => {
    void postClose(paneId)
  }, [postClose])

  // ── T12 重命名交互 ────────────────────────────────────────────────
  const doRename = useCallback(async (kind: 'pane' | 'workspace', id: string, label: string | null): Promise<void> => {
    try {
      const resp = await fetch('/herdr-rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id, label }),
      })
      const body = (await resp.json()) as { ok?: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `herdr-rename HTTP ${resp.status}`)
      // 乐观覆盖可持续展示（服务端持久化后 refresh 收敛；此处保留覆盖避免闪回）
      setLabelOverrides(prev => { const n = new Map(prev); n.set(id, label); return n })
      refresh()
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e))
    }
  }, [refresh])

  const onRenamePane = useCallback((paneId: string, label: string | null) => {
    return doRename('pane', paneId, label)
  }, [doRename])

  // ── 拖拽事件（HTML5 DnD，仅同 workspace 排序） ──────────────────────────

  /** 手柄 dragstart：写入自定义 MIME + 标记被拖项。 */
  const onHandleDragStart = useCallback((e: DragEvent, paneId: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/herdr-pane', paneId)
    setDragId(paneId)
    droppedRef.current = false // 本次拖拽尚未落位
  }, [])

  /** 手柄 dragend：清理所有拖拽状态（含拖到空白 / 跨 ws 取消）。 */
  const clearDrag = useCallback(() => {
    setDragId(null)
    setOverId(null)
    setInsertPos(null)
  }, [])
  const onHandleDragEnd = useCallback((e: DragEvent) => {
    void e
    // 拖拽待结算（未同 ws 落位）：说明用户拖到了跨 workspace / 空白处且被忽略 → 一次性提示
    if (dragId && !droppedRef.current) {
      setDropHint(t('view.dropHint'))
      window.clearTimeout(dropHintTimerRef.current)
      dropHintTimerRef.current = window.setTimeout(() => setDropHint(null), 2000)
    }
    clearDrag()
  }, [dragId, clearDrag])

  /** 目标卡片 dragover：preventDefault（否则 drop 不触发）+ 按指针水平半分判定 before/after。 */
  const onCardDragOver = useCallback((e: DragEvent, targetId: string, targetWsId: string) => {
    if (!dragId) return
    if (paneWsByPane.get(dragId) !== targetWsId) return // 跨 workspace：不显示指示
    if (dragId === targetId) return // 拖到自身：不显示指示
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const el = e.currentTarget
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect()
      // 两列按行序排布→水平判定：指针在卡片左半 → before，右半 → after
      const pos: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      setOverId(targetId)
      setInsertPos(pos)
    }
  }, [dragId, paneWsByPane])

  const onCardDragLeave = useCallback(() => {
    setOverId(null)
    setInsertPos(null)
  }, [])

  /** 目标卡片 drop：同 ws 内落位 → reorderPanes → savePaneOrder。 */
  const onCardDrop = useCallback((e: DragEvent, targetId: string, targetWsId: string) => {
    e.preventDefault()
    if (!dragId) return
    if (paneWsByPane.get(dragId) !== targetWsId) return // 跨 workspace：忽略 + 清理
    const ordered = orderedByWs.get(targetWsId) ?? []
    const from = ordered.findIndex(p => p.pane_id === dragId)
    const toTarget = ordered.findIndex(p => p.pane_id === targetId)
    if (from < 0 || toTarget < 0) return
    // 落位后索引 to：考虑"先移除被拖项致目标项左移一位"的位移（见 client-logic.reorderPanes 注释）
    const to = insertPos === 'before'
      ? (from < toTarget ? toTarget - 1 : toTarget)
      : (from < toTarget ? toTarget : toTarget + 1)
    const newOrder = reorderPanes(ordered.map(p => p.pane_id), from, to)
    savePaneOrder(targetWsId, newOrder)
    droppedRef.current = true
    clearDrag()
  }, [dragId, insertPos, orderedByWs, paneWsByPane, clearDrag])


  // 非 herdr 模式不渲染视图（tab 已由 CSS 门控隐藏；此处兜底会话正文空白）
  if (!herdrMode) return null

  return (
    <div className="herdr-root">
      {/* 运行态折叠进 .herdr-head（连接点 + 版本）；非运行态保留横幅（承载启动流程） */}
      {!serverRunning ? <HerdrServerBanner snap={snap} error={error} onStarted={refresh} /> : null}

      {dropHint ? <div className="herdr-drop-hint">{dropHint}</div> : null}
      {snap?.stale ? <div className="herdr-stale-hint" role="status">{t('dashboard.stale')}</div> : null}

      <div className="herdr-head">
        <span className="herdr-head-title">
          {visibleGroups[0]?.workspace.label ?? visibleGroups[0]?.workspace.workspace_id ?? 'Herdr'}
        </span>
        {serverRunning ? (
          <span className="herdr-head-server" role="status" aria-label={t('banner.running')}>
            <span className="herdr-conn-dot ok" aria-hidden />
            {snap?.server?.version ? <span className="herdr-head-version">v{snap.server.version}</span> : null}
          </span>
        ) : null}
        <span className="herdr-header-stats">
          {t('view.stats', { ws: wsCount, panes: paneCount, agents: agentCount })}
        </span>
        <span className="herdr-head-actions">
          <span className="herdr-layout-switch" role="tablist" aria-label={t('view.layoutHint')}>
            <button
              type="button"
              role="tab"
              aria-selected={layoutMode === 'window'}
              className={layoutMode === 'window' ? 'active' : undefined}
              onClick={() => setLayoutMode('window')}
            >
              {t('view.layoutWindow')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={layoutMode === 'list'}
              className={layoutMode === 'list' ? 'active' : undefined}
              onClick={() => setLayoutMode('list')}
            >
              {t('view.layoutList')}
            </button>
          </span>
          <Button variant="outline" size="sm" onClick={refresh}>{t('view.refresh')}</Button>
        </span>
      </div>

      {error ? <div className="herdr-server-error">{t('view.statusError', { error })}</div> : null}
      {actionError ? (
        <div className="herdr-action-error" key={actionError.key}>
          <span>{actionError.message}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label={t('view.close')}>✕</button>
        </div>
      ) : null}

      {snap && !snap.connected ? (
        <div className="herdr-install">
          <div className="herdr-install-title">{t('view.installTitle')}</div>
          {t('view.installBody')}
          <br />
          <code>curl -fsSL https://herdr.dev/install.sh | sh</code>
        </div>
      ) : null}

      {!maximizedPaneId && allPanes.length === 0 ? (
        <div className="herdr-empty">
          <HerdrLogo className="herdr-empty-logo" />
          {selfPaneId ? t('panel.noPane') : t('panel.fetchingPane')}
        </div>
      ) : !maximizedPaneId ? (
        <div ref={gridRef}>
          {layoutMode === 'list' ? (
            <PaneListView
              panes={allPanes}
              agentByPane={agentByPaneWithOutputs}
              selfPaneId={selfPaneId}
              activePaneId={activePaneId}
              onSelect={selectActive}
              onClosePane={onClosePane}
              onRenamePane={onRenamePane}
              wsId={wsId}
            />
          ) : (
            <PaneGridView
              panes={allPanes}
              agentByPane={agentByPaneWithOutputs}
              selfPaneId={selfPaneId}
              wsId={wsId}
              dragId={dragId}
              overId={overId}
              insertPos={insertPos}
              onClosePane={onClosePane}
              onRenamePane={onRenamePane}
              onMaximize={(paneId, triggerEl) => {
                maximizedTriggerRef.current = triggerEl
                setMaximizedPaneId(paneId)
              }}
              onHandleDragStart={onHandleDragStart}
              onHandleDragEnd={onHandleDragEnd}
              onCardDragOver={onCardDragOver}
              onCardDrop={onCardDrop}
              onCardDragLeave={onCardDragLeave}
            />
          )}
        </div>
      ) : null}

      {/* 最大化终端视图（design: pane-interactive-terminal §5）— 替换列表 */}
      {maximizedPaneId ? (
        <div className="herdr-terminal-maximized" data-herdr-terminal-maximized="1">
          <div className="herdr-term-max-toolbar">
            <span className="herdr-term-max-title">
              {(() => {
                const ma = agentByPaneWithOutputs.get(maximizedPaneId)
                const pane = allPanes.find(p => p.pane_id === maximizedPaneId)
                const name = pane ? paneDisplayName(pane, ma) : (ma?.pane_id ?? maximizedPaneId)
                return ma && ma.agent !== 'dsh' ? `${name} — ${ma.agent}` : name
              })()}
            </span>
            <button
              type="button"
              className="herdr-term-max-close"
              aria-label={t('pane.restore')}
              onClick={() => {
                setMaximizedPaneId(null)
                maximizedTriggerRef.current?.focus()
                maximizedTriggerRef.current = null
              }}
            >
              ✕
            </button>
          </div>
          <PaneTerminal
            paneId={maximizedPaneId}
            status={agentByPaneWithOutputs.get(maximizedPaneId)?.status}
            accent={agentByPaneWithOutputs.get(maximizedPaneId) ? agentTheme(agentByPaneWithOutputs.get(maximizedPaneId)!.agent) : undefined}
            maximized
          />
        </div>
      ) : null}
    </div>
  )
}
