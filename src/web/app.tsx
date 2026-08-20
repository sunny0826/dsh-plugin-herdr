// 客户端插件入口：apply() + 各槽位注册 + sessions 服务注入。
// 本文件是 Web 面板装配层，不包含组件/数据/样式逻辑本身。

import { HerdrView, HerdrHeaderPill } from './herdr-view.tsx'
import { setSessionIdReader, setSessionOpener } from './navigation.ts'
import { HerdrPaneList } from './pane-list.tsx'
import { startModeTracking, type SessionListLike } from './mode.ts'
import { startSessionListBranding } from './session-list-branding.ts'
import { startTabController } from './tab-controller.ts'
import { startHeroBranding, setHerdrLang } from './hero-branding.ts'
import { SidebarButtonHost } from './global-dashboard.tsx'

// 宽松类型桥：slots / sessions / locale
interface SlotsApi {
  inject(name: string, register: () => unknown): unknown
  register(opts: Record<string, unknown>, Component: unknown): unknown
}

/** locale 服务的最小形状（LocaleFace 子集：getSnapshot + subscribe）。 */
interface LocaleFaceLike {
  getSnapshot(): { active?: string }
  subscribe(fn: () => void): () => void
}

export interface ClientCtx {
  slots: SlotsApi
  inject(name: string | string[], callback: (scope: unknown) => unknown): unknown
  effect(fn: () => unknown): unknown
}

/** sessions 服务的最小形状（list 读面 + open 会话切换写面）。 */
interface SessionsApiLike {
  list?: SessionListLike
  open?: (id: string) => void
}

export function apply(ctx: ClientCtx) {
  // 模式跟踪：当前会话 agentPreset === 'herdr' → herdr 模式（Tab/面板/胶囊门控的事实源）
  let stopModeTracking: (() => void) | null = null
  let stopSessionListBranding: (() => void) | null = null
  ctx.inject(['sessions'], (scope: unknown) => {
    const sessions = (scope as { sessions?: SessionsApiLike }).sessions
    setSessionIdReader(() => sessions?.list?.getSnapshot?.()?.current)
    if (sessions?.open) {
      setSessionOpener(id => sessions.open!(id))
    }
    if (sessions?.list) {
      stopModeTracking = startModeTracking(sessions.list)
      stopSessionListBranding = startSessionListBranding(sessions.list)
    }
  })
  // herdr Tab 打标：DOM 显隐门控 + logo 样式锚点（观察 tablist 渲染与 React 重渲染）
  const stopTabController = startTabController()
  // hero 标题打标：新会话页品牌化锚点（fish 座位 / 标题文本，design: herdr-hero-branding）
  const stopHeroBranding = startHeroBranding()
  // 界面语言跟踪：locale 服务 active → hero 文案（data-herdr-lang / aria-label）随语言切换
  let stopLangTracking: (() => void) | null = null
  ctx.inject(['locale'], (scope: unknown) => {
    const locale = (scope as { locale?: LocaleFaceLike }).locale
    if (!locale) return
    const apply = () => setHerdrLang(locale.getSnapshot().active ?? 'zh')
    apply()
    stopLangTracking = locale.subscribe(apply)
  })
  ctx.effect(() => () => {
    stopModeTracking?.()
    stopModeTracking = null
    stopSessionListBranding?.()
    stopSessionListBranding = null
    stopTabController()
    stopHeroBranding()
    stopLangTracking?.()
    stopLangTracking = null
  })

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'herdr',
        order: 20,
        label: () => 'Herdr',
      },
      HerdrView,
    ),
  )
  // 全局 Dashboard 入口（design: dashboard-global v3 —— 插件-only）：宿主组件注册到
  // 既有 shell.overlay，自身无可见 DOM（返回 null），副作用为 ① 把按钮 marker 注入
  // sidebar 文档流（New Session 与 regionArea 之间）；② open 时渲染右侧工作区 surface。
  // 宿主未声明（极端老版本）时 inject 不执行 → 无按钮，优雅降级。按钮不常驻发请求。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'herdr-dashboard',
        order: 10,
      },
      SidebarButtonHost,
    ),
  )
  // 会话页 header 状态胶囊
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'herdr-status',
        order: 30,
      },
      HerdrHeaderPill,
    ),
  )
  // 会话页右侧 pane 状态列表面板（可拖动吸附；折叠为 logo；任务开始自动展开）
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'herdr-pane-list',
        order: 40,
      },
      HerdrPaneList,
    ),
  )
}

export const inject = ['slots', 'locale']
