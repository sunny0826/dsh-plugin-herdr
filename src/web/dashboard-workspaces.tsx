// Dashboard workspace 区（design: dashboard-redesign —— 外层 workspace 卡片 +
// 状态堆积条 + kind chips；替代 v4 的 agent-kind Treemap）。workspace 卡片（含头部）
// **不承载返回会话行为**——关闭 surface 由 header ✕ 按钮承担。堆积条分段由
// client-logic 的 stackedBarSegments 计算（规范顺序、比例守恒）。
// 布局纯函数在 client-logic（stackedBarSegments/agentKindCounts）。

import { agentKindCounts, normalizeDashboardKind, normalizeDashboardKindCounts, paneDisplayState, stackedBarSegments } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { StatusChips, STATUS_LABEL_KEYS } from './dashboard-summary.tsx'
import { HerdrLogo } from './pane-list.tsx'
import type { HerdrDashboardSnapshot, HerdrDashboardWorkspace } from './dashboard-types.ts'

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

/** 单个 workspace 卡片：两行头部 + 状态堆积条（role=img aria-label 汇总）+ kind chips。 */
function WorkspaceCard({ ws }: { ws: HerdrDashboardWorkspace }) {
  const segments = stackedBarSegments((ws.agents ?? []).map(agent => agent.status))
  const kindCounts = normalizeDashboardKindCounts(agentKindCounts(ws.agents ?? []))
  const label = ws.label ?? ws.workspace_id
  const barLabel = segments.map(seg => `${t(STATUS_LABEL_KEYS[seg.state])} ${seg.count}`).join(' · ')
  return (
    <div className="herdr-dash-ws herdr-dash-ws-card">
      <div className="herdr-dash-ws-head">
        <div className="herdr-dash-ws-line1">
          <span className="herdr-dash-ws-label" title={label}>{label}</span>
          <WorkspaceStatusChips ws={ws} />
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
    </div>
  )
}

export function DashboardWorkspaces({ snap }: {
  snap: HerdrDashboardSnapshot
}) {
  void useHerdrLang()
  if (snap.workspaces.length === 0) {
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
        {snap.workspaces.map(ws => (
          <WorkspaceCard key={ws.workspace_id} ws={ws} />
        ))}
      </div>
    </section>
  )
}
