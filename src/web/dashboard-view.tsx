// Dashboard 内容（design: dashboard-redesign —— 可嵌入纯内容，无 herdr 模式门控、
// 无会话依赖）。v4 移除 HerdrServerBanner；本版移除独立新鲜度行（上移至 surface
// header）与 Treemap（workspace 卡片改用状态堆积条）。数据来自模块级 dashboardStore。

import { t, useHerdrLang } from './i18n.ts'
import { useHerdrDashboard } from './store.ts'
import { DashboardSummary } from './dashboard-summary.tsx'
import { DashboardWorkspaces } from './dashboard-workspaces.tsx'
import type { HerdrDashboardAgent } from './dashboard-types.ts'

export function DashboardContent({ onPaneClick }: {
  /** 点击代理行（该代理唯一归属时跳转对应会话 pane）。 */
  onPaneClick?: (agent: HerdrDashboardAgent) => void
}) {
  void useHerdrLang()
  const { snap, error } = useHerdrDashboard()

  return (
    <div className="herdr-dash">
      {error ? <div className="herdr-server-error">{t('dashboard.fetchError')}: {error}</div> : null}
      {snap ? (
        <>
          {snap.last_error ? (
            <div className="herdr-dash-last-error" title={snap.last_error}>
              {t('dashboard.lastError')}: {snap.last_error}
            </div>
          ) : null}
          <DashboardSummary snap={snap} onPaneClick={onPaneClick} />
          <DashboardWorkspaces snap={snap} />
        </>
      ) : error ? (
        <div className="herdr-empty">{t('dashboard.noData')}</div>
      ) : (
        <div className="herdr-dash-loading" role="status" aria-label={t('dashboard.checking')}>
          <div className="herdr-dash-skeleton" />
          <div className="herdr-dash-skeleton" />
          <div className="herdr-dash-skeleton" />
          <span className="herdr-visually-hidden">{t('dashboard.checking')}</span>
        </div>
      )}
    </div>
  )
}
