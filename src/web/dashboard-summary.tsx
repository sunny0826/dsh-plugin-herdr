// Dashboard 摘要卡片（design: dashboard-redesign —— KPI 条 + 状态 chips 一次渲染；
// 代理卡片行可点击跳转；Server/Socket/Host 合并为「服务与环境」单卡，详情默认折叠）。

import { useId, useState, type ReactNode } from 'react'
import {
  collectDashboardAgents,
  formatBytes,
  formatDuration,
  formatTime,
  normalizeDashboardKind,
  paneDisplayState,
  paneKeyboardHandlers,
  sortedStatusCounts,
} from '../client-logic.ts'
import { t, useHerdrLang, type I18nKey } from './i18n.ts'
import type { PaneDisplayState } from '../client-logic.ts'
import type { HerdrDashboardSnapshot, HerdrDashboardAgent, HerdrDashboardPaneRef } from './dashboard-types.ts'

export const STATUS_LABEL_KEYS: Record<PaneDisplayState, I18nKey> = {
  working: 'dashboard.working',
  idle: 'dashboard.idle',
  blocked: 'dashboard.blocked',
  done: 'dashboard.done',
  unknown: 'dashboard.unknown',
}

function statusLabelKey(status: string): I18nKey {
  return STATUS_LABEL_KEYS[paneDisplayState(status)]
}

/** 状态分布 chips（稳定顺序：working/blocked/idle/done/unknown）。 */
export function StatusChips({ counts }: { counts: Record<string, number> }) {
  void useHerdrLang()
  const normalizedCounts = Object.entries(counts).reduce<Record<string, number>>((normalized, [status, count]) => {
    const displayState = paneDisplayState(status)
    normalized[displayState] = (normalized[displayState] ?? 0) + count
    return normalized
  }, {})
  return (
    <div className="herdr-dash-ws-chips">
      {sortedStatusCounts(normalizedCounts).map(([status, n]) => {
        const displayState = paneDisplayState(status)
        return (
          <span key={displayState} className="herdr-dash-chip" data-state={displayState}>
            <b>{n}</b> {t(statusLabelKey(displayState))}
          </span>
        )
      })}
    </div>
  )
}

/** Dashboard 卡片容器。 */
export function DashboardCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="herdr-dash-card">
      <div className="herdr-dash-card-title">{title}{hint ? <span className="herdr-dash-card-hint" title={hint} aria-label={hint}>ⓘ</span> : null}</div>
      {children}
    </div>
  )
}

/** Dashboard 键值行（值可等宽/省略号截断）。 */
export function DashboardRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="herdr-dash-row">
      <span className="herdr-dash-row-label">{label}</span>
      <span className={'herdr-dash-row-value' + (mono ? ' herdr-dash-code' : '')}>{value}</span>
    </div>
  )
}

/** 代理显示名：name → kind → 「未命名代理」。 */
function agentDisplayName(a: HerdrDashboardAgent): string {
  if (a.name && a.name.trim() !== '') return a.name
  const kind = normalizeDashboardKind(a.kind)
  return kind === 'unknown' ? t('dashboard.agentUnnamed') : kind
}

/** KPI 条块（大数字 + 11px 标签；working 用品牌色 / blocked 用错误红 + 脉冲点）。 */
function KpiTile({ label, value, tone }: { label: string; value: number; tone?: 'working' | 'blocked' }) {
  const blocked = tone === 'blocked'
  return (
    <div className={'herdr-dash-kpi' + (tone ? ` herdr-dash-kpi-${tone}` : '')}>
      <span className="herdr-dash-kpi-value">
        {value}
        {blocked && value > 0 ? <span className="herdr-dash-kpi-dot" aria-hidden /> : null}
      </span>
      <span className="herdr-dash-kpi-label">{label}</span>
    </div>
  )
}

