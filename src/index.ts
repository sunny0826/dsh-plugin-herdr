import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigType, resolveSession, resolveSocketPath } from './config.ts'
import { guardLocalRequest, requireMethod } from './http-guard.ts'
import { createLogger } from './log.ts'
import { setupEventForwarding } from './events/forward.ts'
import { setupStateReporting } from './events/state-report.ts'
import { HerdrStatusTracker, startHerdrServer } from './status.ts'
import { HerdrDashboardTracker } from './dashboard.ts'
import { getBindingRegistry, getBoundPaneIds, getBoundWorkspaceIds, sessionIdFromTokens } from './binding-registry.ts'
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
import { registerAgentStart } from './tools/agent-start.ts'
import { registerAgentExplain } from './tools/agent-explain.ts'
import { registerAgentSendKeys } from './tools/agent-send-keys.ts'
import { registerNotification } from './tools/notification.ts'
import { registerWorkspaceClose } from './tools/workspace-close.ts'
import { registerPaneClose } from './tools/pane-close.ts'
import { registerWorkspaceRename } from './tools/workspace-rename.ts'
import { registerPaneRename } from './tools/pane-rename.ts'
import { resolveTerminalSessionConfig } from './config.ts'
import { probeTerminalSession, type TerminalSessionCapability } from './terminal-session/capability.ts'
import { resolveSessionConnection } from './terminal-session/process.ts'
import { TerminalSessionManager } from './terminal-session/manager.ts'
import { registerTerminalSessionRoutes } from './terminal-session/routes.ts'

// cordis 通过模块导出的 Config 校验插件配置并填充默认值
export { Config } from './config.ts'

export const name = 'dsh-plugin-herdr'
export const inject = ['tools', 'herdr', 'jobs']

/**
 * 读取 HTTP 请求体并 JSON.parse（简易读流；parse 失败抛错由调用方转 400）。
 * 真实环境 req 是 Node IncomingMessage（Readable）；测试注入的 plain 对象走 body 字段。
 */
