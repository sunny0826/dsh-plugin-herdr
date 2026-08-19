import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PaneReportState } from './client/index.ts'
import {
  displayLabel,
  getBindingRegistry,
  sessionIdFromTokens,
  sessionToken,
} from './binding-registry.ts'
import { createLogger, createRateLimiter, errText } from './log.ts'
// 加载 dsh-agent 对 Cordis Events 的声明合并（agent/created、agent/disposed、
// agent/request、agent/turn-stopping 带 agent 载体与 payload.agent）
import type {} from '@deepseek-ai/dsh-agent'

// session/event（Scoped<Session>）事件声明：会话事件经 session 载体按 scope 投递，
// standing scope（agent scope 的祖先）可收到本 preset 会话的全部事件。这里本地声明
// 最小形状（不引入 @deepseek-ai/dsh-session 依赖），仅用于读取 session/title 重命名。
interface SessionEventLike {
  type: string
  data?: { title?: unknown }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(this: unknown, session: { id: string }, event: SessionEventLike): void
  }
}

export interface Config {
  /** 固定绑定的 Herdr pane（所有会话共用）；留空则每会话自动创建专属 pane。 */
  paneId?: string
  /** 上报来源标识（Herdr 侧边栏按 source 区分）。 */
  source: string
  /**
   * workspace/pane 显示名。
   * 留空（默认）优先取会话标题（session/title，即 GUI 中显示的会话名），
   * 无标题时回退 "dsh:<项目名>-<会话短id>"（cwd basename + 短 id 区分
   * 同项目多会话；无 cwd 回退 "dsh:<短id>"）；标题异步生成，生成后自动补正；
   * 非空时作为完整 label 使用（自定义覆盖）。
   */
  label: string
  /** 自动创建 pane 时新 pane 的 shell 工作目录（可选）。 */
  cwd?: string
}

