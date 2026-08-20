import { useEffect, useId, useRef, useState } from 'react'
import {
  agentKindCounts,
  focusBeforeRemoval,
  layoutTreemap,
  normalizeDashboardKind,
  paneDisplayState,
  paneKeyboardHandlers,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { StatusChips, STATUS_LABEL_KEYS } from './dashboard-summary.tsx'
import { HerdrLogo } from './pane-list.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'
import type { HerdrDashboardPane, HerdrDashboardPaneRef, HerdrDashboardSnapshot, HerdrDashboardWorkspace } from './dashboard-types.ts'

const TREEMAP_HEIGHT = 96

function kindLabel(kind: string): string {
  const normalized = normalizeDashboardKind(kind)
  return normalized === 'unknown' ? t('dashboard.unknown') : normalized
}

function WorkspaceStatusChips({ ws }: { ws: HerdrDashboardWorkspace }) {
  const counts: Record<string, number> = {}
  for (const agent of ws.agents ?? []) {
    const displayState = paneDisplayState(agent.status)
    counts[displayState] = (counts[displayState] ?? 0) + 1
  }
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  if (entries.length === 0) return null
  return <StatusChips counts={counts} />
}

function paneDisplayLabel(pane: HerdrDashboardPane): string {
  return pane.label ?? pane.name ?? (pane.kind !== 'unknown' ? pane.kind : pane.pane_id)
}

function WorkspaceTreemap({ ws, onPaneClick }: {
  ws: HerdrDashboardWorkspace
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const kinds = agentKindCounts(ws.agents ?? []).map(k => ({ key: k.kind, value: k.value }))
  const rects = layoutTreemap(kinds, Math.max(0, width), TREEMAP_HEIGHT)
  if (kinds.length === 0) {
    return <div className="herdr-tm-empty">{t('dashboard.treemapEmpty')}</div>
  }
  return (
    <div ref={containerRef} className="herdr-tm" style={{ height: TREEMAP_HEIGHT }}>
      {rects.map(r => {
        const normalizedKind = normalizeDashboardKind(r.key)
        const agentsOfKind = (ws.agents ?? []).filter(a => normalizeDashboardKind(a.kind) === normalizedKind)
        const isSingle = agentsOfKind.length === 1
        const singleAgent = agentsOfKind[0]
        const canClick = isSingle && !!onPaneClick && !!singleAgent
        return (
          <div
            key={r.key}
            className="herdr-tm-block"
            data-kind={normalizedKind}
            role={canClick ? 'button' : undefined}
            tabIndex={canClick ? 0 : undefined}
            aria-label={`${kindLabel(r.key)} · ${r.value} (${Math.round(r.ratio * 100)}%)`}
            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
            title={
              canClick
                ? `${kindLabel(r.key)} · ${r.value} (${Math.round(r.ratio * 100)}%)`
                : `${kindLabel(r.key)} · ${r.value} (${Math.round(r.ratio * 100)}%)${r.value > 1 ? ` · ${t('dashboard.paneMultiple', { count: r.value })}` : ''}`
            }
            onClick={canClick ? e => { e.stopPropagation(); onPaneClick({ pane_id: singleAgent.pane_id }) } : undefined}
            onKeyDown={canClick ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onPaneClick({ pane_id: singleAgent.pane_id })
              }
            } : undefined}
          >
            <span className="herdr-tm-label" aria-hidden>{normalizedKind}</span>
          </div>
        )
      })}
    </div>
  )
}

