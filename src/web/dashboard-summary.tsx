// Dashboard 摘要卡片（design: dashboard-global v4 —— Herdr 服务卡片合并进程；
// 代理 卡片显示所有代理 名称；长列表滚动 + 显示全部/收起）。

import { useState, type ReactNode } from 'react'
import {
  collectDashboardAgents,
  formatBytes,
  formatDuration,
  formatTime,
  normalizeDashboardKind,
  paneDisplayState,
  sortedStatusCounts,
} from '../client-logic.ts'
import { t, useHerdrLang, type I18nKey } from './i18n.ts'
import type { PaneDisplayState } from '../client-logic.ts'
import type { HerdrDashboardSnapshot, HerdrDashboardAgent } from './dashboard-types.ts'

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

/** 代理 卡片：总数/状态摘要 + 全名称列表（默认前 8 项，显示全部展开）。 */
function AgentsCard({ agents }: { agents: HerdrDashboardAgent[] }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? agents : agents.slice(0, 8)
  return (
    <DashboardCard title={t('dashboard.agents')}>
      <StatusChips counts={agents.reduce<Record<string, number>>((counts, agent) => {
        counts[agent.status] = (counts[agent.status] ?? 0) + 1
        return counts
      }, {})} />
      <DashboardRow label={t('dashboard.agentsTotal')} value={String(agents.length)} />
      {agents.length > 0 ? (
        <ul className="herdr-dash-agent-list" data-collapsed={!showAll || undefined}>
          {visible.map(agent => {
            const kind = normalizeDashboardKind(agent.kind)
            return (
              <li key={agent.pane_id} className="herdr-dash-agent-row">
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

/** Herdr 服务卡片：版本/协议合并一行 + 核心进程指标（PID/CPU/内存/运行时长）；采样时间并入 footer。 */
function ServerCard({ snap }: { snap: HerdrDashboardSnapshot }) {
  const process = snap.process
  const version = snap.server.version ? `v${snap.server.version}` : '—'
  const protocol = snap.server.protocol != null ? String(snap.server.protocol) : '—'
  return (
    <DashboardCard title={t('dashboard.server')}>
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
    </DashboardCard>
  )
}

export function DashboardSummary({ snap }: { snap: HerdrDashboardSnapshot }) {
  void useHerdrLang()
  const summary = snap.summary
  const allAgents = collectDashboardAgents(snap.workspaces)
  return (
    <section className="herdr-dash-section" aria-label={t('dashboard.overview')}>
      <div className="herdr-dash-grid">
        <DashboardCard title={t('dashboard.overview')}>
          <DashboardRow label={t('dashboard.workspaces')} value={String(summary.workspaces)} />
          <DashboardRow label={t('dashboard.tabs')} value={String(summary.tabs)} />
          <DashboardRow label={t('dashboard.panes')} value={String(summary.panes)} />
          <DashboardRow label={t('dashboard.agents')} value={String(summary.agents)} />
          <StatusChips counts={summary.agents_by_status} />
        </DashboardCard>
        <AgentsCard agents={allAgents} />
      </div>
      <div className="herdr-dash-grid">
        <ServerCard snap={snap} />
        <DashboardCard title={t('dashboard.socket')}>
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
        </DashboardCard>
        <DashboardCard title={t('dashboard.host')}>
          <DashboardRow label={t('dashboard.hostname')} value={snap.host.hostname} mono />
          <DashboardRow label={t('dashboard.os')} value={`${snap.host.os_type} ${snap.host.os_release}`} />
          <DashboardRow label={t('dashboard.platform')} value={snap.host.platform} mono />
          <DashboardRow label={t('dashboard.arch')} value={snap.host.arch} mono />
        </DashboardCard>
      </div>
    </section>
  )
}
