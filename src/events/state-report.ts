import type { Context } from '@deepseek-ai/cordis'
import type { PaneReportState } from '../client/index.ts'
// 加载 dsh-agent 对 Cordis Events 的声明合并（agent/request、agent/turn-stopping）
import type {} from '@deepseek-ai/dsh-agent'

/**
 * DSH → Herdr 状态上报（DESIGN.md §10.2，M3）。
 *
 * 激活条件（§4 ADR-6）：reportState 配置开启 且 进程运行在 Herdr pane 内
 * （HERDR_ENV=1，Herdr 注入 HERDR_PANE_ID）。不满足时注册空实现并打一行日志。
 *
 * 状态映射（PaneAgentState 无 done，done 映射为 idle）：
 * - agent/request（模型请求开始）→ working
 * - agent/turn-stopping（回合结束边界）→ idle
 *
 * 上报是展示性的（不影响 Herdr 的等待/通知语义）；卸载时释放 authority。
 */
export interface StateReportOptions {
  reportState: boolean
  /** 上报来源标识（Herdr 侧边栏按 source 区分）。 */
  source: string
}

export function setupStateReporting(ctx: Context, opts: StateReportOptions): () => void {
  if (!opts.reportState) {
    return () => {}
  }

  const env = process.env
  const herdrEnv = env.HERDR_ENV === '1'
  const paneId = env.HERDR_PANE_ID
  if (!herdrEnv || !paneId) {
    console.log(
      `[dsh-plugin-herdr] state reporting disabled: HERDR_ENV=${env.HERDR_ENV ?? '(unset)'} HERDR_PANE_ID=${paneId ?? '(unset)'} (start dsh inside a Herdr pane to enable)`,
    )
    return () => {}
  }

  const agent = 'dsh'
  const report = (state: PaneReportState, message?: string) => {
    void ctx.herdr.reportAgent({ pane_id: paneId, source: opts.source, agent, state, message }).catch(err => {
      // 上报失败不打断主流程；连接类错误会由适配器给出可读信息
      console.log(`[dsh-plugin-herdr] report_agent failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const disposers: Array<() => void> = []
  disposers.push(ctx.on('agent/request', async (_payload, next) => {
    report('working', 'model request in progress')
    return next()
  }))
  disposers.push(ctx.on('agent/turn-stopping', () => report('idle', 'turn finished')))

  // 初始上报一次（侧边栏立即可见）
  report('idle', 'dsh agent ready')

  // 卸载清理：释放 authority
  const cleanup = () => {
    for (const d of disposers) d()
    void ctx.herdr.clearAgentAuthority({ pane_id: paneId, source: opts.source, agent }).catch(() => {
      // 清理失败可忽略（server 侧超时/不存在）
    })
  }
  return cleanup
}
