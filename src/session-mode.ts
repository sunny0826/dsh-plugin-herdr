import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PaneReportState } from './client/index.ts'
import { getBindingRegistry } from './binding-registry.ts'
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

  interface Binding {
    paneId: string
    created: boolean
  }
  // agent id（= session id）→ 绑定 pane
  const bindings = new Map<string, Binding>()

  const report = (agentId: string, state: PaneReportState, message?: string) => {
    const binding = bindings.get(agentId)
    if (!binding) return
    void ctx.herdr
      .reportAgent({ pane_id: binding.paneId, source, agent: agentName, state, message })
      .catch(err => {
        console.log(`[dsh-plugin-herdr] session-mode: report-agent failed for ${binding.paneId}: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  /** 为 agent 绑定 pane（幂等；失败返回 false）。 */
  const bind = async (agentId: string): Promise<boolean> => {
    if (bindings.has(agentId)) return true
    const fixed = (config.paneId ?? '').trim()
    if (fixed) {
      bindings.set(agentId, { paneId: fixed, created: false })
      registry.set(agentId, { pane_id: fixed, created: false })
      return true
    }
    try {
      const snap = await ctx.herdr.snapshot()
      if (snap.focused_pane_id) {
        const { pane_id } = await ctx.herdr.paneSplit({ pane_id: snap.focused_pane_id, direction: 'right' })
        bindings.set(agentId, { paneId: pane_id, created: true })
        registry.set(agentId, { pane_id, created: true })
        console.log(`[dsh-plugin-herdr] session-mode: agent ${agentId} bound to new pane ${pane_id} (split)`)
        return true
      }
      const ws = await ctx.herdr.workspaceCreate({ label: config.label, cwd: config.cwd })
      if (ws.pane_id) {
        bindings.set(agentId, { paneId: ws.pane_id, created: true })
        registry.set(agentId, { pane_id: ws.pane_id, created: true })
        console.log(`[dsh-plugin-herdr] session-mode: agent ${agentId} bound to new pane ${ws.pane_id} (workspace ${ws.workspace_id})`)
        return true
      }
      console.log(`[dsh-plugin-herdr] session-mode: no pane for agent ${agentId} (no focused pane, workspace.create returned no root pane)`)
      return false
    } catch (err) {
      console.log(`[dsh-plugin-herdr] session-mode: pane bind failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // 事件 payload 恒带 agent（id === session id）；类型经 dsh-agent 声明合并，
  // 这里用宽松类型桥访问（与 state-report.ts 一致）
  const offCreated = ctx.on('agent/created', (payload: any) => {
    const agentId = payload.agent.id
    void bind(agentId).then(ok => {
      if (ok) report(agentId, 'idle', 'herdr session ready')
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
    const binding = bindings.get(agentId)
    if (!binding) return
    bindings.delete(agentId)
    registry.delete(agentId)
    cleanupPane(binding)
  })

  /** 会话专属 pane：关闭（避免恢复/重启累积空 pane）；固定绑定：仅释放 authority。 */
  const cleanupPane = (binding: Binding) => {
    if (binding.created) {
      void ctx.herdr.paneClose(binding.paneId).catch(() => {
        // 关闭失败（pane 已不存在）可忽略；兜底释放 authority
        void ctx.herdr.clearAgentAuthority({ pane_id: binding.paneId, source, agent: agentName }).catch(() => {})
      })
    } else {
      void ctx.herdr.clearAgentAuthority({ pane_id: binding.paneId, source, agent: agentName }).catch(() => {})
    }
  }

  console.log('[dsh-plugin-herdr] session-mode active (herdr preset standing scope)')

  ctx.effect(() => {
    return () => {
      offCreated()
      offRequest()
      offStopping()
      offDisposed()
      for (const binding of bindings.values()) cleanupPane(binding)
      bindings.clear()
      for (const id of [...registry.keys()]) registry.delete(id)
    }
  })
}