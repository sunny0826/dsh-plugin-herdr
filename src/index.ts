import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigType, resolveCliPath } from './config.ts'
import { setupEventForwarding } from './events/forward.ts'
import { setupStateReporting } from './events/state-report.ts'
import { HerdrStatusTracker, startHerdrServer } from './status.ts'
import { getBindingRegistry } from './binding-registry.ts'
import { registerHerdrSkill } from './skill.ts'
import { registerSnapshot } from './tools/snapshot.ts'
import { registerAgentList } from './tools/agent-list.ts'
import { registerPaneRun } from './tools/pane-run.ts'
import { registerAgentWait } from './tools/agent-wait.ts'
import { registerWorkspaceCreate } from './tools/workspace-create.ts'
import { registerPaneSplit } from './tools/pane-split.ts'
import { registerPaneSendKeys } from './tools/pane-send-keys.ts'
import { registerPaneRead } from './tools/pane-read.ts'
import { registerPaneLayout } from './tools/pane-layout.ts'
import { registerLayoutApply } from './tools/layout-apply.ts'
import { registerAgentPrompt } from './tools/agent-prompt.ts'
import { registerAgentExplain } from './tools/agent-explain.ts'
import { registerAgentSendKeys } from './tools/agent-send-keys.ts'
import { registerNotification } from './tools/notification.ts'

// cordis 通过模块导出的 Config 校验插件配置并填充默认值
export { Config } from './config.ts'

export const name = 'dsh-plugin-herdr'
export const inject = ['tools', 'herdr', 'jobs']

/**
 * 消费者插件：注册 herdr_* 工具与事件转发。
 * herdr 服务由 dsh-plugin-herdr-client（client-entry.ts）提供；
 * jobs 由 dsh-base 的 dsh-jobs-local 提供（后台化，§9）。
 * cordis 4 要求访问服务的 fiber 显式 inject（见 client-entry.ts 注释）。
 */
export function apply(ctx: Context, config: ConfigType) {
  // M1 MVP 工具
  registerSnapshot(ctx)
  registerAgentList(ctx)
  registerPaneRun(ctx, { allowBackground: config.allowBackground })
  registerAgentWait(ctx, { allowBackground: config.allowBackground })

  // M2 扩展工具
  registerWorkspaceCreate(ctx)
  registerPaneSplit(ctx)
  registerPaneSendKeys(ctx)
  registerPaneRead(ctx)
  registerPaneLayout(ctx)
  // layout.apply 只有 socket 传输有实现（herdr layout CLI 不存在）；CLI 下不注册，
  // 避免模型调用后收到"requires the socket transport"错误（session log 实测）
  if (config.transport !== 'cli') registerLayoutApply(ctx)
  registerAgentPrompt(ctx)
  registerAgentExplain(ctx)
  registerAgentSendKeys(ctx)
  registerNotification(ctx)

  // M5 状态面板：跟踪器（agent 状态 + 输出缓冲 + 安装检查）+ HTTP 端点
  const cliPath = resolveCliPath(config)
  const tracker = new HerdrStatusTracker(ctx, ctx.herdr, cliPath, { pollIntervalMs: 2000 })
  void tracker.probeCli().then(info => {
    if (!info.available) {
      console.log(`[dsh-plugin-herdr] herdr CLI not found at '${info.path}'. Install: curl -fsSL https://herdr.dev/install.sh | sh`)
    }
  })
  const offAgentState = ctx.on('herdr/agent-state', (info: { pane_id: string; agent: string; status: string; message?: string }) =>
    tracker.onAgentState(info))
  const offResourceChanged = ctx.on('herdr/resource-changed', (change: { type: string; action: string; id: string }) =>
    tracker.onResourceChanged(change))
  // root ctx 的 get 走注册表宽松路径（fiber store 只含 inject 服务）
  // webServer 由 dsh-host-webserver 提供；用 ctx.inject 等待其就绪再注册路由
  // （headless 环境无 webServer 时回调不执行，功能自动降级）
  let offRoute: (() => void) | null = null
  let offBindingRoute: (() => void) | null = null
  let offStartRoute: (() => void) | null = null
  ctx.inject(['webServer'], injected => {
    const webServer = (injected as unknown as { webServer: { register(r: unknown): () => void } }).webServer
    type Res = { writeHead(code: number, headers: Record<string, string>): void; end(body?: string): void }
    // M5 状态看板数据源：GET /herdr-status
    offRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-status',
      handler: (_req: unknown, res: Res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(tracker.snapshot()))
      },
    })
    // M11 本对话 pane 查询：GET /herdr-session-pane?agent=<sessionId>
    offBindingRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-session-pane',
      handler: (req: { url?: string }, res: Res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        let paneId: string | null = null
        try {
          const agent = new URL(req.url ?? '/', 'http://x').searchParams.get('agent')
          paneId = agent ? getBindingRegistry().get(agent)?.pane_id ?? null : null
        } catch {
          // 忽略解析错误（返回 null）
        }
        res.end(JSON.stringify({ pane_id: paneId }))
      },
    })
    // M7 启动看板：POST /herdr-start（headless server 未运行时由看板按钮调用）
    offStartRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-start',
      handler: async (_req: unknown, res: Res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          const server = await startHerdrServer(cliPath)
          res.end(JSON.stringify({ ok: server.running, server }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
  })
  tracker.start()

  // 会话 skill：启用插件即加载 Herdr 官方 SKILL.md
  const stopSkill = registerHerdrSkill(ctx)

  const stopForwarding = setupEventForwarding(ctx, {
    enabled: config.events.enabled,
    maxReconnectMs: config.events.maxReconnectMs,
  })
  const stopReporting = setupStateReporting(ctx, {
    reportState: config.reportState,
    source: 'dsh:herdr-plugin',
  })

  ctx.effect(() => {
    return () => {
      tracker.stop()
      offAgentState()
      offResourceChanged()
      offRoute?.()
      offBindingRoute?.()
      offStartRoute?.()
      stopSkill()
      stopForwarding()
      stopReporting()
    }
  })

  ctx.effect(() => {
    console.log(
      `[dsh-plugin-herdr] plugin loaded! transport=${config.transport} timeoutMs=${config.timeoutMs} allowBackground=${config.allowBackground} events=${config.events.enabled}`,
    )
    return () => console.log('[dsh-plugin-herdr] plugin disposed')
  })
}