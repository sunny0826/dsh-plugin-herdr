import type { Context } from '@deepseek-ai/cordis'
import type { PaneReportState, ReportMetadataRequest } from '../client/index.ts'
import { createLogger, createRateLimiter, errText } from '../log.ts'
// 加载 dsh-agent 对 Cordis Events 的声明合并（agent/request、agent/turn-stopping）
import type {} from '@deepseek-ai/dsh-agent'
// 加载 dsh-tools 对 Cordis Events 的声明合并（tools/pre-execute → blocked 可观测点）
import type {} from '@deepseek-ai/dsh-tools'

/**
 * DSH → Herdr 状态上报（DESIGN.md §10.2，M3）。
 *
 * 激活条件（§4 ADR-6）：reportState 配置开启 且 进程运行在 Herdr pane 内
 * （HERDR_ENV=1，Herdr 注入 HERDR_PANE_ID）。不满足时注册空实现并打一行日志。
 *
 * 状态映射（CA-006 补全 blocked 可观测路径；report-agent 无 done 状态，done 映射 idle）：
 * - agent/request（模型请求开始）→ working
 * - tools/pre-execute 决策为 ask（等待审批）→ blocked；allowed → working（若可观测）
 * - agent/turn-stopping（回合结束边界）→ idle（“一轮完成”的 done 语义在 PaneAgentState
 *   中不可表达，按 §10.2 与 herdr 实测映射为 idle）
 * - 初始/空闲 → idle
 *
 * 元数据（M3-03，CA-006）：pane.report_metadata 上报 title + tokens（当前模型名），
 * 带 ttl_ms；TTL 刷新周期重报防止过期，卸载时停止刷新并释放 authority。
 *
 * 上报是展示性的（不影响 Herdr 的等待/通知语义）；卸载时释放 authority（幂等）。
 */
export interface StateReportOptions {
  reportState: boolean
  /** 上报来源标识（Herdr 侧边栏按 source 区分）。 */
  source: string
  /** 元数据 TTL（ms）；刷新周期为其一半。默认 30s。 */
  metadataTtlMs?: number
}

/** 元数据刷新周期 = ttl / 2（保证 ttl 过期前至少重报一次）。 */
const refreshInterval = (ttlMs: number) => Math.max(50, Math.floor(ttlMs / 2))

export function setupStateReporting(ctx: Context, opts: StateReportOptions): () => void {
  if (!opts.reportState) {
    return () => {}
  }

  const env = process.env
  const herdrEnv = env.HERDR_ENV === '1'
  const paneId = env.HERDR_PANE_ID
  if (!herdrEnv || !paneId) {
    createLogger(ctx, 'report').info(
      'state reporting disabled: HERDR_ENV=%s HERDR_PANE_ID=%s (start dsh inside a Herdr pane to enable)',
      env.HERDR_ENV ?? '(unset)',
      paneId ?? '(unset)',
    )
    return () => {}
  }

  const ttlMs = opts.metadataTtlMs ?? 30_000
  const agent = 'dsh'
  const logger = createLogger(ctx, 'report')
  // CA-017：上报失败限流（10s/key，避免连接故障时的日志风暴）
  const rateLimited = createRateLimiter(10_000)
  const report = (state: PaneReportState, message?: string) => {
    void ctx.herdr.reportAgent({ pane_id: paneId, source: opts.source, agent, state, message }).catch(err => {
      // 上报失败不打断主流程；连接类错误会由适配器给出可读信息
      rateLimited('report-agent', () => logger.warn('report_agent failed: %s', errText(err)))
    })
  }

  // ---- 元数据（M3-03）：title + tokens（当前模型名）+ ttl_ms ----
  let lastModel: string | undefined
  const buildMetadata = (): ReportMetadataRequest => ({
    pane_id: paneId,
    source: opts.source,
    agent,
    title: 'dsh agent',
    ...(lastModel ? { tokens: { model: lastModel } } : {}),
    ttl_ms: ttlMs,
  })
  const reportMetadata = () => {
    void ctx.herdr.reportMetadata(buildMetadata()).catch(err => {
      rateLimited('report-metadata', () => logger.warn('report_metadata failed: %s', errText(err)))
    })
  }

  const disposers: Array<() => void> = []
  disposers.push(ctx.on('agent/request', async (payload, next) => {
    // 记录当前模型名供 tokens 使用（AgentOptions.model）
    const model = (payload.agent as { options?: { model?: string } }).options?.model
    if (model) lastModel = model
    report('working', 'model request in progress')
    reportMetadata()
    return next()
  }))
  // CA-006：blocked 可观测点 —— 工具审批等待（pre-execute 决策 ask）
  disposers.push(ctx.on('tools/pre-execute', async (_exec, next) => {
    const decision = await next()
    if (decision?.kind === 'ask') {
      report('blocked', `awaiting approval: ${decision.reason ?? 'tool call'}`)
    } else if (decision?.kind === 'allow') {
      report('working', 'tool approved')
    }
    return decision
  }))
  // done 语义：report-agent 无 done 状态，回合结束（turn-stopping）映射 idle
  disposers.push(ctx.on('agent/turn-stopping', () => report('idle', 'turn finished')))

  // 初始上报一次（侧边栏立即可见）
  report('idle', 'dsh agent ready')
  reportMetadata()

  // TTL 刷新：ttl/2 周期重报元数据，防止侧边栏过期清除
  const refreshTimer = setInterval(() => reportMetadata(), refreshInterval(ttlMs))

  // 卸载清理：释放 authority + 停止 TTL 刷新（幂等，多次调用只清理一次）
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearInterval(refreshTimer)
    for (const d of disposers) d()
    void ctx.herdr.clearAgentAuthority({ pane_id: paneId, source: opts.source, agent }).catch(() => {
      // 清理失败可忽略（server 侧超时/不存在）
    })
  }
  return cleanup
}
