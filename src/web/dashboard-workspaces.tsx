// Dashboard workspace 区（design: dashboard-redesign —— 外层 workspace 卡片 +
// 状态堆积条 + kind chips；替代 v4 的 agent-kind Treemap）。workspace 卡片（含头部）
// **不承载返回会话行为**——关闭 surface 由 header ✕ 按钮承担。堆积条分段由
// client-logic 的 stackedBarSegments 计算（规范顺序、比例守恒）。
// v5（design: dashboard-close-jump）：卡片加 ✕ 关闭（确认框显示 pane 数）+ 可展开
// pane 列表（点击跳转 / ✕ 关闭）；自 pane / 自 workspace 隐藏 ✕。

import { useId, useRef, useState } from 'react'
import {
  agentKindCounts,
  focusBeforeRemoval,
  normalizeDashboardKind,
  normalizeDashboardKindCounts,
  paneDisplayState,
  paneKeyboardHandlers,
  stackedBarSegments,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { StatusChips, STATUS_LABEL_KEYS } from './dashboard-summary.tsx'
import { HerdrLogo } from './pane-list.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'
import type { HerdrDashboardPane, HerdrDashboardPaneRef, HerdrDashboardSnapshot, HerdrDashboardWorkspace } from './dashboard-types.ts'

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

/** pane 显示名回退链：label > name > kind（非 unknown）> pane_id。 */
function paneDisplayLabel(pane: HerdrDashboardPane): string {
  return pane.label ?? pane.name ?? (pane.kind !== 'unknown' ? pane.kind : pane.pane_id)
}

/** 单条 pane 行：状态点 + 名称 + kind + 状态 + 点击跳转 + ✕ 关闭。 */
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
          // 仅当焦点在行本身（而非嵌套的 ✕ 按钮）时激活，避免关闭按钮 Enter 误触跳转
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

/** 单个 workspace 卡片：两行头部 + 状态堆积条 + kind chips + 可展开 pane 列表 + ✕ 关闭。 */
function WorkspaceCard({ ws, selfPaneId, hiddenPaneIds, onPaneClick, onCloseWorkspace, onClosePane }: {
  ws: HerdrDashboardWorkspace
  selfPaneId?: string | null
  hiddenPaneIds?: ReadonlySet<string>
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
  onCloseWorkspace?: (id: string) => void
  onClosePane?: (id: string) => void
}) {
  const segments = stackedBarSegments((ws.agents ?? []).map(agent => agent.status))
  const kindCounts = normalizeDashboardKindCounts(agentKindCounts(ws.agents ?? []))
  const label = ws.label ?? ws.workspace_id
  const barLabel = segments.map(seg => `${t(STATUS_LABEL_KEYS[seg.state])} ${seg.count}`).join(' · ')
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
      <div className="herdr-dash-bar" role="img" aria-label={segments.length > 0 ? `${label}: ${barLabel}` : label}>
        {segments.map(seg => (
          <span key={seg.state} className="herdr-dash-bar-seg" data-state={seg.state} style={{ flexGrow: seg.count }} />
        ))}
      </div>
      {kindCounts.length > 0 ? (
        <div className="herdr-dash-kind-chips">
          {kindCounts.map(kind => (
            <span key={kind.kind} className="herdr-dash-kind-chip">
              <span className="herdr-dash-agent-dot" data-kind={kind.kind} aria-hidden />
              <span>{kindLabel(kind.kind)}</span>
              <b>{kind.value}</b>
            </span>
          ))}
        </div>
      ) : null}

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