export const Config: Schema<Config> = Schema.object({
  paneId: Schema.string(),
  source: Schema.string().default('dsh:herdr-session'),
  label: Schema.string().default(''),
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
    /** 专属 workspace（created=true 时存在；会话结束随 pane 一并关闭）。 */
    workspaceId?: string
  }
  // agent id（= session id）→ 绑定 pane
  const bindings = new Map<string, Binding>()
  // CA-013：在途 bind 与已 dispose 的 agent（bind/dispose 竞态防护）
  const pending = new Set<string>()
  const disposedAgents = new Set<string>()
  // 已发生过 turn-stopping 的 agent（request 兜底 bind 完成后不覆盖 idle 状态）
  const turnStopped = new Set<string>()
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

  /**
   * 会话专属 pane/workspace 清理：created=true 时关闭整个专属 workspace
   * （本会话产出的 pane 都归于此，随会话一并回收，避免残留空 workspace）；
   * 固定绑定：仅释放 authority。
   */
  const cleanupPane = (binding: Binding): Promise<void> => {
    const action = binding.created
      ? (binding.workspaceId
          ? ctx.herdr.workspaceClose(binding.workspaceId).catch(() =>
              // workspace 关闭失败（已不存在等）可忽略；兜底只关绑定 pane
              ctx.herdr.paneClose(binding.paneId).catch(() => {}))
          : ctx.herdr.paneClose(binding.paneId).catch(() => {}))
      : ctx.herdr.clearAgentAuthority({ pane_id: binding.paneId, source, agent: agentName }).catch(() => {})
    const tracked = Promise.resolve(action)
    pendingCleanups.add(tracked)
    void tracked.finally(() => pendingCleanups.delete(tracked))
    return tracked
  }

  /**
   * 会话标题：折叠 session.events 中最新一条 session/title 事件（last-wins）。
   * 无标题/事件缺失返回 undefined。标题来自会话首个用户消息的自动生成
   * （session-title），异步出现——bind 时可能尚无，随后由 session/event 监听补正。
   */
  const sessionTitleOf = (session: unknown): string | undefined => {
    const events = (session as { events?: unknown } | undefined)?.events
    if (!Array.isArray(events)) return undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as SessionEventLike | undefined
      if (e?.type !== 'session/title') continue
      const title = e.data?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
    }
    return undefined
  }

  /** 显示名：config.label 覆盖 > 会话标题 > dsh:<项目名>-<会话短id> 兜底。 */
  const resolveLabel = (sessionCwd: string | undefined, agentId: string, session?: unknown): string =>
    (config.label ?? '').trim() || sessionTitleOf(session) || displayLabel(sessionCwd, agentId)

  /** 按显示名重命名绑定 workspace + pane（尽力而为，失败静默）。 */
  const renameBound = (binding: Binding, label: string): void => {
    if (binding.workspaceId) {
      void ctx.herdr.workspaceRename(binding.workspaceId, label).catch(() => {})
    }
    void ctx.herdr.paneRename(binding.paneId, label).catch(() => {})
  }

  /**
   * 为 agent 绑定 pane（幂等；CA-013：bind 完成前 agent 已 dispose 则不注册并清理已建 pane）。
   * - 专属 workspace：会话启动时在项目目录（agent.session.header.cwd）创建专属
   *   workspace，绑定 pane 为其 root pane——本会话产出的 pane（split/复用）都
   *   归于此 workspace，与其他会话/用户 workspace（如 ~）隔离；
   * - session：会话对象（agent.session），用于读取 cwd 与标题（session/title）；
   * - 显示名与内部标记分离（MG-55）：workspace/pane label 优先取会话标题
   *   （用户可见的会话名），无标题时回退 "dsh:<项目名>-<会话短id>"；
   *   内部标记 = 绑定 pane 的 tokens.dsh_session（report_metadata 写入，ttl=null 永久）——
   *   复用与 /herdr-session-pane 兜底查询都走 tokens，不再用 label 承载 session id；
   * - 复用：herdr 中已存在带本会话 tokens 标记的 pane 时直接复用（进程重启/插件重载
   *   后 registry 内存清空、并发重复 created 的场景），避免同一个会话累积多个 pane；
   *   复用时若会话标题已可用则补正 workspace/pane 显示名。
   */
  const bind = async (agentId: string, session?: unknown): Promise<Binding | null> => {
    if (bindings.has(agentId)) return bindings.get(agentId)!
    // 防重入：在途 bind 直接返回（并发重复 created / 兜底 bind 不重复创建 pane）
    if (pending.has(agentId)) return null
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
      const sessionCwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      const label = resolveLabel(sessionCwd, agentId, session)
      // 复用：herdr 中已存在带本会话 tokens 标记的 pane（registry 清空/重启后的恢复）
      const existing = (snap.panes ?? []).find(p => sessionIdFromTokens(p.tokens) === agentId)
      if (existing) {
        // 复用标记 pane（此前会话遗留/registry 清空后的恢复）；本会话负责其生命周期
        created = { paneId: existing.pane_id, created: true, workspaceId: existing.workspace_id }
        // 会话标题已可用 → 补正显示名（bind 时标题尚未生成的场景由 session/event 兜底）
        if (sessionTitleOf(session)) renameBound(created, label)
        logger.info('agent %s reused marked pane %s', agentId, existing.pane_id)
      } else {
        // 专属 workspace：项目目录（会话 cwd）创建 root pane 即绑定 pane；
        // label 用显示名（会话标题，无标题回退 "dsh:<项目名>-<会话短id>"，config.label 非空时自定义覆盖）
        const ws = await ctx.herdr.workspaceCreate({
          label,
          cwd: sessionCwd ?? config.cwd,
        })
        if (ws.pane_id) {
          created = { paneId: ws.pane_id, created: true, workspaceId: ws.workspace_id }
          // 显示名（pane label）与内部标记（tokens）分离：
          // label = 会话标题/显示名（用户可见）；tokens.dsh_session = sessionId（复用用）
          await ctx.herdr.paneRename(ws.pane_id, label).catch(() => {})
          await ctx.herdr.reportMetadata({
            pane_id: ws.pane_id,
            source,
            agent: agentName,
            tokens: sessionToken(agentId),
            ttl_ms: null,
          }).catch(() => {})
          logger.info('agent %s bound to new pane %s (workspace %s, cwd=%s, label=%s)', agentId, ws.pane_id, ws.workspace_id, sessionCwd ?? config.cwd ?? 'default', label)
        } else {
          logger.warn('no pane for agent %s (workspace.create returned no root pane)', agentId)
        }
      }
      if (!created) return null
      // CA-013：异步 bind 期间 agent 已被 dispose → 不注册/不上报，立即回收已创建的 pane
      if (disposedAgents.has(agentId)) {
        logger.warn('agent %s disposed during bind; closing pane %s', agentId, created.paneId)
        // codex review P2：竞态分支处理完 dispose 后必须清除标记，避免 session id 复用误关新 pane
        disposedAgents.delete(agentId)
        void cleanupPane(created)
        return null
      }
      bindings.set(agentId, created)
      registry.set(agentId, {
        pane_id: created.paneId,
        created: created.created,
        ...(created.workspaceId ? { workspace_id: created.workspaceId } : {}),
      })
      return created
    } catch (err) {
      logger.warn('pane bind failed for agent %s: %s', agentId, errText(err))
      return null
    } finally {
      pending.delete(agentId)
      // codex review P2：bind 失败/未创建时若 dispose 在途，其意图已由本次 bind 消费，
      // 一并清除标记（竞态分支成功路径已在上面删除，这里兜底失败路径）
      if (disposedAgents.has(agentId)) disposedAgents.delete(agentId)
    }
  }

  // 事件 payload 恒带 agent（id === session id）；类型经 dsh-agent 声明合并，
  // 这里用宽松类型桥访问（与 state-report.ts 一致）
  const sessionOf = (agent: any): unknown => agent?.session

  const offCreated = ctx.on('agent/created', (payload: any) => {
    const agentId = payload.agent.id
    void bind(agentId, sessionOf(payload.agent)).then(binding => {
      if (binding) report(agentId, 'idle', 'herdr session ready')
    })
  })

  // agent/request（waterfall，必须 next()）→ working
  // 兜底 bind：agent/created 可能从未在本 standing scope 触发——preset 切换
  // （agent-presets.recompose 只改 scope 父子关系、不重建 agent）与进程重启/
  // 插件重载（registry 内存清空）后，在第一个模型请求时补绑。bind 是异步
  // 网络调用，不阻塞瀑布链（fire-and-forget）。未绑定时的 working 上报推迟到
  // bind 完成（否则 report 因无 binding 丢弃）；若 turn 已结束则不覆盖 idle。
  const offRequest = ctx.on('agent/request', async (payload: any, next: any) => {
    const agentId = payload.agent.id
    turnStopped.delete(agentId)
    if (!bindings.has(agentId) && !pending.has(agentId) && !disposedAgents.has(agentId)) {
      void bind(agentId, sessionOf(payload.agent)).then(binding => {
        if (binding && !turnStopped.has(agentId)) report(agentId, 'working', 'model request in progress')
      })
    }
    report(agentId, 'working', 'model request in progress')
    return next()
  })

  // turn-stopping → idle（PaneAgentState 无 done，映射 idle）
  const offStopping = ctx.on('agent/turn-stopping', (payload: any) => {
    const agentId = payload.agent.id
    turnStopped.add(agentId)
    report(agentId, 'idle', 'turn finished')
  })

  const offDisposed = ctx.on('agent/disposed', (payload: any) => {
    const agentId = payload.agent.id
    // CA-013：标记已 dispose；bind 在途时由其完成路径自清理（不遗留 pane/registry）
    disposedAgents.add(agentId)
    turnStopped.delete(agentId)
    if (pending.has(agentId)) return
    const binding = bindings.get(agentId)
    disposedAgents.delete(agentId)
    if (!binding) return
    bindings.delete(agentId)
    registry.delete(agentId)
    void cleanupPane(binding)
  })

  // 会话标题补正：标题在 bind 之后异步生成（session/title 事件）→ 重命名 workspace/pane。
  // 显示名以最新标题为准（last-wins）；config.label 非空时自定义覆盖，永不改写。
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title') return
    const agentId = session?.id
    if (typeof agentId !== 'string') return
    const title = event.data?.title
    if (typeof title !== 'string' || title.trim() === '') return
    const binding = bindings.get(agentId)
    if (!binding) return
    const label = (config.label ?? '').trim() || title.trim()
    renameBound(binding, label)
  })

  logger.info('session-mode active (herdr preset standing scope)')

  ctx.effect(() => {
    return () => {
      offCreated()
      offRequest()
      offStopping()
      offDisposed()
      offSessionEvent()
      // CA-013：只清理本实例拥有的 registry key（多 standing mount / HMR 重叠时不误删他人）
      const ownedIds = [...bindings.keys()]
      for (const binding of bindings.values()) void cleanupPane(binding)
      bindings.clear()
      for (const id of ownedIds) registry.delete(id)
      pending.clear()
      disposedAgents.clear()
      turnStopped.clear()
    }
  })
}