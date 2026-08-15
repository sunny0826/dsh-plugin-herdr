import type { Context } from '@deepseek-ai/cordis'
import type { HerdrAgentInfo, HerdrClient } from '../client/index.ts'
import type { SocketHerdrClient } from '../client/socket.ts'

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
  /** CLI 传输下轮询快照的间隔（仅兜底，默认 5s）。 */
  pollIntervalMs?: number
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
    for (const p of snap.panes as Array<{ pane_id?: string }>) {
      if (p.pane_id) subs.push({ type: 'pane.agent_status_changed', pane_id: p.pane_id })
    }
  } catch {
    // 快照失败：仅全局订阅
  }
  return subs
}

const RESOURCE_EVENTS: Record<string, { type: 'workspace' | 'tab' | 'pane'; action: 'created' | 'updated' | 'closed' }> = {
  'workspace.created': { type: 'workspace', action: 'created' },
  'workspace.updated': { type: 'workspace', action: 'updated' },
  'workspace.renamed': { type: 'workspace', action: 'updated' },
  'workspace.closed': { type: 'workspace', action: 'closed' },
  'tab.created': { type: 'tab', action: 'created' },
  'tab.updated': { type: 'tab', action: 'updated' },
  'tab.closed': { type: 'tab', action: 'closed' },
  'pane.created': { type: 'pane', action: 'created' },
  'pane.updated': { type: 'pane', action: 'updated' },
  'pane.closed': { type: 'pane', action: 'closed' },
  'pane.moved': { type: 'pane', action: 'updated' },
  'layout.updated': { type: 'pane', action: 'updated' },
}

/**
 * Herdr → DSH 事件转发（DESIGN.md §10.1）。
 * socket 传输：长连接订阅；CLI 传输：轮询 snapshot + diff（兜底）。
 * 返回清理函数（插件卸载或测试结束调用；插件内同时注册为 effect）。
 */
export function setupEventForwarding(ctx: Context, opts: EventForwardOptions): () => void {
  if (!opts.enabled) return () => {}
  const client = ctx.herdr

  if (isSocketClient(client)) {
    return setupSocketForwarding(ctx, client, opts)
  }
  return setupPollingForwarding(ctx, client, opts)
}

function isSocketClient(client: HerdrClient): client is SocketHerdrClient {
  return typeof (client as SocketHerdrClient).subscribe === 'function'
}

// ---------------------------------------------------------------------------
// socket 传输：长连接订阅
// ---------------------------------------------------------------------------

function setupSocketForwarding(ctx: Context, client: SocketHerdrClient, opts: EventForwardOptions): () => void {
  let subscribed = false
  let timer: NodeJS.Timeout | undefined

  const dispatch = (event: Record<string, unknown>) => {
    const type = event.type as string
    if (type === 'pane.agent_status_changed' || type === 'pane.agent_detected') {
      const info: { pane_id: string; agent: string; status: string; message?: string } = {
        pane_id: String(event.pane_id ?? ''),
        agent: String(event.agent ?? ''),
        status: String(event.agent_status ?? event.status ?? 'unknown'),
      }
      if (event.message != null) info.message = String(event.message)
      ctx.emit('herdr/agent-state', info)
      return
    }
    const mapped = RESOURCE_EVENTS[type]
    if (mapped) {
      const id = String(event.pane_id ?? event.tab_id ?? event.workspace_id ?? '')
      ctx.emit('herdr/resource-changed', { ...mapped, id })
      // 新 pane 出现：重建订阅以覆盖其 agent 状态事件（去抖防风暴）
      if (type === 'pane.created') scheduleResubscribe()
    }
  }

  let resubTimer: NodeJS.Timeout | undefined
  const scheduleResubscribe = () => {
    if (resubTimer) clearTimeout(resubTimer)
    resubTimer = setTimeout(() => {
      resubTimer = undefined
      if (subscribed) {
        subscribed = false
        void trySubscribe()
      }
    }, 300)
  }

  const trySubscribe = async () => {
    if (subscribed) return
    ctx.emit('herdr/channel', 'reconnecting')
    try {
      const subscriptions = await buildSubscriptions(client)
      await client.subscribe(subscriptions)
      subscribed = true
      ctx.emit('herdr/channel', 'connected')
    } catch {
      // 连接失败/断开：按退避重试
      ctx.emit('herdr/channel', 'disconnected')
      scheduleRetry()
    }
  }

  const scheduleRetry = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void trySubscribe()
    }, opts.maxReconnectMs)
  }

  const disposers: Array<() => void> = []
  disposers.push(ctx.effect(() => {
    void trySubscribe()
    return () => {
      if (timer) clearTimeout(timer)
      subscribed = false
    }
  }))

  // 连接断开后的健康检查：订阅成功后 socket 断开会丢失订阅，定期校验并重连
  client.onEvent(dispatch)
  disposers.push(ctx.effect(() => {
    const check = setInterval(() => {
      if (subscribed && !client.connected) {
        subscribed = false
        scheduleRetry()
      }
    }, Math.max(1000, opts.maxReconnectMs / 2))
    return () => clearInterval(check)
  }))

  return () => {
    if (resubTimer) clearTimeout(resubTimer)
    for (const d of disposers) d()
  }
}

// ---------------------------------------------------------------------------
// CLI 传输：轮询 snapshot + diff（兜底，不推荐）
// ---------------------------------------------------------------------------

function setupPollingForwarding(ctx: Context, client: HerdrClient, opts: EventForwardOptions): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? 5000
  let baseline: { agents: Map<string, { status: string; agent: string }>; resources: Set<string> } | null = null

  return ctx.effect(() => {
    ctx.emit('herdr/channel', 'connected')
    const timer = setInterval(async () => {
      try {
        const snap = await client.snapshot()
        const agents = new Map<string, { status: string; agent: string }>()
        for (const a of snap.agents as HerdrAgentInfo[]) {
          if (a.pane_id) agents.set(a.pane_id, { status: a.status ?? 'unknown', agent: a.agent ?? '' })
        }
        const resources = new Set<string>()
        for (const w of snap.workspaces as Array<{ workspace_id?: string }>) if (w.workspace_id) resources.add('w:' + w.workspace_id)
        for (const t of snap.tabs as Array<{ tab_id?: string }>) if (t.tab_id) resources.add('t:' + t.tab_id)
        for (const p of snap.panes as Array<{ pane_id?: string }>) if (p.pane_id) resources.add('p:' + p.pane_id)

        if (baseline) {
          for (const [paneId, info] of agents) {
            const prev = baseline.agents.get(paneId)
            if (!prev || prev.status !== info.status) {
              ctx.emit('herdr/agent-state', { pane_id: paneId, agent: info.agent, status: info.status })
            }
          }
          for (const r of resources) {
            if (!baseline.resources.has(r)) {
              const [kind, id] = r.split(':')
              ctx.emit('herdr/resource-changed', { type: kind as never, action: 'created', id })
            }
          }
          for (const r of baseline.resources) {
            if (!resources.has(r)) {
              const [kind, id] = r.split(':')
              ctx.emit('herdr/resource-changed', { type: kind as never, action: 'closed', id })
            }
          }
        }
        baseline = { agents, resources }
      } catch {
        // 快照失败忽略（下轮重试）
      }
    }, pollIntervalMs)
    return () => clearInterval(timer)
  })
}
