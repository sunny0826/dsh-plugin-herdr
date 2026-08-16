// 客户端插件入口：apply() + 各槽位注册 + sessions 服务注入。
// 本文件是 Web 面板装配层，不包含组件/数据/样式逻辑本身。

import { HerdrView, HerdrHeaderPill } from './herdr-view.tsx'
import { setSessionIdReader } from './navigation.ts'
import { HerdrPaneList, HerdrHeroStatus } from './pane-list.tsx'

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
  // sessions 服务就绪后注入当前会话 id 读取器
  ctx.inject(['sessions'], (scope: unknown) => {
    const sessions = (scope as { sessions?: { list?: { getSnapshot?: () => { current?: string } } } }).sessions
    setSessionIdReader(() => sessions?.list?.getSnapshot?.()?.current)
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
