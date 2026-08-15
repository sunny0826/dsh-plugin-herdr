import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PaneReportState } from './client/index.ts'
import { getBindingRegistry } from './binding-registry.ts'
import { createLogger, createRateLimiter, errText } from './log.ts'
// 加载 dsh-agent 对 Cordis Events 的声明合并（agent/created、agent/disposed、
// agent/request、agent/turn-stopping 带 agent 载体与 payload.agent）
import type {} from '@deepseek-ai/dsh-agent'

export interface Config {
  /** 固定绑定的 Herdr pane（所有会话共用）；留空则每会话自动创建专属 pane。 */
  paneId?: string
  /** 上报来源标识（Herdr 侧边栏按 source 区分）。 */
  source: string
  /** 自动创建 pane 的 workspace label（新建 workspace 场景）。 */
  label: string
  /** 自动创建 pane 时新 pane 的 shell 工作目录（可选）。 */
  cwd?: string
}

export const Config: Schema<Config> = Schema.object({
  paneId: Schema.string(),
  source: Schema.string().default('dsh:herdr-session'),
  label: Schema.string().default('dsh'),
  cwd: Schema.string(),
})

export const name = 'dsh-plugin-herdr-session-mode'
export const inject = ['herdr']

/**
 * herdr 模式（agent preset）的会话绑定插件。
 *
 * agent preset 是 standing mount：组合内插件在进程内只有一份实例，服务于所有
 * 加入 herdr preset 的 agent（会话）——因此必须按 agent 区分状态：
 * - dsh-agent 的事件（agent/created、agent/request、agent/turn-stopping、
 *   agent/disposed）经 scope 载体投递，payload 恒带 `agent`（id === session id）；
 * - 本插件以 `Map<agentId, 绑定>` 维护每个会话的 pane。
 *
 * 绑定策略（config.paneId 固定绑定优先）：
 * 1. 焦点 pane 存在 → `pane.split`（direction right）创建专属 pane；
 * 2. 无焦点 pane → `workspace.create`（root pane 即专属 pane）；
 * 3. 均失败 → 记录日志，会话仍可运行（无侧边栏展示）。
 *
 * 状态上报：会话创建 → idle；模型请求 → working；回合结束 → idle；
 * agent 销毁 → `pane.release-agent` 释放 authority。
 */