async function readJsonBody(req: unknown): Promise<unknown> {
  const r = req as { on?: (ev: string, cb: (chunk?: Buffer | string) => void) => unknown; body?: unknown }
  if (typeof r.on === 'function') {
    const chunks: Array<Buffer | string> = []
    await new Promise<void>((resolve, reject) => {
      r.on!('data', (c) => { if (c != null) chunks.push(c) })
      r.on!('end', () => resolve())
      r.on!('error', reject)
    })
    const raw = Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }
  // 测试注入的 plain 对象：body 已是解析后的对象或 JSON 字符串
  const b = r.body
  return typeof b === 'string' ? JSON.parse(b) : (b ?? {})
}

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
  // layout.apply 为 socket 协议原生方法（全量迁移后恒注册）
  registerLayoutApply(ctx)
  registerAgentPrompt(ctx)
  registerAgentStart(ctx)
  registerAgentExplain(ctx)
  registerAgentSendKeys(ctx)
  registerNotification(ctx)

  // v2 关闭/重命名工具（FB-01 / FB-04）
  registerWorkspaceClose(ctx)
  registerPaneClose(ctx)
  registerWorkspaceRename(ctx)
  registerPaneRename(ctx)

  // M5 状态面板：跟踪器（agent 状态 + 输出缓冲 + server ping）+ HTTP 端点
  const tracker = new HerdrStatusTracker(ctx, ctx.herdr, {
    pollIntervalMs: 2000,
    socketPath: resolveSocketPath(config) ?? null,
    session: resolveSession(config) ?? null,
  })
  // Dashboard（design: dashboard §4）：本机只读总览——复用 status tracker 的单飞轮询
  // 快照（全量，不按项目过滤），自身只做 host 采集 / POSIX 进程探测 / DTO 装配。
  const dashboardTracker = new HerdrDashboardTracker(ctx, {
    readStatus: () => tracker.snapshot('all'),
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
  let offPaneSessionRoute: (() => void) | null = null
  let offStartRoute: (() => void) | null = null
  let offCloseRoute: (() => void) | null = null
  let offRenameRoute: (() => void) | null = null
  let offPaneInputRoute: (() => void) | null = null
  let offTerminalBootstrapRoute: (() => void) | null = null
  let offTerminalWaitRoute: (() => void) | null = null
  let offDashboardRoute: (() => void) | null = null
  let offTerminalSessionRoutes: (() => void) | null = null
  // Pane 终端 Observer/Controller（design: pane-terminal-session-state-machine §6）
  const terminalSessionCfg = resolveTerminalSessionConfig(config)
  let terminalManager: TerminalSessionManager | null = null
  let terminalCapability: TerminalSessionCapability | null = null
  const ensureTerminalAvailable = async (): Promise<boolean> => {
    if (!terminalCapability) {
      terminalCapability = await probeTerminalSession({ binPath: terminalSessionCfg.binPath })
    }
    return terminalCapability.available
  }
  ctx.inject(['webServer'], injected => {
    const webServer = (injected as unknown as { webServer: { register(r: unknown): () => void } }).webServer
    type Res = { writeHead(code: number, headers: Record<string, string>): void; end(body?: string): void }
    // CA-007：控制面守卫 —— 严格方法 + Host allowlist + Origin/Sec-Fetch-Site 同源
    type Req = { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }
    const reject = (res: Res, status: number, message: string, extraHeaders: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
      res.end(JSON.stringify({ ok: false, error: message }))
    }
    const guard = (res: Res, req: unknown, allowed: string): boolean => {
      const r = req as Req
      const m = requireMethod(r, allowed)
      if (!m.ok) {
        reject(res, m.status, m.message, { allow: allowed.toUpperCase() })
        return false
      }
      const local = guardLocalRequest(r)
      if (!local.ok) {
        reject(res, local.status, local.message)
        return false
      }
      return true
    }
    // Pane 终端 Observer/Controller 流式路由（design: pane-terminal-session-state-machine §6.3）
    // 注意：webServer.register 是依赖 this 的实例方法，必须以绑定包装传入（裸传会把 this 变为
    // undefined，register 内部 this.exact.set 抛错，进而使下方所有核心路由都不再注册）。
    // 同时 try/catch 隔离：任何 terminal 路由初始化失败都不得拖垮 /herdr-status 等核心路由。
    if (terminalSessionCfg.enabled) {
      const conn = resolveSessionConnection(config)
      if (conn.socketPath) {
        try {
          terminalManager = new TerminalSessionManager({
            config: terminalSessionCfg,
            ...(terminalSessionCfg.binPath ? { binPath: terminalSessionCfg.binPath } : {}),
            socketPath: conn.socketPath,
            ...(conn.session ? { session: conn.session } : {}),
          })
          offTerminalSessionRoutes = registerTerminalSessionRoutes((r) => webServer.register(r), {
            manager: terminalManager,
            ensureAvailable: ensureTerminalAvailable,
            checkOwnership: async (paneId) => {
            const boundWsIds = new Set(getBoundWorkspaceIds())
            if (boundWsIds.size === 0) return true
            try {
              const snap = await ctx.herdr.snapshot()
              const ws = snap.panes.find((p: { pane_id: string }) => p.pane_id === paneId)?.workspace_id
              return !!ws && boundWsIds.has(ws)
            } catch {
              return false
            }
          },
          guard: (res, req, method) => guard(res as Res, req, method),
          reject: (res, status, message) => reject(res as Res, status, message),
          sendJson: (res, status, obj) => {
            const r = res as Res
            r.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
            r.end(JSON.stringify(obj))
          },
        })
        } catch (err) {
          terminalManager = null
          offTerminalSessionRoutes = null
          createLogger(ctx, 'index').warn('terminal session 路由注册失败，已禁用: %s', err instanceof Error ? err.message : String(err))
        }
      }
    }
    // M5 状态看板数据源：GET /herdr-status
    offRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-status',
      handler: (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        // 看板 scope：?scope=all → 全量；缺省/其他 → 项目目录过滤（§7.3）
        const scope = new URL((req as Req).url ?? '/', 'http://x').searchParams.get('scope') === 'all' ? 'all' : 'project'
        res.end(JSON.stringify(tracker.snapshot(scope)))
      },
    })
    // Dashboard（design: dashboard §4.1）：本机只读总览，GET-only + 现有 local/GET guard。
    // 独立 DTO（决策 11），不改变 /herdr-status 的 session/project 过滤语义。
    offDashboardRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-dashboard',
      handler: (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(dashboardTracker.snapshot()))
      },
    })
    // M11 本对话 pane 查询：GET /herdr-session-pane?agent=<sessionId>
    offBindingRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-session-pane',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        let paneId: string | null = null
        try {
          const r = req as Req
          const agent = new URL(r.url ?? '/', 'http://x').searchParams.get('agent')
          if (agent) {
            paneId = getBindingRegistry().get(agent)?.pane_id ?? null
            if (!paneId) {
              // registry 未命中（进程重启/插件重载后内存清空，或 bind 尚在途）：
              // 从 herdr 中查找带本会话内部标记（tokens.dsh_session = agent）的 pane 兜底
              const snap = await ctx.herdr.snapshot()
              paneId = (snap.panes ?? []).find(p => sessionIdFromTokens(p.tokens) === agent)?.pane_id ?? null
            }
          }
        } catch {
          // 忽略解析/快照错误（返回 null）
        }
        res.end(JSON.stringify({ pane_id: paneId }))
      },
    })
    // M12 pane → session 归属反查：GET /herdr-pane-session?pane=<paneId>
    // Dashboard pane 跳转用：判断目标 pane 是否属于当前 DSH 会话（registry 反查，
    // 兜底读 herdr pane 的 tokens.dsh_session 标记）；无归属返回 { session_id: null }。
    offPaneSessionRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-pane-session',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        let sessionId: string | null = null
        try {
          const r = req as Req
          const paneId = new URL(r.url ?? '/', 'http://x').searchParams.get('pane')
          if (paneId) {
            // 1) 绑定 registry 反查（pane_id → session_id；O(n)，绑定数很小）
            for (const [sid, b] of getBindingRegistry()) {
              if (b.pane_id === paneId) {
                sessionId = sid
                break
              }
            }
            // 2) 兜底：herdr snapshot 中该 pane 的 tokens.dsh_session（registry 重启清空）
            if (!sessionId) {
              const snap = await ctx.herdr.snapshot()
              const pane = (snap.panes ?? []).find((p: { pane_id?: string }) => p.pane_id === paneId)
              sessionId = pane ? (sessionIdFromTokens((pane as { tokens?: Record<string, string | null> }).tokens) ?? null) : null
            }
          }
        } catch {
          // 忽略解析/快照错误（返回 null）
        }
        res.end(JSON.stringify({ session_id: sessionId }))
      },
    })
    // M7 启动看板：POST /herdr-start（headless server 未运行时由看板按钮调用；
    // D1：全插件唯一的 CLI spawn 引导例外——socket 无法启动自身）
    offStartRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-start',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'POST')) return
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          const socketPath = resolveSocketPath(config)
          if (!socketPath) {
            res.end(JSON.stringify({ ok: false, error: 'herdr socket path unresolvable (POSIX only; Windows is not supported)' }))
            return
          }
          const server = await startHerdrServer(socketPath, { session: resolveSession(config) ?? null })
          res.end(JSON.stringify({ ok: server.running, server }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
    // v2 关闭路由：POST /herdr-close（FB-01；面板调用，服务端权威安全校验）
    // 目标 pane/workspace 含绑定本对话的 pane → 拒绝（防止关闭宿主本会话的 pane）
    offCloseRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-close',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'POST')) return
        let body: { kind?: string; id?: string }
        try {
          const parsed = (await readJsonBody(req)) as Record<string, unknown>
          body = { kind: typeof parsed.kind === 'string' ? parsed.kind : undefined, id: typeof parsed.id === 'string' ? parsed.id : undefined }
        } catch {
          reject(res, 400, 'invalid JSON body')
          return
        }
        if (body.kind !== 'workspace' && body.kind !== 'pane') {
          reject(res, 400, "kind must be 'workspace' or 'pane'")
          return
        }
        if (!body.id || body.id.trim() === '') {
          reject(res, 400, 'id must be a non-empty string')
          return
        }
        const bound = new Set(getBoundPaneIds())
        if (body.kind === 'pane') {
          if (bound.has(body.id)) {
            reject(res, 400, 'cannot close the pane hosting this session')
            return
          }
        } else {
          // workspace：查其 pane 是否命中任一绑定 pane
          const hostSelf = await (async () => {
            try {
              const snap = await ctx.herdr.snapshot()
              return snap.panes.some(p => p.workspace_id === body.id && bound.has(p.pane_id))
            } catch {
              // 快照失败（异常场景）不阻塞关闭
              return false
            }
          })()
          if (hostSelf) {
            reject(res, 400, 'cannot close the workspace hosting this session')
            return
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          if (body.kind === 'pane') await ctx.herdr.paneClose(body.id)
          else await ctx.herdr.workspaceClose(body.id)
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
    // v2 重命名路由：POST /herdr-rename（FB-04；label 为空即清除 pane 名称）
    offRenameRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-rename',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'POST')) return
        let body: { kind?: string; id?: string; label?: string | null }
        try {
          const parsed = (await readJsonBody(req)) as Record<string, unknown>
          body = {
            kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
            id: typeof parsed.id === 'string' ? parsed.id : undefined,
            label: typeof parsed.label === 'string' ? parsed.label : (parsed.label == null ? null : undefined),
          }
        } catch {
          reject(res, 400, 'invalid JSON body')
          return
        }
        if (body.kind !== 'workspace' && body.kind !== 'pane') {
          reject(res, 400, "kind must be 'workspace' or 'pane'")
          return
        }
        if (!body.id || body.id.trim() === '') {
          reject(res, 400, 'id must be a non-empty string')
          return
        }
        if (body.kind === 'workspace') {
          if (!body.label || body.label.trim() === '') {
            reject(res, 400, 'label must be a non-empty string')
            return
          }
        }
        // label 非空时 ≤64（与工具层校验一致）
        if (typeof body.label === 'string' && body.label.trim().length > 64) {
          reject(res, 400, 'label must be at most 64 characters')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          if (body.kind === 'pane') await ctx.herdr.paneRename(body.id, body.label ?? null)
          else await ctx.herdr.workspaceRename(body.id, body.label as string)
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
    // v2 终端输入路由：POST /herdr-pane-input（交互式终端写回）
    offPaneInputRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-pane-input',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'POST')) return
        let body: { pane_id?: string; kind?: string; text?: string; keys?: string[] }
        try {
          const parsed = (await readJsonBody(req)) as Record<string, unknown>
          body = {
            pane_id: typeof parsed.pane_id === 'string' ? parsed.pane_id : undefined,
            kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
            text: typeof parsed.text === 'string' ? parsed.text : undefined,
            keys: Array.isArray(parsed.keys) ? parsed.keys.filter((k): k is string => typeof k === 'string') : undefined,
          }
        } catch {
          reject(res, 400, 'invalid JSON body')
          return
        }
        if (!body.pane_id || body.pane_id.trim() === '') {
          reject(res, 400, 'pane_id must be a non-empty string')
          return
        }
        if (body.kind !== undefined && body.kind !== 'text' && body.kind !== 'keys') {
          reject(res, 400, "kind must be 'text' or 'keys'")
          return
        }
        const hasText = body.text != null && body.text.length > 0
        const hasKeys = body.keys != null && body.keys.length > 0
        if (!hasText && !hasKeys) {
          reject(res, 400, 'text or keys is required')
          return
        }
        if (body.kind === 'text' && !hasText) {
          reject(res, 400, 'text is required for kind=text')
          return
        }
        if (body.kind === 'keys' && !hasKeys) {
          reject(res, 400, 'keys is required for kind=keys')
          return
        }
        if (hasText) {
          if (Buffer.byteLength(body.text!, 'utf8') > 64 * 1024) {
            reject(res, 400, 'text exceeds 64KB limit')
            return
          }
        }
        if (hasKeys) {
          if (body.keys!.length > 32) {
            reject(res, 400, 'keys array exceeds 32 item limit')
            return
          }
        }
        // workspace ownership check：只允许当前会话绑定 workspace 内的 pane
        // （设计 §3.4：workspace 归属校验，非 pane 绑定校验）
        const boundWsIds = new Set(getBoundWorkspaceIds())
        if (boundWsIds.size > 0) {
          // 查找目标 pane 的 workspace_id（从 topology 快照）
          try {
            const snap = await ctx.herdr.snapshot()
            const targetWs = snap.panes.find(p => p.pane_id === body.pane_id)?.workspace_id
            if (!targetWs || !boundWsIds.has(targetWs)) {
              reject(res, 403, 'pane not accessible from this session')
              return
            }
          } catch {
            // 快照失败：拒绝（不放行）
            reject(res, 503, 'unable to verify pane ownership')
            return
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          await ctx.herdr.paneSendInput({ pane_id: body.pane_id, text: body.text, keys: body.keys })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
    // 终端 bootstrap 路由：GET /herdr-pane-terminal-bootstrap（当前 viewport ANSI 快照）
    offTerminalBootstrapRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-pane-terminal-bootstrap',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const paneId = url.searchParams.get('pane_id')
        if (!paneId || paneId.trim() === '') {
          reject(res, 400, 'pane_id query parameter is required')
          return
        }
        // workspace ownership check
        const boundWsIds = new Set(getBoundWorkspaceIds())
        if (boundWsIds.size > 0) {
          try {
            const snap = await ctx.herdr.snapshot()
            const targetWs = snap.panes.find((p: { pane_id: string }) => p.pane_id === paneId)?.workspace_id
            if (!targetWs || !boundWsIds.has(targetWs)) {
              reject(res, 403, 'pane not accessible from this session')
              return
            }
          } catch {
            reject(res, 503, 'unable to verify pane ownership')
            return
          }
        }
        const lines = parseInt(url.searchParams.get('lines') ?? '500', 10)
        const maxLines = Math.min(Math.max(lines, 100), 50000)
        const source = url.searchParams.get('source') === 'recent_unwrapped' ? 'recent_unwrapped' as const : 'visible' as const
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          const result = await ctx.herdr.paneRead({
            pane_id: paneId,
            source,
            lines: maxLines,
            format: 'ansi',
          })
          res.end(JSON.stringify({
            ok: true,
            text: result.text,
            revision: result.revision,
            truncated: result.truncated,
          }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
    // 终端输出变化长轮询：events.wait(pane_output_changed + min_revision)。
    offTerminalWaitRoute = webServer.register({
      kind: 'exact',
      path: '/herdr-pane-terminal-wait',
      handler: async (req: unknown, res: Res) => {
        if (!guard(res, req, 'GET')) return
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const paneId = url.searchParams.get('pane_id')
        const revisionText = url.searchParams.get('after_revision')
        const afterRevision = revisionText == null ? NaN : Number(revisionText)
        if (!paneId || paneId.trim() === '') {
          reject(res, 400, 'pane_id query parameter is required')
          return
        }
        if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
          reject(res, 400, 'after_revision must be a non-negative integer')
          return
        }
        const boundWsIds = new Set(getBoundWorkspaceIds())
        if (boundWsIds.size > 0) {
          try {
            const snap = await ctx.herdr.snapshot()
            const targetWs = snap.panes.find((p: { pane_id: string }) => p.pane_id === paneId)?.workspace_id
            if (!targetWs || !boundWsIds.has(targetWs)) {
              reject(res, 403, 'pane not accessible from this session')
              return
            }
          } catch {
            reject(res, 503, 'unable to verify pane ownership')
            return
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        try {
          const result = await ctx.herdr.paneWaitForOutputChange({
            pane_id: paneId,
            min_revision: afterRevision,
            timeout_ms: 25_000,
          })
          res.end(JSON.stringify({ ok: true, ...result }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
    })
  })
  tracker.start()
  dashboardTracker.start()

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
      dashboardTracker.stop()
      offAgentState()
      offResourceChanged()
      offRoute?.()
      offBindingRoute?.()
      offPaneSessionRoute?.()
      offStartRoute?.()
      offCloseRoute?.()
      offRenameRoute?.()
      offPaneInputRoute?.()
      offTerminalBootstrapRoute?.()
      offTerminalWaitRoute?.()
      offDashboardRoute?.()
      offTerminalSessionRoutes?.()
      terminalManager?.dispose()
      terminalManager = null
      stopSkill()
      stopForwarding()
      stopReporting()
    }
  })

  ctx.effect(() => {
    createLogger(ctx, 'index').info(
      'plugin loaded! transport=socket timeoutMs=%d allowBackground=%s events=%s',
      config.timeoutMs, config.allowBackground, config.events.enabled,
    )
    return () => createLogger(ctx, 'index').debug('plugin disposed')
  })
}
