// Dashboard 摘要卡片（design: dashboard-global v4 —— Herdr 服务卡片合并进程；
// Agents 卡片显示所有 agent 名称；长列表滚动 + 显示全部/收起）。

import { useState, type ReactNode } from 'react'
import {
  collectDashboardAgents,
  formatBytes,
  formatDuration,
  formatTime,
  sortedStatusCounts,
} from '../client-logic.ts'
import { t, useHerdrLang, type I18nKey } from './i18n.ts'
import type { HerdrDashboardSnapshot, HerdrDashboardAgent } from './dashboard-types.ts'

/** agent 状态 → 面板标签 key（未知状态回退 unknown）。 */
const STATUS_LABEL_KEYS: Record<string, I18nKey> = {
  working: 'dashboard.working',
  idle: 'dashboard.idle',
  blocked: 'dashboard.blocked',
  done: 'dashboard.done',
  unknown: 'dashboard.unknown',
}

/** 状态分布 chips（稳定顺序：working/blocked/idle/done/unknown）。 */
export function StatusChips({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="herdr-dash-ws-chips">
      {sortedStatusCounts(counts).map(([status, n]) => (
        <span key={status} className="herdr-dash-chip" data-state={status}>
          <b>{n}</b> {t(STATUS_LABEL_KEYS[status] ?? 'dashboard.unknown')}
        </span>
      ))}
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

/** agent 显示名：name → kind → 「未命名 agent」。 */
function agentDisplayName(a: HerdrDashboardAgent): string {
  if (a.name && a.name.trim() !== '') return a.name
  if (a.kind && a.kind !== 'unknown') return a.kind
  return t('dashboard.agentUnnamed')
}

/** Agents 卡片：总数/状态摘要 + 全名称列表（默认前 8 项，显示全部展开）。 */
function AgentsCard({ agents }: { agents: HerdrDashboardAgent[] }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? agents : agents.slice(0, 8)
  return (
    <DashboardCard title={t('dashboard.agents')}>
      <StatusChips counts={agents.reduce<Record<string, number>>((m, a) => {
        m[a.status] = (m[a.status] ?? 0) + 1
        return m
      }, {})} />
      <DashboardRow label={t('dashboard.agentsTotal')} value={String(agents.length)} />
      {agents.length > 0 ? (
        <ul className="herdr-dash-agent-list" data-collapsed={!showAll || undefined}>
          {visible.map(a => (
            <li key={a.pane_id} className="herdr-dash-agent-row">
              <span className="herdr-dash-agent-dot" data-kind={a.kind} aria-hidden />
              <span className="herdr-dash-agent-name" title={agentDisplayName(a)}>{agentDisplayName(a)}</span>
              <span className="herdr-dash-agent-kind">{a.kind}</span>
              <span className="herdr-dash-agent-status" data-state={a.status}>{t(STATUS_LABEL_KEYS[a.status] ?? 'dashboard.unknown')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="herdr-dash-row"><span className="herdr-dash-row-value">{t('dashboard.noData')}</span></div>
      )}
      {agents.length > 8 ? (
        <button type="button" className="herdr-dash-link-btn" onClick={() => setShowAll(v => !v)}>
          {showAll ? t('dashboard.collapseAgents') : t('dashboard.showAllAgents')}
        </button>
      ) : null}
    </DashboardCard>
  )
}

/** Herdr 服务卡片：版本/协议合并一行 + 核心进程指标（PID/CPU/内存/运行时长）；采样时间并入 footer。 */
function ServerCard({ snap }: { snap: HerdrDashboardSnapshot }) {
  const p = snap.process
  const version = snap.server.version ? `v${snap.server.version}` : '—'
  const protocol = snap.server.protocol != null ? String(snap.server.protocol) : '—'
  return (
    <DashboardCard title={t('dashboard.server')}>
      <DashboardRow label={t('dashboard.versionProtocol')} value={`${version} · ${protocol}`} mono />
      {p.available ? (
        <>
          <DashboardRow label={t('dashboard.pid')} value={p.pid != null ? String(p.pid) : t('dashboard.unavailable')} mono />
          <DashboardRow label={t('dashboard.cpu')} value={p.cpu_percent != null ? `${p.cpu_percent.toFixed(1)} %` : t('dashboard.unavailable')} />
          <DashboardRow label={t('dashboard.memory')} value={p.rss_bytes != null ? (formatBytes(p.rss_bytes) ?? t('dashboard.unavailable')) : t('dashboard.unavailable')} />
          <DashboardRow label={t('dashboard.uptime')} value={p.started_at != null ? (formatDuration(Math.max(0, p.sampled_at - p.started_at)) ?? '—') : '—'} mono />
        </>
      ) : (
        <div className="herdr-dash-process-unavail">
          <span className="herdr-dash-stale-badge">{t('dashboard.unavailable')}</span>
          <span>{t('dashboard.reason')}: {p.error ?? '—'}</span>
        </div>
      )}
      <div className="herdr-dash-process-note">
        {t('dashboard.bestEffort')}
        {p.sampled_at > 0 ? ` · ${t('dashboard.sampledHint', { time: formatTime(p.sampled_at) })}` : ''}
      </div>
    </DashboardCard>
  )
}

export function DashboardSummary({ snap }: { snap: HerdrDashboardSnapshot }) {
  void useHerdrLang()
  const s = snap.summary
  return (
    <section className="herdr-dash-section" aria-label={t('dashboard.overview')}>
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
        <AgentsCard agents={collectDashboardAgents(snap.workspaces)} />
      </div>
    </section>
  )
}
