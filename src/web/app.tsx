// 客户端插件入口：apply() + 各槽位注册 + sessions 服务注入。
// 本文件是 Web 面板装配层，不包含组件/数据/样式逻辑本身。

import { HerdrView, HerdrHeaderPill } from './herdr-view.tsx'
import { setSessionIdReader } from './navigation.ts'
import { HerdrPaneList, HerdrHeroStatus } from './pane-list.tsx'
import { startModeTracking, type SessionListLike } from './mode.ts'
import { startTabController } from './tab-controller.ts'
import { startHeroBranding } from './hero-branding.ts'

// 宽松类型桥：slots / sessions
interface SlotsApi {
  inject(name: string, register: () => unknown): unknown
  register(opts: Record<string, unknown>, Component: unknown): unknown
}

export interface ClientCtx {
  slots: SlotsApi
  inject(name: string | string[], callback: (scope: unknown) => unknown): unknown
  effect(fn: () => unknown): unknown
}

export function apply(ctx: ClientCtx) {
  // 模式跟踪：当前会话 agentPreset === 'herdr' → herdr 模式（Tab/面板/胶囊门控的事实源）
  let stopModeTracking: (() => void) | null = null
  ctx.inject(['sessions'], (scope: unknown) => {
    const sessions = (scope as { sessions?: { list?: SessionListLike } }).sessions
    setSessionIdReader(() => sessions?.list?.getSnapshot?.()?.current)
    if (sessions?.list) {
      stopModeTracking = startModeTracking(sessions.list)
    }
  })
  // herdr Tab 打标：DOM 显隐门控 + logo 样式锚点（观察 tablist 渲染与 React 重渲染）
  const stopTabController = startTabController()
  // hero 标题打标：新会话页品牌化锚点（fish 座位 / 标题文本，design: herdr-hero-branding）
  const stopHeroBranding = startHeroBranding()
  ctx.effect(() => () => {
    stopModeTracking?.()
    stopModeTracking = null
    stopTabController()
    stopHeroBranding()
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
  // 新建会话（hero）看板浮层
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'herdr-server',
        order: 30,
      },
      HerdrHeroStatus,
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

export const inject = ['slots']