function PaneRow({ pane, self, onPaneClick, onClosePane }: {
  pane: HerdrDashboardPane
  self: boolean
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
  onClosePane?: (id: string) => void
}) {
  const displayState = paneDisplayState(pane.status)
  const displayName = paneDisplayLabel(pane)
  const stateLabel = t(STATUS_LABEL_KEYS[displayState])
  const rowLabel = self ? t('dashboard.paneSelfTitle', { id: displayName }) : t('dashboard.paneJumpTitle', { id: displayName })

  const [confirmClose, setConfirmClose] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null)

  const doClose = () => {
    if (closeBusy || !onClosePane) return
    setCloseBusy(true)
    onClosePane(pane.pane_id)
    window.setTimeout(() => setCloseBusy(false), 300)
  }

  return (
    <>
      <div
        className="herdr-dash-pane-row"
        role={onPaneClick ? 'button' : undefined}
        tabIndex={onPaneClick ? 0 : undefined}
        data-pane-id={pane.pane_id}
        data-self={self || undefined}
        aria-label={rowLabel}
        title={rowLabel}
        onClick={onPaneClick ? () => onPaneClick(pane) : undefined}
        onKeyDown={onPaneClick ? (e) => {
          if (e.target !== e.currentTarget) return
          const action = paneKeyboardHandlers(e.key)
          if (action.trigger) {
            if (action.preventDefault) e.preventDefault()
            onPaneClick(pane)
          }
        } : undefined}
      >
        <span className="herdr-dash-pane-dot" data-state={displayState} aria-hidden />
        <span className="herdr-dash-pane-name" title={pane.pane_id}>{displayName}</span>
        {pane.kind !== 'unknown' ? <span className="herdr-dash-pane-kind">{pane.kind}</span> : null}
        <span className="herdr-dash-pane-status" data-state={displayState} aria-label={stateLabel}>{stateLabel}</span>
        <span className="herdr-dash-pane-actions" onClick={e => e.stopPropagation()}>
          {!self && onClosePane ? (
            <button
              type="button"
              className="herdr-dash-pane-close"
              title={t('pane.close')}
              aria-label={t('dashboard.closePaneTitle', { id: pane.pane_id })}
              ref={closeTriggerRef}
              disabled={closeBusy}
              onClick={e => { closeTriggerRef.current = e.currentTarget; setConfirmClose(true) }}
            >
              ✕
            </button>
          ) : null}
        </span>
      </div>
      <ConfirmDialog
        visible={confirmClose}
        busy={closeBusy}
        title={t('pane.closeConfirm', { id: pane.pane_id })}
        confirmLabel={t('pane.close')}
        onConfirm={() => { setConfirmClose(false); focusBeforeRemoval(closeTriggerRef.current); closeTriggerRef.current = null; doClose() }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}

function WorkspaceCard({ ws, selfPaneId, hiddenPaneIds, onPaneClick, onCloseWorkspace, onClosePane }: {
  ws: HerdrDashboardWorkspace
  selfPaneId?: string | null
  hiddenPaneIds?: ReadonlySet<string>
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
  onCloseWorkspace?: (id: string) => void
  onClosePane?: (id: string) => void
}) {
  const label = ws.label ?? ws.workspace_id
  const panes = ws.panes ?? []
  const visiblePanes = hiddenPaneIds ? panes.filter(p => !hiddenPaneIds.has(p.pane_id)) : panes
  const isSelfWs = visiblePanes.some(p => p.pane_id === selfPaneId)

  const [expanded, setExpanded] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const bodyId = useId()

  const doClose = () => {
    if (closeBusy || !onCloseWorkspace) return
    setCloseBusy(true)
    onCloseWorkspace(ws.workspace_id)
    window.setTimeout(() => setCloseBusy(false), 300)
  }

  return (
    <div className="herdr-dash-ws herdr-dash-ws-card">
      <div className="herdr-dash-ws-head">
        <div className="herdr-dash-ws-line1">
          <span className="herdr-dash-ws-label" title={label}>{label}</span>
          <WorkspaceStatusChips ws={ws} />
          <span className="herdr-dash-ws-actions" onClick={e => e.stopPropagation()}>
            {!isSelfWs && onCloseWorkspace ? (
              <button
                type="button"
                className="herdr-dash-ws-close"
                title={t('dashboard.closeWorkspace')}
                aria-label={t('dashboard.closeWorkspaceTitle', { id: label })}
                ref={closeTriggerRef}
                disabled={closeBusy}
                onClick={e => { closeTriggerRef.current = e.currentTarget; setConfirmClose(true) }}
              >
                ✕
              </button>
            ) : null}
          </span>
        </div>
        <div className="herdr-dash-ws-line2">
          <span className="herdr-dash-ws-id">{ws.workspace_id}</span>
          {ws.checkout_path_base ? (
            <span className="herdr-dash-ws-meta" title={ws.checkout_path_base}>{ws.checkout_path_base}</span>
          ) : null}
        </div>
      </div>
      <WorkspaceTreemap ws={ws} onPaneClick={onPaneClick} />
      {visiblePanes.length > 0 ? (
        <button
          type="button"
          className="herdr-dash-link-btn"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? `▾ ` : `▸ `}{t(expanded ? 'dashboard.collapsePanes' : 'dashboard.expandPanes')}
          <span className="herdr-dash-pane-count"> · {visiblePanes.length}</span>
        </button>
      ) : null}
      {expanded ? (
        <div id={bodyId} className="herdr-dash-pane-list">
          {visiblePanes.map(pane => (
            <PaneRow
              key={pane.pane_id}
              pane={pane}
              self={pane.pane_id === selfPaneId}
              onPaneClick={onPaneClick}
              onClosePane={onClosePane}
            />
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        visible={confirmClose}
        busy={closeBusy}
        title={t('view.closeWorkspaceConfirm', { id: label, count: visiblePanes.length })}
        confirmLabel={t('dashboard.closeWorkspace')}
        onConfirm={() => { setConfirmClose(false); focusBeforeRemoval(closeTriggerRef.current); closeTriggerRef.current = null; doClose() }}
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  )
}

export function DashboardWorkspaces({ snap, selfPaneId, hiddenWorkspaceIds, hiddenPaneIds, onPaneClick, onCloseWorkspace, onClosePane }: {
  snap: HerdrDashboardSnapshot
  selfPaneId?: string | null
  hiddenWorkspaceIds?: ReadonlySet<string>
  hiddenPaneIds?: ReadonlySet<string>
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
  onCloseWorkspace?: (id: string) => void
  onClosePane?: (id: string) => void
}) {
  void useHerdrLang()
  const visible = hiddenWorkspaceIds
    ? snap.workspaces.filter(ws => !hiddenWorkspaceIds.has(ws.workspace_id))
    : snap.workspaces
  if (visible.length === 0) {
    return (
      <div className="herdr-dash-empty">
        <HerdrLogo className="herdr-dash-empty-logo" />
        <div>{t('dashboard.empty')}</div>
      </div>
    )
  }
  return (
    <section className="herdr-dash-section">
      <div className="herdr-dash-section-head">
        <span>{t('dashboard.workspaces')}</span>
        <span className="herdr-dash-section-count">
          {snap.summary.workspaces} {t('dashboard.workspaces')} · {snap.summary.panes} {t('dashboard.panes')} · {snap.summary.tabs} {t('dashboard.tabs')}
        </span>
      </div>
      <div className="herdr-dash-ws-grid">
        {visible.map(ws => (
          <WorkspaceCard
            key={ws.workspace_id}
            ws={ws}
            selfPaneId={selfPaneId}
            hiddenPaneIds={hiddenPaneIds}
            onPaneClick={onPaneClick}
            onCloseWorkspace={onCloseWorkspace}
            onClosePane={onClosePane}
          />
        ))}
      </div>
    </section>
  )
}
