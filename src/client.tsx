// dsh-plugin-herdr 客户端插件（Web 面板）：Herdr 视图 + 会话页右侧 pane 状态列表。
//
// 本文件是 Web bundle 的薄入口（tsdown.web.config.ts entry: ['src/client.tsx']），
// 职责仅为触发样式注入副作用并 re-export 对外符号；全部实现已拆入 src/web/：
//   styles.ts       样式字符串 + 注入（STYLE_ID 不变）
//   types.ts        领域类型
//   store.ts        数据层（useHerdrStatus / useHerdrStart）
//   floating-drag.ts  useFloatingDrag 拖动吸附
//   navigation.ts    pendingFocusPane / focusPaneInHerdrTab / getSessionId
//   server-banner.tsx HerdrServerBanner
//   herdr-view.tsx   HerdrView / PaneRow / HerdrHeaderPill
//   pane-list.tsx    HerdrPaneList / HerdrLogo
//   app.tsx          apply() + 槽位注册 + sessions 注入

// 样式注入副作用：模块加载时执行一次（STYLE_ID 去重），与原 client.tsx 时序一致。
import './web/styles.ts'

export { apply, inject } from './web/app.tsx'
export { HerdrView } from './web/herdr-view.tsx'
export type {
  HerdrAgentStatus,
  HerdrServerInfo,
  HerdrWorkspaceView,
  HerdrTabView,
  HerdrPaneView,
  HerdrTopology,
  HerdrStatusSnapshot,
} from './web/types.ts'
export type {
  HerdrDashboardSnapshot,
  HerdrDashboardSummary,
  HerdrDashboardWorkspace,
  HerdrDashboardAgent,
  HerdrDashboardHost,
  HerdrDashboardProcess,
  HerdrDashboardConnection,
  HerdrDashboardServerInfo,
} from './web/dashboard-types.ts'
