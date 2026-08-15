import { createConnection, type Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { HerdrClient } from './index.ts'
import { HerdrCliError } from './cli.ts'
import { pollPaneUntilStable } from './poll.ts'
import type {
  AgentExplainRequest,
  AgentFilter,
  AgentPromptRequest,
  AgentPromptResult,
  AgentSendKeysRequest,
  AgentStatus,
  ClearAgentAuthorityRequest,
  HerdrAgentInfo,
  HerdrSnapshot,
  LayoutApplyRequest,
  NotificationShowRequest,
  PaneLayoutRequest,
  PaneReadRequest,
  PaneSendKeysRequest,
  PaneSplitRequest,
  ReportAgentRequest,
  RunCommandRequest,
  RunCommandResult,
  WaitAgentRequest,
  WaitAgentResult,
  WorkspaceCreateRequest,
} from './index.ts'

export interface SocketAdapterOptions {
  /** 已解析的 socket 路径（resolveSocketPath 输出；POSIX）。 */
  socketPath: string
  timeoutMs: number
}

interface SocketEnvelope {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
  type?: string
}

/**
 * Socket 传输适配器（DESIGN.md §7.2）。
 *
 * 实测协议行为（herdr 0.8.0 / protocol 19）：
 * - **每次请求一个连接**：服务器回复后立即关闭（长连接不存在）；
 * - 仅 events.subscribe 在响应后保持连接并推送订阅事件；
 * - JSONL over Unix domain socket；错误在 error envelope（同 CLI）。
 * Windows named pipe 不支持（走 CLI 适配器，见 resolveSocketPath）。
 */
export class SocketHerdrClient extends HerdrClient {
  /** 订阅长连接（events.subscribe 专用）。 */
  private subSock: Socket | null = null
  private subBuffer = ''
  private readonly eventHandlers = new Set<(event: Record<string, unknown>) => void>()
  private closed = false

  constructor(ctx: Context, private readonly options: SocketAdapterOptions) {
    super(ctx)
  }

  /** 订阅连接是否活跃（事件转发健康检查用）。 */
  get connected(): boolean {
    return this.subSock !== null && !this.closed
  }

  /** 关闭订阅连接（effect 清理与测试用）。 */
  close(): void {
    this.closed = true
    if (this.subSock) {
      this.subSock.destroy()
      this.subSock = null
    }
  }

  // -------------------------------------------------------------------------
  // 服务方法
  // -------------------------------------------------------------------------

  async snapshot(): Promise<HerdrSnapshot> {
    const { result } = await this.callOnce('session.snapshot', {})
    const snapshot = (result as { snapshot?: HerdrSnapshot } | undefined)?.snapshot
    if (!snapshot) throw new HerdrCliError('HERDR_PROTOCOL', 'session.snapshot response missing snapshot')
    return snapshot
  }

  async listAgents(filter?: AgentFilter): Promise<HerdrAgentInfo[]> {
    const { result } = await this.callOnce('agent.list', {})
    const raw = Array.isArray((result as { agents?: unknown } | undefined)?.agents)
      ? (result as { agents: Array<Record<string, unknown>> }).agents
      : []
    // 协议状态字段是 agent_status（env-findings §11）；归一化到 status 便于消费
    const agents = raw.map(a => ({ ...a, status: (a.agent_status ?? a.status) as AgentStatus })) as HerdrAgentInfo[]
    if (!filter) return agents
    return agents.filter(a => {
      if (filter.workspace_id && a.workspace_id !== filter.workspace_id) return false
      if (filter.status && a.status !== filter.status) return false
      return true
    })
  }

  async runCommand(req: RunCommandRequest, signal: AbortSignal): Promise<RunCommandResult> {
    let paneId = req.pane_id
    if (!paneId) {
      const { result } = await this.callOnce('pane.split', {
        direction: req.direction ?? 'right',
        ratio: req.ratio ?? null,
        cwd: req.cwd ?? null,
        env: req.env ?? undefined,
        target_pane_id: req.pane_id ?? null,
        workspace_id: req.workspace_id ?? null,
      })
      const pane = (result as { pane?: { pane_id?: string } } | undefined)?.pane
      if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
      paneId = pane.pane_id
    }
    // 发送前记录 pane 快照基线（用于裁剪终端历史噪音）
    let baseline = ''
    try {
      baseline = await this.readPaneText(paneId)
    } catch {
      // 新 pane 可能尚未就绪；读不到基线则不裁剪
    }
    // 发送命令文本 + 回车执行（send_text 原样发送；POSIX shell 用 \n）
    await this.callOnce('pane.send_text', { pane_id: paneId, text: req.command + '\n' })
    const { output, timedOut } = await pollPaneUntilStable(
      id => this.readPaneText(id),
      paneId,
      req.wait_ms ?? this.options.timeoutMs,
      signal,
      { baseline },
    )
    return { kind: 'completed', pane_id: paneId, exit_code: null, output, truncated: false, timed_out: timedOut }
  }

  async waitAgent(req: WaitAgentRequest, signal: AbortSignal): Promise<WaitAgentResult> {
    const start = Date.now()
    const timeoutMs = req.timeout_ms ?? this.options.timeoutMs
    try {
      const { result } = await this.callOnce('agent.wait', {
        target: req.target,
        until: req.until,
        timeout_ms: timeoutMs,
      }, { timeoutMs: timeoutMs + 10_000, signal })
      const res = (result ?? {}) as { status?: string; agent?: string; message?: string | null }
      return {
        kind: 'completed',
        status: (res.status ?? req.until[0]) as AgentStatus,
        agent: res.agent,
        message: res.message ?? undefined,
        waited_ms: Date.now() - start,
      }
    } catch (err) {
      if (err instanceof HerdrCliError && err.code === 'HERDR_ERROR') {
        const msg = err.message
        if (/agent_not_found|not found/i.test(msg)) return { kind: 'not_found', target: req.target }
        if (/timeout/i.test(msg)) return { kind: 'timeout', waited_ms: Date.now() - start }
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // 扩展方法（M2-05/06）
  // -------------------------------------------------------------------------

  async workspaceCreate(req: WorkspaceCreateRequest): Promise<{ workspace_id: string; pane_id?: string }> {
    const { result } = await this.callOnce('workspace.create', { cwd: req.cwd ?? null, label: req.label ?? null, env: req.env ?? undefined })
    const res = (result ?? {}) as { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } }
    if (!res.workspace?.workspace_id) throw new HerdrCliError('HERDR_PROTOCOL', 'workspace.create response missing workspace_id')
    return {
      workspace_id: res.workspace.workspace_id,
      ...res.root_pane?.pane_id ? { pane_id: res.root_pane.pane_id } : {},
    }
  }

  async paneSplit(req: PaneSplitRequest): Promise<{ pane_id: string }> {
    const { result } = await this.callOnce('pane.split', {
      direction: req.direction,
      ratio: req.ratio ?? null,
      cwd: req.cwd ?? null,
      env: req.env ?? undefined,
      target_pane_id: req.pane_id ?? null,
      workspace_id: req.workspace_id ?? null,
    })
    const pane = (result as { pane?: { pane_id?: string } } | undefined)?.pane
    if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
    return { pane_id: pane.pane_id }
  }

  async paneClose(paneId: string): Promise<void> {
    await this.callOnce('pane.close', { pane_id: paneId })
  }

  async paneSendKeys(req: PaneSendKeysRequest): Promise<void> {
    await this.callOnce('pane.send_keys', { pane_id: req.pane_id, keys: req.keys })
  }

  async paneRead(req: PaneReadRequest): Promise<{ text: string }> {
    const { result } = await this.callOnce('pane.read', {
      pane_id: req.pane_id,
      source: req.source ?? 'recent',
      lines: req.lines ?? null,
      format: req.format ?? 'text',
    })
    // 响应结构：{ type: 'pane_read', read: { text, ... } }
    return { text: (result as { read?: { text?: string } } | undefined)?.read?.text ?? '' }
  }

  async paneLayout(req: PaneLayoutRequest): Promise<unknown> {
    const { result } = await this.callOnce('pane.layout', { pane_id: req.pane_id ?? null })
    return result
  }

  async layoutApply(req: LayoutApplyRequest): Promise<unknown> {
    const { result } = await this.callOnce('layout.apply', {
      root: req.root,
      workspace_id: req.workspace_id ?? null,
      tab_id: req.tab_id ?? null,
      tab_label: req.tab_label ?? null,
      focus: req.focus ?? false,
    })
    return result
  }

  async agentPrompt(req: AgentPromptRequest, signal: AbortSignal): Promise<AgentPromptResult> {
    const start = Date.now()
    const { result } = await this.callOnce('agent.prompt', {
      target: req.target,
      text: req.text,
      wait: req.wait
        ? { until: req.until ?? null, timeout_ms: req.timeout_ms ?? null }
        : null,
    }, { signal })
    // 协议 envelope：状态在 result.agent.agent_status
    const res = (result ?? {}) as { agent?: { agent_status?: string } }
    const status = res.agent?.agent_status
    return {
      submitted: true,
      ...status !== undefined ? { status } : {},
      ...req.wait ? { waited_ms: Date.now() - start } : {},
    }
  }

  async agentExplain(req: AgentExplainRequest): Promise<unknown> {
    const { result } = await this.callOnce('agent.explain', { target: req.target ?? null })
    return result
  }

  async agentSendKeys(req: AgentSendKeysRequest): Promise<void> {
    await this.callOnce('agent.send_keys', { target: req.target, keys: req.keys })
  }

  async showNotification(req: NotificationShowRequest): Promise<void> {
    await this.callOnce('notification.show', {
      title: req.title,
      body: req.body ?? null,
      position: req.position ?? null,
      sound: req.sound ?? 'none',
    })
  }

  async reportAgent(req: ReportAgentRequest): Promise<void> {
    await this.callOnce('pane.report_agent', {
      pane_id: req.pane_id,
      source: req.source,
      agent: req.agent,
      state: req.state,
      message: req.message ?? null,
    })
  }

  async clearAgentAuthority(req: ClearAgentAuthorityRequest): Promise<void> {
    await this.callOnce('pane.clear_agent_authority', {
      pane_id: req.pane_id,
      source: req.source ?? null,
    })
  }

  // -------------------------------------------------------------------------
  // 事件订阅（M2-04 使用）：专用长连接
  // -------------------------------------------------------------------------

  /** 注册订阅事件处理器；返回退订函数。 */
  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** 订阅 Herdr 事件：建立长连接，响应后保持打开并推送订阅事件。已订阅时重建连接（支持动态增订）。 */
  async subscribe(subscriptions: Array<{ type: string }>): Promise<void> {
    if (this.closed) throw new HerdrCliError('HERDR_UNAVAILABLE', 'socket client is closed')
    if (this.subSock) {
      // 重新订阅：销毁旧连接（服务端会推送旧订阅的事件到已关闭连接，无泄漏）
      this.subSock.destroy()
      this.subSock = null
      this.subBuffer = ''
    }
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.options.socketPath)
      this.subSock = sock
      sock.setEncoding('utf8')
      let responded = false
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: 'sub_1', method: 'events.subscribe', params: { subscriptions } }) + '\n')
      })
      sock.on('data', (chunk: string | Buffer) => {
        this.subBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let idx: number
        while ((idx = this.subBuffer.indexOf('\n')) >= 0) {
          const line = this.subBuffer.slice(0, idx)
          this.subBuffer = this.subBuffer.slice(idx + 1)
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: SocketEnvelope
          try {
            parsed = JSON.parse(trimmed) as SocketEnvelope
          } catch {
            continue
          }
          if (parsed.id && !responded) {
            responded = true
            if (parsed.error) {
              reject(new HerdrCliError('HERDR_ERROR', `${parsed.error.code ?? 'unknown'}: ${parsed.error.message ?? ''}`))
            } else {
              resolve()
            }
            continue
          }
          if (!parsed.id) {
            for (const handler of this.eventHandlers) {
              try { handler(parsed as Record<string, unknown>) } catch { /* 处理器容错 */ }
            }
          }
        }
      })
      sock.on('error', (err: NodeJS.ErrnoException) => {
        if (!responded) {
          responded = true
          this.subSock = null
          const message = err.code === 'ENOENT'
            ? `herdr socket not found: '${this.options.socketPath}' (is the herdr server running?)`
            : `failed to connect to herdr socket: ${err.message}`
          reject(new HerdrCliError('HERDR_UNAVAILABLE', message))
        }
      })
      sock.on('close', () => {
        this.subSock = null
      })
    })
  }

  // -------------------------------------------------------------------------
  // 内部：一次性请求
  // -------------------------------------------------------------------------

  // 读取 scrollback（recent 快照）：visible 只是当前视口（新输出会顶掉旧行），
  // recent 返回完整历史，配合 runCommand 的基线裁剪可拿到干净的"本次命令输出"。
  private async readPaneText(paneId: string): Promise<string> {
    const { result } = await this.callOnce('pane.read', { pane_id: paneId, source: 'recent', lines: 500 })
    // 响应结构：{ type: 'pane_read', read: { text, ... } }
    return (result as { read?: { text?: string } } | undefined)?.read?.text ?? ''
  }

  /** 一次性请求-响应调用（服务器每个连接只服务一个请求后关闭）。 */
  private callOnce(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ result?: unknown; error?: { code?: string; message?: string } }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs
      const sock = createConnection(this.options.socketPath)
      sock.setEncoding('utf8')
      let buf = ''
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        fn()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new HerdrCliError('HERDR_TIMEOUT', `herdr ${method} timed out after ${timeoutMs}ms`)))
      }, timeoutMs)
      const onAbort = () => {
        finish(() => reject(new HerdrCliError('HERDR_ABORTED', 'call aborted')))
      }
      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      sock.on('connect', () => {
        if (settled) return
        sock.write(JSON.stringify({ id: 'req_1', method, params }) + '\n')
      })
      sock.on('data', (chunk: string | Buffer) => {
        if (settled) return
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: SocketEnvelope
          try {
            parsed = JSON.parse(trimmed) as SocketEnvelope
          } catch {
            continue
          }
          if (!parsed.id || parsed.id !== 'req_1') continue
          finish(() => {
            if (opts.signal) opts.signal!.removeEventListener('abort', onAbort)
            if (parsed.error) {
              reject(new HerdrCliError('HERDR_ERROR', `${parsed.error.code ?? 'unknown'}: ${parsed.error.message ?? ''}`))
            } else {
              resolve({ result: parsed.result })
            }
          })
          return
        }
      })
      sock.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (opts.signal) opts.signal!.removeEventListener('abort', onAbort)
          const message = err.code === 'ENOENT'
            ? `herdr socket not found: '${this.options.socketPath}' (is the herdr server running?)`
            : `failed to connect to herdr socket: ${err.message}`
          reject(new HerdrCliError('HERDR_UNAVAILABLE', message))
        })
      })
      sock.on('close', () => {
        finish(() => {
          if (opts.signal) opts.signal!.removeEventListener('abort', onAbort)
          reject(new HerdrCliError('HERDR_UNAVAILABLE', 'socket closed before response'))
        })
      })
    })
  }
}
