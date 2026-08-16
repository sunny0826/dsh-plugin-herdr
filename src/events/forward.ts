import type { Context } from '@deepseek-ai/cordis'
import type { HerdrClient } from '../client/index.ts'
import type { SocketHerdrClient } from '../client/socket.ts'
import type { HerdrEvent, HerdrSubscriptionEvent } from '../client/types.js'
import { createLogger, createRateLimiter, errText } from '../log.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Herdr 中某 pane 的 agent 状态变化。 */
    'herdr/agent-state'(info: { pane_id: string; agent: string; status: string; message?: string }): void
    /** Herdr 资源集变化（workspace/tab/pane 增删改）。 */
    'herdr/resource-changed'(change: { type: 'workspace' | 'tab' | 'pane'; action: 'created' | 'updated' | 'closed'; id: string }): void
    /** 事件订阅通道健康状态。 */
    'herdr/channel'(state: 'connected' | 'disconnected' | 'reconnecting'): void
  }
}

export interface EventForwardOptions {
  enabled: boolean
  maxReconnectMs: number
}

/**
 * CA-008：重连指数退避（有 cap + jitter），纯函数便于测试。
 * 首次 ~cap/8，之后每次翻倍，封顶 cap；0.5x–1x jitter 防惊群。
 */
export function computeBackoffDelayMs(attempt: number, capMs: number, rand: () => number = Math.random): number {
  const base = Math.max(200, Math.floor(capMs / 8))
  const exp = Math.min(capMs, base * 2 ** Math.max(0, attempt))
  return Math.floor(exp * (0.5 + rand() * 0.5))
}

/** 全局订阅事件（只需 type；pane.agent_status_changed 需要 pane_id，动态构建）。 */
// 仅使用 schema 中确认存在的订阅变体（tab.updated 不存在，见 env-findings）
const GLOBAL_SUBSCRIPTIONS = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed',
  'tab.created', 'tab.focused', 'tab.renamed', 'tab.closed',
  'pane.created', 'pane.updated', 'pane.closed', 'pane.moved', 'pane.agent_detected',
  'layout.updated',
]

/** 动态订阅列表：全局事件 + 当前所有 pane 的 agent 状态订阅（agent_status_changed 需 pane_id）。 */
async function buildSubscriptions(client: HerdrClient): Promise<Array<{ type: string; pane_id?: string }>> {
  const subs: Array<{ type: string; pane_id?: string }> = GLOBAL_SUBSCRIPTIONS.map(type => ({ type }))
  try {
    const snap = await client.snapshot()
    for (const p of snap.panes) {
      if (p.pane_id) subs.push({ type: 'pane.agent_status_changed', pane_id: p.pane_id })
    }
  } catch {
    // 快照失败：仅全局订阅
  }
  return subs
}

const RESOURCE_EVENTS_BY_TYPE: Record<string, { type: 'workspace' | 'tab' | 'pane'; action: 'created' | 'updated' | 'closed' }> = {
  // 键为订阅事件的 data.type（下划线，live herdr 0.8.0 实测；CA-008）
  'workspace_created': { type: 'workspace', action: 'created' },
  'workspace_updated': { type: 'workspace', action: 'updated' },
  'workspace_metadata_updated': { type: 'workspace', action: 'updated' },
  'workspace_renamed': { type: 'workspace', action: 'updated' },
  'workspace_closed': { type: 'workspace', action: 'closed' },
  'workspace_focused': { type: 'workspace', action: 'updated' },
  'tab_created': { type: 'tab', action: 'created' },
  'tab_closed': { type: 'tab', action: 'closed' },
  'tab_renamed': { type: 'tab', action: 'updated' },
  'tab_moved': { type: 'tab', action: 'updated' },
  'tab_focused': { type: 'tab', action: 'updated' },
  'pane_created': { type: 'pane', action: 'created' },
  'pane_closed': { type: 'pane', action: 'closed' },
  'pane_updated': { type: 'pane', action: 'updated' },
  'pane_focused': { type: 'pane', action: 'updated' },
  'pane_moved': { type: 'pane', action: 'updated' },
  'pane_exited': { type: 'pane', action: 'updated' },
  'pane_output_changed': { type: 'pane', action: 'updated' },
  'layout_updated': { type: 'pane', action: 'updated' },
}

