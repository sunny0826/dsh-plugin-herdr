// Dashboard 内容（design: dashboard-redesign —— 可嵌入纯内容，无 herdr 模式门控、
// 无会话依赖）。v4 移除 HerdrServerBanner；本版移除独立新鲜度行（上移至 surface
// header）与 Treemap（workspace 卡片改用状态堆积条）。数据来自模块级 dashboardStore。
// v5：新增 pane 跳转（含跨会话）与关闭（workspace / pane）的可选交互 props。

import { t, useHerdrLang } from './i18n.ts'
import { useHerdrDashboard } from './store.ts'
import { DashboardSummary } from './dashboard-summary.tsx'
import { DashboardWorkspaces } from './dashboard-workspaces.tsx'
import type { HerdrDashboardPaneRef } from './dashboard-types.ts'

export interface DashboardContentProps {
  /** 点击代理行 / pane 行跳转（含跨会话切换）。 */
  onPaneClick?: (target: HerdrDashboardPaneRef) => void
  /** 本会话绑定 pane id（隐藏自 pane ✕）。 */
  selfPaneId?: string | null
  /** 乐观隐藏的 workspace id 集合（关闭成功后待轮询收敛）。 */
  hiddenWorkspaceIds?: ReadonlySet<string>
  /** 乐观隐藏的 pane id 集合。 */
  hiddenPaneIds?: ReadonlySet<string>
  /** 关闭 workspace（POST /herdr-close）。 */
  onCloseWorkspace?: (id: string) => void
  /** 关闭 pane（POST /herdr-close）。 */
  onClosePane?: (id: string) => void
}

export function DashboardContent(props: DashboardContentProps) {
  const {
    onPaneClick,
    selfPaneId,
    hiddenWorkspaceIds,
    hiddenPaneIds,
    onCloseWorkspace,
    onClosePane,
  } = props
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
          <DashboardWorkspaces
            snap={snap}
            selfPaneId={selfPaneId}
            hiddenWorkspaceIds={hiddenWorkspaceIds}
            hiddenPaneIds={hiddenPaneIds}
            onPaneClick={onPaneClick}
            onCloseWorkspace={onCloseWorkspace}
            onClosePane={onClosePane}
          />
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
