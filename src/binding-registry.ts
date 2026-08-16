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
  /** 是否由本插件自动创建（true 时会话结束会关闭 pane/workspace）。 */
  created: boolean
  /** 会话专属 workspace（created=true 且创建成功时存在）。 */
  workspace_id?: string
}

export function getBindingRegistry(): Map<string, HerdrSessionBinding> {
  const g = globalThis as Record<symbol, Map<string, HerdrSessionBinding> | undefined>
  return (g[KEY] ??= new Map())
}

/**
 * 只读遍历全部已绑定 pane_id（去重，无绑定返回空数组）。
 * 供 status.ts 的 self pane 豁免使用：无需知道"当前会话 agent id"，
 * 只要某个 workspace 包含任一已绑定会话的 pane 就无条件保留。
 * 纯遍历不改动 registry，不影响既有单测。
 */
export function getBoundPaneIds(): string[] {
  return [...new Set([...getBindingRegistry().values()].map(b => b.pane_id))]
}

/**
 * 命名规范（design: herdr-mode-gating MG-55）：
 * - 显示名（workspace/pane label）："dsh:<项目名>"（会话 cwd 的 basename；
 *   无 cwd 时回退 "dsh:<session id 后 8 位>"），多个会话共享同一项目名，
 *   herdr UI 可读、可区分项目；
 * - 内部标记（绑定 pane 的 tokens.dsh_session = sessionId）：显示名与内部标记
 *   分离——label 只承载显示名，复用/兜底查询走 tokens（ttl_ms=null 永久有效），
 *   不再把 session id 暴露在显示名里。
 */

/** session id 的短标识（去掉 "session-" 前缀后取 8 位；异常时取原串尾部）。 */
export function sessionShortId(sessionId: string): string {
  const body = sessionId.replace(/^session-/, '')
  return body.length > 8 ? body.slice(-8) : body
}

/** 项目名 = 会话 cwd 的 basename（无 cwd/无法解析时 undefined）。 */
export function projectName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.replace(/[\/]+$/, '').split(/[\/]/)
  const base = parts[parts.length - 1]
  return base && base !== '' && base !== '.' ? base : undefined
}

/** 显示名（workspace/pane label 共用）："dsh:<项目名>"，无项目名回退 "dsh:<短id>"。 */
export function displayLabel(cwd: string | undefined, sessionId: string): string {
  const name = projectName(cwd)
  return 'dsh:' + (name ?? sessionShortId(sessionId))
}

/** 内部标记 key（tokens 键，符合协议 ^[A-Za-z0-9_-]{1,32}$）。 */
export const SESSION_TOKEN_KEY = 'dsh_session'

/** 绑定 pane 的内部标记 tokens（pane.report_metadata 写入；ttl_ms=null 永久）。 */
export function sessionToken(agentId: string): { [key: string]: string } {
  return { [SESSION_TOKEN_KEY]: agentId }
}

/** 从 pane tokens 提取会话 id（无标记返回 undefined）。 */
export function sessionIdFromTokens(tokens: { [key: string]: string | null } | undefined): string | undefined {
  return tokens?.[SESSION_TOKEN_KEY] ?? undefined
}