/** 代理 卡片：全名称列表（默认前 8 项，显示全部展开）；行可点击跳转 pane。 */
function AgentsCard({ agents, onPaneClick }: { agents: HerdrDashboardAgent[]; onPaneClick?: (target: HerdrDashboardPaneRef) => void }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? agents : agents.slice(0, 8)
  return (
    <DashboardCard title={t('dashboard.agents')}>
      {agents.length > 0 ? (
        <ul className="herdr-dash-agent-list" data-collapsed={!showAll || undefined}>
          {visible.map(agent => {
            const kind = normalizeDashboardKind(agent.kind)
            return (
              <li
                key={agent.pane_id}
                className="herdr-dash-agent-row"
                role={onPaneClick ? 'button' : undefined}
                tabIndex={onPaneClick ? 0 : undefined}
                aria-label={onPaneClick ? `${agentDisplayName(agent)} · ${t(statusLabelKey(agent.status))}` : undefined}
                onClick={onPaneClick ? () => onPaneClick(agent) : undefined}
                onKeyDown={onPaneClick ? (e) => {
                  const action = paneKeyboardHandlers(e.key)
                  if (action.trigger) {
                    e.preventDefault()
                    onPaneClick(agent)
                  }
                } : undefined}
              >
                <span className="herdr-dash-agent-dot" data-kind={kind} aria-hidden />
                <span className="herdr-dash-agent-name" title={agentDisplayName(agent)}>{agentDisplayName(agent)}</span>
                <span className="herdr-dash-agent-kind">{kind}</span>
                <span className="herdr-dash-agent-status" data-state={paneDisplayState(agent.status)}>{t(statusLabelKey(agent.status))}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="herdr-dash-row"><span className="herdr-dash-row-value">{t('dashboard.noData')}</span></div>
      )}
      {agents.length > 8 ? (
        <button type="button" className="herdr-dash-link-btn" onClick={() => setShowAll(value => !value)}>
          {showAll ? t('dashboard.collapseAgents') : t('dashboard.showAllAgents')}
        </button>
      ) : null}
    </DashboardCard>
  )
}

/** 服务与环境卡片：主行（版本·协议 + 进程指标 + 尽力采集注记）+ 折叠详情（socket/host）。 */
function EnvCard({ snap }: { snap: HerdrDashboardSnapshot }) {
  const [details, setDetails] = useState(false)
  const detailsId = useId()
  const process = snap.process
  const version = snap.server.version ? `v${snap.server.version}` : '—'
  const protocol = snap.server.protocol != null ? String(snap.server.protocol) : '—'
  return (
    <DashboardCard title={t('dashboard.env')}>
      <DashboardRow label={t('dashboard.versionProtocol')} value={`${version} · ${protocol}`} mono />
      {process.available ? (
        <>
          <DashboardRow label={t('dashboard.pid')} value={process.pid != null ? String(process.pid) : t('dashboard.unavailable')} mono />
          <DashboardRow label={t('dashboard.cpu')} value={process.cpu_percent != null ? `${process.cpu_percent.toFixed(1)} %` : t('dashboard.unavailable')} />
          <DashboardRow label={t('dashboard.memory')} value={process.rss_bytes != null ? (formatBytes(process.rss_bytes) ?? t('dashboard.unavailable')) : t('dashboard.unavailable')} />
          <DashboardRow label={t('dashboard.uptime')} value={process.started_at != null ? (formatDuration(Math.max(0, process.sampled_at - process.started_at)) ?? '—') : '—'} mono />
        </>
      ) : (
        <div className="herdr-dash-process-unavail">
          <span className="herdr-dash-stale-badge">{t('dashboard.unavailable')}</span>
          <span>{t('dashboard.reason')}: {process.error ?? '—'}</span>
        </div>
      )}
      <div className="herdr-dash-process-note">
        {t('dashboard.bestEffort')}
        {process.sampled_at > 0 ? ` · ${t('dashboard.sampledHint', { time: formatTime(process.sampled_at) })}` : ''}
      </div>
      <button
        type="button"
        className="herdr-dash-link-btn"
        aria-expanded={details}
        aria-controls={detailsId}
        onClick={() => setDetails(value => !value)}
      >
        {details ? `▾ ` : `▸ `}{t('dashboard.details')}
      </button>
      {details ? (
        <div id={detailsId} className="herdr-dash-env-details">
          <DashboardRow
            label={t('dashboard.socketStatus')}
            value={snap.connection.connected ? t('dashboard.connected') : t('dashboard.disconnected')}
          />
          <DashboardRow label={t('dashboard.socketPath')} value={snap.server.socket ?? '—'} mono />
          <DashboardRow
            label={t('dashboard.lastSuccess')}
            value={snap.connection.last_success_at > 0 ? formatTime(snap.connection.last_success_at) : '—'}
            mono
          />
          <DashboardRow label={t('dashboard.hostname')} value={snap.host.hostname} mono />
          <DashboardRow label={t('dashboard.os')} value={`${snap.host.os_type} ${snap.host.os_release}`} />
          <DashboardRow label={t('dashboard.platform')} value={snap.host.platform} mono />
          <DashboardRow label={t('dashboard.arch')} value={snap.host.arch} mono />
        </div>
      ) : null}
    </DashboardCard>
  )
}

/** 按展示态聚合计数（agents_by_status 可能含未归一化原始状态）。 */
function statusCount(counts: Record<string, number>, state: PaneDisplayState): number {
  let n = 0
  for (const [s, c] of Object.entries(counts)) {
    if (paneDisplayState(s) === state) n += c
  }
  return n
}

export function DashboardSummary({ snap, onPaneClick }: {
  snap: HerdrDashboardSnapshot
  /** 点击代理行（跳转对应会话 pane）。 */
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
}) {
  void useHerdrLang()
  const summary = snap.summary
  const allAgents = collectDashboardAgents(snap.workspaces)
  const working = statusCount(summary.agents_by_status, 'working')
  const blocked = statusCount(summary.agents_by_status, 'blocked')
  return (
    <section className="herdr-dash-section" aria-label={t('dashboard.overview')}>
      <div className="herdr-dash-kpis">
        <KpiTile label={t('dashboard.workspaces')} value={summary.workspaces} />
        <KpiTile label={t('dashboard.panes')} value={summary.panes} />
        <KpiTile label={t('dashboard.agents')} value={summary.agents} />
        <KpiTile label={t('dashboard.working')} value={working} tone="working" />
        <KpiTile label={t('dashboard.blocked')} value={blocked} tone="blocked" />
      </div>
      <StatusChips counts={summary.agents_by_status} />
      <div className="herdr-dash-grid">
        <AgentsCard agents={allAgents} onPaneClick={onPaneClick} />
        <EnvCard snap={snap} />
      </div>
    </section>
  )
}