/** 从订阅事件 data 提取资源 id（pane_id / tab_id / workspace_id，含嵌套对象兜底）。 */
function eventResourceId(data: Record<string, unknown>): string {
  const d = data as {
    pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown
    pane?: { pane_id?: unknown }; tab?: { tab_id?: unknown }; workspace?: { workspace_id?: unknown }
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return (
    s(d.pane_id) || s(d.pane?.pane_id) ||
    s(d.tab_id) || s(d.tab?.tab_id) ||
    s(d.workspace_id) || s(d.workspace?.workspace_id) ||
    ''
  )
}

/**
 * Herdr → DSH 事件转发（DESIGN.md §10.1）。
 * 全量迁移后唯一路径：socket 长连接订阅（CLI 轮询兜底已随 CLI 传输移除）。
 * 返回清理函数（插件卸载或测试结束调用；插件内同时注册为 effect）。
 */
export function setupEventForwarding(ctx: Context, opts: EventForwardOptions): () => void {
  if (!opts.enabled) return () => {}
  return setupSocketForwarding(ctx, ctx.herdr as SocketHerdrClient, opts)
}

// ---------------------------------------------------------------------------
// socket 传输：长连接订阅
// ---------------------------------------------------------------------------

function setupSocketForwarding(ctx: Context, client: SocketHerdrClient, opts: EventForwardOptions): () => void {
  const logger = createLogger(ctx, 'forward')
  // CA-017：高频重试/断连日志限流（5s/key）
  const rateLimited = createRateLimiter(5000)
  let subscribed = false
  let timer: NodeJS.Timeout | undefined
  let attempt = 0
  let disposed = false
  // CA-011：已订阅 agent 状态的 pane 集合——防止 pane.created 重放触发重订阅风暴
  // （herdr 订阅会重放会话历史，若对历史 pane 也重订阅则无限循环）。
  let subscribedPaneIds = new Set<string>()
  // CA-011：已为重订阅尝试过的 pane 集合——即使该 pane 始终不在快照中（如已关闭），
  // 每个 pane 也至多重订阅一次，保证重放循环必然收敛。
  let resubscribedPanes = new Set<string>()

  // CA-008：订阅事件按实测 envelope { event, data } 解析（live herdr 0.8.0 / protocol 19）。
  // data 为判别联合（data.type，HerdrEventData）；专精订阅事件（output_matched 等）
  // 无 data.type，以 envelope.event（HerdrSubscriptionEvent）判别。
  const dispatch = (raw: unknown) => {
    const env = raw as (HerdrEvent | HerdrSubscriptionEvent) & { data?: { type?: string } }
    const data = (env.data ?? {}) as Record<string, unknown>
    const type = typeof data.type === 'string' ? data.type : (env.event as string)
    if (type === 'pane.agent_status_changed' || type === 'pane.agent_detected') {
      const info: { pane_id: string; agent: string; status: string; message?: string } = {
        pane_id: String(data.pane_id ?? ''),
        agent: String(data.agent ?? ''),
        status: String(data.agent_status ?? data.final_status ?? 'unknown'),
      }
      if (data.message != null) info.message = String(data.message)
      ctx.emit('herdr/agent-state', info)
      return
    }
    const mapped = RESOURCE_EVENTS_BY_TYPE[type]
    if (mapped) {
      ctx.emit('herdr/resource-changed', { ...mapped, id: eventResourceId(data) })
      // 仅对真正新增（不在订阅集合中）且未尝试过的 pane 重建订阅，覆盖其 agent 状态事件
      if (type === 'pane_created') {
        const id = eventResourceId(data)
        if (id && !subscribedPaneIds.has(id) && !resubscribedPanes.has(id)) {
          resubscribedPanes.add(id)
          scheduleResubscribe()
        }
      }
    }
  }

  let resubTimer: NodeJS.Timeout | undefined
  const scheduleResubscribe = () => {
    if (resubTimer) clearTimeout(resubTimer)
    resubTimer = setTimeout(() => {
      resubTimer = undefined
      if (subscribed && !disposed) {
        subscribed = false
        void trySubscribe()
      }
    }, 300)
  }

  const trySubscribe = async () => {
    if (subscribed || disposed) return
    ctx.emit('herdr/channel', 'reconnecting')
    try {
      const subscriptions = await buildSubscriptions(client)
      await client.subscribe(subscriptions)
      subscribed = true
      // CA-011：记录本次订阅覆盖的 pane，用于判断 pane_created 是否真正新增
      subscribedPaneIds = new Set(
        subscriptions.filter(s => s.type === 'pane.agent_status_changed').map(s => s.pane_id ?? ''),
      )
      attempt = 0 // CA-008：成功后重置退避
      ctx.emit('herdr/channel', 'connected')
      logger.debug('event subscription connected (pane subscriptions: %d)', subscribedPaneIds.size)
    } catch (err) {
      // 连接失败/断开：按指数退避重试（cap + jitter）
      if (disposed) return
      ctx.emit('herdr/channel', 'disconnected')
      // CA-017：重连失败限流告警（带上下文：退避次数）
      rateLimited('subscribe', () => logger.warn('event subscription failed (attempt %d): %s', attempt, errText(err)))
      scheduleRetry()
    }
  }

  const scheduleRetry = () => {
    if (timer) clearTimeout(timer)
    const delay = computeBackoffDelayMs(attempt, opts.maxReconnectMs)
    attempt++
    timer = setTimeout(() => {
      timer = undefined
      void trySubscribe()
    }, delay)
  }

  const disposers: Array<() => void> = []
  disposers.push(client.onEvent(dispatch))
  disposers.push(ctx.effect(() => {
    void trySubscribe()
    return () => {
      if (timer) clearTimeout(timer)
      subscribed = false
    }
  }))

  // 连接断开后的健康检查：订阅成功后 socket 断开会丢失订阅，定期校验并重连
  disposers.push(ctx.effect(() => {
    const check = setInterval(() => {
      if (subscribed && !client.connected) {
        subscribed = false
        scheduleRetry()
      }
    }, Math.max(1000, opts.maxReconnectMs / 2))
    return () => clearInterval(check)
  }))

  // CA-008：cleanup 后无 timer/socket —— 停止重试与健康检查、关闭订阅连接（幂等）
  return () => {
    if (disposed) return
    disposed = true
    if (resubTimer) clearTimeout(resubTimer)
    if (timer) clearTimeout(timer)
    for (const d of disposers) d()
    subscribedPaneIds = new Set()
    resubscribedPanes = new Set()
    client.close()
  }
}


