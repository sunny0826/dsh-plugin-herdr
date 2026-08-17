// Dashboard workspace 区（design: dashboard-global v4 需求 7 —— 外层 workspace 卡片
// + 内部 agent-kind 矩形树图）。workspace 卡片（含头部）**不承载返回会话行为**——
// 关闭 surface 由 header ✕ 按钮承担（用户定案：卡片空白区与头部点击都不返回）。
// Treemap kind 块可点击——该 kind 在该 workspace 恰好 1 个 agent 时经 onPaneClick
// 跳转到对应会话的 Herdr Tab pane；多个时经 onNotice 提示无法定位。
// 布局纯函数在 client-logic（layoutTreemap/agentKindCounts）。

import { useEffect, useRef, useState } from 'react'
import { agentKindCounts, layoutTreemap } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import type { HerdrDashboardAgent, HerdrDashboardSnapshot, HerdrDashboardWorkspace } from './dashboard-types.ts'

/** Treemap 区块高度（固定；宽度随容器 ResizeObserver 重算）。 */
const TREEMAP_HEIGHT = 110

/** kind → 图例标签（未知回退 unknown）。 */
function kindLabel(kind: string): string {
  return kind === 'unknown' ? t('dashboard.unknown') : kind
}

/** 单个 workspace 的内部 Treemap（kind 计数 → 矩形布局；kind 块可点击跳转）。 */
function WorkspaceTreemap({ ws, onPaneClick, onNotice }: {
  ws: HerdrDashboardWorkspace
  /** 点击 kind 块（该 kind 唯一 agent 时携带 agent）。 */
  onPaneClick?: (agent: HerdrDashboardAgent) => void
  /** 多 agent kind 块 / 无法定位时的提示。 */
  onNotice?: (message: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // 响应式：容器宽度变化重算布局（P2-2；固定高度）
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
  // kind 块点击：唯一 agent → 跳转；多个 → 提示无法定位
  const activateKind = (kind: string) => {
    const agentsOfKind = (ws.agents ?? []).filter(a => a.kind === kind)
    if (agentsOfKind.length === 1) {
      onPaneClick?.(agentsOfKind[0])
    } else if (agentsOfKind.length > 1) {
      onNotice?.(t('dashboard.paneMultiple', { count: agentsOfKind.length }))
    }
  }
  return (
    <div ref={containerRef} className="herdr-tm" style={{ height: TREEMAP_HEIGHT }}>
      {rects.map(r => (
        <div
          key={r.key}
          className="herdr-tm-block"
          data-kind={r.key}
          role="button"
          tabIndex={0}
          aria-label={`${kindLabel(r.key)} · ${r.value} (${Math.round(r.ratio * 100)}%)`}
          style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
          title={`${kindLabel(r.key)} · ${r.value} (${Math.round(r.ratio * 100)}%)`}
          onClick={e => {
            e.stopPropagation() // 块内点击不触发 workspace 卡片关闭
            activateKind(r.key)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              activateKind(r.key)
            }
          }}
        >
          {/* 小块内只放 kind 缩写/计数（宽度足够时）；aria-label 始终有完整信息 */}
          <span className="herdr-tm-label" aria-hidden>{r.key}</span>
        </div>
      ))}
    </div>
  )
}

export function DashboardWorkspaces({ snap, onPaneClick, onNotice }: {
  snap: HerdrDashboardSnapshot
  /** 点击 Treemap kind 块（该 kind 唯一 agent 时跳转）。 */
  onPaneClick?: (agent: HerdrDashboardAgent) => void
  /** 无法定位/多 agent 提示。 */
  onNotice?: (message: string) => void
}) {
  void useHerdrLang()
  if (snap.workspaces.length === 0) {
    return <div className="herdr-empty">{t('dashboard.empty')}</div>
  }
  return (
    <section className="herdr-dash-section">
      <div className="herdr-dash-section-head">
        <span>{t('dashboard.workspaces')}</span>
        <span className="herdr-dash-section-count">
          {snap.summary.workspaces} {t('dashboard.workspaces')} · {snap.summary.panes} {t('dashboard.panes')} · {snap.summary.tabs} {t('dashboard.tabs')}
        </span>
      </div>
      <div>
        {snap.workspaces.map(ws => (
          <div key={ws.workspace_id} className="herdr-dash-ws herdr-dash-ws-card">
            <div className="herdr-dash-ws-head">
              <span className="herdr-dash-ws-label">{ws.label ?? ws.workspace_id}</span>
              <span className="herdr-dash-ws-id">{ws.workspace_id}</span>
              <span className="herdr-dash-ws-meta">
                {ws.agent_count} {t('dashboard.agents')} · {ws.pane_count} {t('dashboard.panes')}
              </span>
            </div>
            <WorkspaceTreemap ws={ws} onPaneClick={onPaneClick} onNotice={onNotice} />
            {ws.agents_working > 0 || ws.agents_blocked > 0 ? (
              <div className="herdr-dash-ws-chips">
                {ws.agents_working > 0 ? (
                  <span className="herdr-dash-chip" data-state="working"><b>{ws.agents_working}</b> {t('dashboard.working')}</span>
                ) : null}
                {ws.agents_blocked > 0 ? (
                  <span className="herdr-dash-chip" data-state="blocked"><b>{ws.agents_blocked}</b> {t('dashboard.blocked')}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
