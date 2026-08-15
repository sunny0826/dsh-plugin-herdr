/**
 * 跨 bundle 共享的会话绑定注册表。
 *
 * session-mode（preset 组合，lib/session-mode.mjs）与消费者插件
 * （lib/index.mjs）是两个独立构建入口，直接 import 会得到两份模块实例；
 * 通过 globalThis 上的 Symbol.for 共享同一 Map，客户端端点
 * /herdr-session-pane 即可查询"agentId → 绑定 pane"。
 */
const KEY = Symbol.for('dsh-plugin-herdr.bindings')

export interface HerdrSessionBinding {
  pane_id: string
  /** 是否由本插件自动创建（true 时会话结束会关闭 pane）。 */
  created: boolean
}

export function getBindingRegistry(): Map<string, HerdrSessionBinding> {
  const g = globalThis as Record<symbol, Map<string, HerdrSessionBinding> | undefined>
  return (g[KEY] ??= new Map())
}
