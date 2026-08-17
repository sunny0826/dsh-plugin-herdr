// Dashboard 内容（design: dashboard-global v4 —— 可嵌入纯内容，无 herdr 模式门控、
// 无会话依赖）。v4 移除 HerdrServerBanner（状态/版本归 surface header）与独立进程
// 区块（进程并入 Herdr 服务卡片）。数据来自模块级 dashboardStore。

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatTime } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { useHerdrDashboard } from './store.ts'
import { DashboardSummary } from './dashboard-summary.tsx'
import { DashboardWorkspaces } from './dashboard-workspaces.tsx'
import type { HerdrDashboardAgent } from './dashboard-types.ts'

export function DashboardContent({ onPaneClick, onNotice }: {
  /** 点击 Treemap kind 块（该 kind 唯一 agent 时跳转对应会话 pane）。 */
  onPaneClick?: (agent: HerdrDashboardAgent) => void
  /** 无法定位/多 agent 提示（surface 级内联提示）。 */
  onNotice?: (message: string) => void
}) {
  void useHerdrLang()
  const { snap, error, refresh } = useHerdrDashboard()

  return (
    <div className="herdr-dash">
      {error ? <div className="herdr-server-error">{t('dashboard.fetchError')}: {error}</div> : null}
      {snap ? (
        <>
          <DashboardSummary snap={snap} />
          <div className="herdr-dash-fresh">
            {snap.stale ? <span className="herdr-dash-stale-badge">{t('dashboard.stale')}</span> : null}
            <span>
              {snap.updated_at > 0 ? t('dashboard.lastUpdated', { time: formatTime(snap.updated_at) }) : t('dashboard.noData')}
            </span>
            {snap.last_error ? (
              <span className="herdr-dash-last-error" title={snap.last_error}>
                {t('dashboard.lastError')}: {snap.last_error}
              </span>
            ) : null}
            <span className="herdr-dash-actions">
              <Button variant="outline" size="sm" onClick={refresh}>{t('dashboard.refresh')}</Button>
            </span>
          </div>
          <DashboardWorkspaces snap={snap} onPaneClick={onPaneClick} onNotice={onNotice} />
        </>
      ) : (
        <div className="herdr-empty">{error ? t('dashboard.noData') : t('dashboard.checking')}</div>
      )}
    </div>
  )
}