export function apply(ctx: Context, config: Config) {
  const source = config.source
  const agentName = 'dsh'
  const registry = getBindingRegistry()
  const logger = createLogger(ctx, 'session-mode')
  // CA-017：会话级错误限流（10s/key）
  const rateLimited = createRateLimiter(10_000)

  interface Binding {
    paneId: string
    created: boolean
  }
  // agent id（= session id）→ 绑定 pane
  const bindings = new Map<string, Binding>()
  // CA-013：在途 bind 与已 dispose 的 agent（bind/dispose 竞态防护）
  const pending = new Set<string>()
  const disposedAgents = new Set<string>()
  // CA-013：在途清理（可观测；测试与 HMR 卸载可等待）
  const pendingCleanups = new Set<Promise<void>>()

  const report = (agentId: string, state: PaneReportState, message?: string) => {
    const binding = bindings.get(agentId)
    if (!binding) return
    void ctx.herdr
      .reportAgent({ pane_id: binding.paneId, source, agent: agentName, state, message })
      .catch(err => {
        rateLimited('report-agent', () => logger.warn('report-agent failed for %s: %s', binding.paneId, errText(err)))
      })
  }

  /** 会话专属 pane：关闭（避免恢复/重启累积空 pane）；固定绑定：仅释放 authority。 */
  const cleanupPane = (binding: Binding): Promise<void> => {
    const action = binding.created
      ? ctx.herdr.paneClose(binding.paneId).catch(() =>
          // 关闭失败（pane 已不存在）可忽略；兜底释放 authority
          ctx.herdr.clearAgentAuthority({ pane_id: binding.paneId, source, agent: agentName }).catch(() => {}))
      : ctx.herdr.clearAgentAuthority({ pane_id: binding.paneId, source, agent: agentName }).catch(() => {})
    const tracked = Promise.resolve(action)
    pendingCleanups.add(tracked)
    void tracked.finally(() => pendingCleanups.delete(tracked))
    return tracked
  }

  /** 为 agent 绑定 pane（幂等；CA-013：bind 完成前 agent 已 dispose 则不注册并清理已建 pane）。 */
  const bind = async (agentId: string): Promise<Binding | null> => {
    if (bindings.has(agentId)) return bindings.get(agentId)!
    const fixed = (config.paneId ?? '').trim()
    if (fixed) {
      const b: Binding = { paneId: fixed, created: false }
      bindings.set(agentId, b)
      registry.set(agentId, { pane_id: fixed, created: false })
      return b
    }
    pending.add(agentId)
    let created: Binding | null = null
    try {
      const snap = await ctx.herdr.snapshot()
      if (snap.focused_pane_id) {
        const { pane_id } = await ctx.herdr.paneSplit({ pane_id: snap.focused_pane_id, direction: 'right' })
        created = { paneId: pane_id, created: true }
        logger.info('agent %s bound to new pane %s (split)', agentId, pane_id)
      } else {
        const ws = await ctx.herdr.workspaceCreate({ label: config.label, cwd: config.cwd })
        if (ws.pane_id) {
          created = { paneId: ws.pane_id, created: true }
          logger.info('agent %s bound to new pane %s (workspace %s)', agentId, ws.pane_id, ws.workspace_id)
        } else {
          logger.warn('no pane for agent %s (no focused pane, workspace.create returned no root pane)', agentId)
        }
      }
      if (!created) return null
      // CA-013：异步 bind 期间 agent 已被 dispose → 不注册/不上报，立即回收已创建的 pane
      if (disposedAgents.has(agentId)) {
        logger.warn('agent %s disposed during bind; closing pane %s', agentId, created.paneId)
        void cleanupPane(created)
        return null
      }
      bindings.set(agentId, created)
      registry.set(agentId, { pane_id: created.paneId, created: created.created })
      return created
    } catch (err) {
      logger.warn('pane bind failed for agent %s: %s', agentId, errText(err))
      return null
    } finally {
      pending.delete(agentId)
    }
  }

  // 事件 payload 恒带 agent（id === session id）；类型经 dsh-agent 声明合并，
  // 这里用宽松类型桥访问（与 state-report.ts 一致）
  const offCreated = ctx.on('agent/created', (payload: any) => {
    const agentId = payload.agent.id
    void bind(agentId).then(binding => {
      if (binding) report(agentId, 'idle', 'herdr session ready')
    })
  })

  // agent/request（waterfall，必须 next()）→ working
  const offRequest = ctx.on('agent/request', async (payload: any, next: any) => {
    report(payload.agent.id, 'working', 'model request in progress')
    return next()
  })

  // turn-stopping → idle（PaneAgentState 无 done，映射 idle）
  const offStopping = ctx.on('agent/turn-stopping', (payload: any) => {
    report(payload.agent.id, 'idle', 'turn finished')
  })

  const offDisposed = ctx.on('agent/disposed', (payload: any) => {
    const agentId = payload.agent.id
    // CA-013：标记已 dispose；bind 在途时由其完成路径自清理（不遗留 pane/registry）
    disposedAgents.add(agentId)
    if (pending.has(agentId)) return
    const binding = bindings.get(agentId)
    disposedAgents.delete(agentId)
    if (!binding) return
    bindings.delete(agentId)
    registry.delete(agentId)
    void cleanupPane(binding)
  })

  logger.info('session-mode active (herdr preset standing scope)')

  ctx.effect(() => {
    return () => {
      offCreated()
      offRequest()
      offStopping()
      offDisposed()
      // CA-013：只清理本实例拥有的 registry key（多 standing mount / HMR 重叠时不误删他人）
      const ownedIds = [...bindings.keys()]
      for (const binding of bindings.values()) void cleanupPane(binding)
      bindings.clear()
      for (const id of ownedIds) registry.delete(id)
      pending.clear()
      disposedAgents.clear()
    }
  })
}