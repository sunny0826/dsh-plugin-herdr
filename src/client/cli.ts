import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { HerdrClient } from './index.ts'
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

/**
 * CLI 调用失败（连接/环境/协议类错误，工具层应抛错；业务性失败由规范值表达）。
 */
export class HerdrCliError extends Error {
  readonly code: 'HERDR_UNAVAILABLE' | 'HERDR_PROTOCOL' | 'HERDR_ERROR' | 'HERDR_TIMEOUT' | 'HERDR_ABORTED'

  constructor(
    code: 'HERDR_UNAVAILABLE' | 'HERDR_PROTOCOL' | 'HERDR_ERROR' | 'HERDR_TIMEOUT' | 'HERDR_ABORTED',
    message: string,
  ) {
    super(message)
    this.name = 'HerdrCliError'
    this.code = code
  }
}

export interface CliAdapterOptions {
  /** 解析后的 cliPath（resolveCliPath 输出）。 */
  cliPath: string
  /** 解析后的会话名；非空时每个命令追加 --session。 */
  session?: string
  /** 单次同步请求默认超时（ms）。 */
  timeoutMs: number
}

interface CliEnvelope {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

/**
 * CLI 传输适配器（DESIGN.md §7.1）。
 *
 * 实测行为（herdr 0.8.0，见 docs/env-findings.md）：
 * - 多数命令输出 JSON envelope {id, result} | {id, error}；出错时进程退出码仍为 0，
 *   必须以 envelope 的 error 字段为准；
 * - pane read 输出纯文本（非 envelope）；
 * - pane run 为异步执行，无输出。
 */
/** spawn 工厂类型（测试可注入 fake）。 */
export type SpawnFn = typeof nodeSpawn

export class CliHerdrClient extends HerdrClient {
  private readonly options: CliAdapterOptions
  private readonly spawnImpl: SpawnFn

  constructor(ctx: Context, options: CliAdapterOptions, spawnImpl: SpawnFn = nodeSpawn) {
    super(ctx)
    this.options = options
    this.spawnImpl = spawnImpl
  }

  // -------------------------------------------------------------------------
  // 服务方法
  // -------------------------------------------------------------------------

  async snapshot(): Promise<HerdrSnapshot> {
    const { result } = await this.runCli(['api', 'snapshot'], { retryRead: true })
    const snapshot = (result as { snapshot?: HerdrSnapshot } | undefined)?.snapshot
    if (!snapshot) throw new HerdrCliError('HERDR_PROTOCOL', 'session.snapshot response missing snapshot')
    return snapshot
  }

  async listAgents(filter?: AgentFilter): Promise<HerdrAgentInfo[]> {
    const { result } = await this.runCli(['agent', 'list'], { retryRead: true })
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
    // 1) 确定目标 pane：复用或新建 split
    let paneId = req.pane_id
    if (!paneId) {
      const args: string[] = ['pane', 'split']
      if (req.workspace_id) args.push(req.workspace_id)
      args.push('--direction', req.direction ?? 'right')
      if (req.ratio != null) args.push('--ratio', String(req.ratio))
      if (req.cwd) args.push('--cwd', req.cwd)
      for (const [k, v] of Object.entries(req.env ?? {})) args.push('--env', `${k}=${v}`)
      const { result } = await this.runCli(args)
      const pane = (result as { pane?: { pane_id?: string } } | undefined)?.pane
      if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
      paneId = pane.pane_id
    }

    // 2) 执行命令前记录 pane 快照基线（用于裁剪终端历史噪音）
    let baseline = ''
    try {
      baseline = await this.readPaneVisible(paneId)
    } catch {
      // 新 pane 可能尚未就绪；读不到基线则不裁剪
    }

    // 3) 执行命令：sh -c 包装（argv 语义；POSIX。Windows 留待后续）
    //    pane run 异步执行且无 stdout，按纯文本处理
    await this.runCli(['pane', 'run', paneId, 'sh', '-c', req.command], { rawText: true })

    // 4) 前台轮询输出稳定（共享逻辑，CLI 与 socket 传输一致；基线裁剪历史）
    const { output, timedOut } = await pollPaneUntilStable(
      id => this.readPaneVisible(id),
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
    const args = [
      'agent', 'wait', req.target,
      ...req.until.flatMap(s => ['--until', s]),
      '--timeout', String(timeoutMs),
    ]
    const { result, error } = await this.runCli(args, { signal, spawnTimeoutMs: timeoutMs + 10_000 })
    if (error) {
      if (error.code === 'agent_not_found') return { kind: 'not_found', target: req.target }
      if (error.code === 'timeout' || /timeout/i.test(error.message ?? '')) {
        return { kind: 'timeout', waited_ms: Date.now() - start }
      }
      throw new HerdrCliError('HERDR_ERROR', `agent.wait failed: ${error.code ?? 'unknown'}: ${error.message ?? ''}`)
    }
    // 成功路径（result 形状以 herdr api schema 为准，宽松解析）
    const res = (result ?? {}) as { status?: string; agent?: string; message?: string | null }
    return {
      kind: 'completed',
      status: (res.status ?? req.until[0]) as AgentStatus,
      agent: res.agent,
      message: res.message ?? undefined,
      waited_ms: Date.now() - start,
    }
  }

  // -------------------------------------------------------------------------
  // 扩展方法（M2-05/06）
  // -------------------------------------------------------------------------

  async workspaceCreate(req: WorkspaceCreateRequest): Promise<{ workspace_id: string; pane_id?: string }> {
    const args = ['workspace', 'create']
    if (req.cwd) args.push('--cwd', req.cwd)
    if (req.label) args.push('--label', req.label)
    for (const [k, v] of Object.entries(req.env ?? {})) args.push('--env', `${k}=${v}`)
    const { result } = await this.runCli(args)
    const res = (result ?? {}) as { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } }
    if (!res.workspace?.workspace_id) throw new HerdrCliError('HERDR_PROTOCOL', 'workspace.create response missing workspace_id')
    return {
      workspace_id: res.workspace.workspace_id,
      ...res.root_pane?.pane_id ? { pane_id: res.root_pane.pane_id } : {},
    }
  }

  async paneSplit(req: PaneSplitRequest): Promise<{ pane_id: string }> {
    const args: string[] = ['pane', 'split']
    // CLI 分裂目标：pane_id 位置参数（workspace_id 无法表达，忽略并记录）
    if (req.pane_id) args.push(req.pane_id)
    args.push('--direction', req.direction)
    if (req.ratio != null) args.push('--ratio', String(req.ratio))
    if (req.cwd) args.push('--cwd', req.cwd)
    for (const [k, v] of Object.entries(req.env ?? {})) args.push('--env', `${k}=${v}`)
    const { result } = await this.runCli(args)
    const pane = (result as { pane?: { pane_id?: string } } | undefined)?.pane
    if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
    return { pane_id: pane.pane_id }
  }

  async paneClose(paneId: string): Promise<void> {
    await this.runCli(['pane', 'close', paneId], { rawText: true })
  }

  async paneSendKeys(req: PaneSendKeysRequest): Promise<void> {
    await this.runCli(['pane', 'send-keys', req.pane_id, ...req.keys], { rawText: true })
  }

  async paneRead(req: PaneReadRequest): Promise<{ text: string }> {
    const args = ['pane', 'read', req.pane_id]
    if (req.source) args.push('--source', req.source)
    if (req.lines != null) args.push('--lines', String(req.lines))
    if (req.format) args.push('--format', req.format)
    const { text } = await this.runCli(args, { rawText: true })
    return { text }
  }

  async paneLayout(req: PaneLayoutRequest): Promise<unknown> {
    const args = ['pane', 'layout']
    if (req.pane_id) args.push('--pane', req.pane_id)
    else args.push('--current')
    const { result } = await this.runCli(args)
    return result
  }

  async layoutApply(_req: LayoutApplyRequest): Promise<unknown> {
    // layout.apply 只有 raw socket 方法；CLI 无对应子命令
    throw new HerdrCliError('HERDR_ERROR', 'layout.apply requires the socket transport (herdr layout CLI command does not exist)')
  }

  async agentPrompt(req: AgentPromptRequest, signal: AbortSignal): Promise<AgentPromptResult> {
    const start = Date.now()
    const args = ['agent', 'prompt', req.target, req.text]
    if (req.wait) {
      args.push('--wait')
      for (const s of req.until ?? []) args.push('--until', s)
      if (req.timeout_ms != null) args.push('--timeout', String(req.timeout_ms))
    }
    const { result, error } = await this.runCli(args, { signal })
    if (error) {
      throw new HerdrCliError('HERDR_ERROR', `agent.prompt failed: ${error.code ?? 'unknown'}: ${error.message ?? ''}`)
    }
    // CLI envelope：状态在 result.agent.agent_status（顶层没有 status/message）
    const res = (result ?? {}) as { agent?: { agent_status?: string } }
    const status = res.agent?.agent_status
    return {
      submitted: true,
      ...status !== undefined ? { status } : {},
      ...req.wait ? { waited_ms: Date.now() - start } : {},
    }
  }

  async agentExplain(req: AgentExplainRequest): Promise<unknown> {
    const args = ['agent', 'explain']
    if (req.target) args.push(req.target)
    args.push('--json')
    const { result } = await this.runCli(args)
    return result ?? {}
  }

  async agentSendKeys(req: AgentSendKeysRequest): Promise<void> {
    await this.runCli(['agent', 'send-keys', req.target, ...req.keys], { rawText: true })
  }

  async showNotification(req: NotificationShowRequest): Promise<void> {
    const args = ['notification', 'show', req.title]
    if (req.body) args.push('--body', req.body)
    if (req.position) args.push('--position', req.position)
    if (req.sound) args.push('--sound', req.sound)
    await this.runCli(args, { rawText: true })
  }

  async reportAgent(req: ReportAgentRequest): Promise<void> {
    const args = ['pane', 'report-agent', req.pane_id, '--source', req.source, '--agent', req.agent, '--state', req.state]
    if (req.message) args.push('--message', req.message)
    await this.runCli(args, { rawText: true })
  }

  async clearAgentAuthority(req: ClearAgentAuthorityRequest): Promise<void> {
    if (!req.agent) throw new HerdrCliError('HERDR_ERROR', 'release-agent requires the agent name')
    const args = ['pane', 'release-agent', req.pane_id, '--agent', req.agent]
    if (req.source) args.push('--source', req.source)
    await this.runCli(args, { rawText: true })
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private parseEnvelope(raw: string): CliEnvelope | undefined {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    try {
      const parsed = JSON.parse(trimmed) as CliEnvelope
      return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  // 读取 scrollback（recent 快照）：visible 只是当前视口（新输出会顶掉旧行），
  // recent 返回完整历史，配合 runCommand 的基线裁剪可拿到干净的"本次命令输出"。
  private async readPaneVisible(paneId: string): Promise<string> {
    const { text } = await this.runCli(['pane', 'read', paneId, '--source', 'recent', '--lines', '500'], { rawText: true })
    return text
  }

  /** 执行 CLI 并解析 envelope（或 rawText 纯文本）。 */
  private async runCli(
    args: string[],
    opts: { signal?: AbortSignal; spawnTimeoutMs?: number; retryRead?: boolean; rawText?: boolean } = {},
  ): Promise<{ result?: unknown; error?: { code?: string; message?: string }; text: string }> {
    const attempt = async (): Promise<{ result?: unknown; error?: { code?: string; message?: string }; text: string }> => {
      const out = await this.spawnOnce(args, opts)
      if (opts.rawText) return { text: out.stdout }
      // 部分错误（如不存在的 pane）把 envelope 输出到 stderr；stdout 为空时回退解析 stderr
      const parsed = this.parseEnvelope(out.stdout) ?? this.parseEnvelope(out.stderr)
      if (!parsed) {
        throw new HerdrCliError(
          'HERDR_PROTOCOL',
          `unparseable CLI output for 'herdr ${args.join(' ')}': stdout=${out.stdout.slice(0, 200)} stderr=${out.stderr.slice(0, 200)}`,
        )
      }
      if (parsed.error) return { error: parsed.error, text: out.stdout || out.stderr }
      return { result: parsed.result, text: out.stdout || out.stderr }
    }
    try {
      return await attempt()
    } catch (err) {
      // 幂等读方法在"请求发出前"失败时重试 1 次（§11.2）
      if (opts.retryRead && err instanceof HerdrCliError && err.code === 'HERDR_UNAVAILABLE') {
        await sleep(300)
        return await attempt()
      }
      throw err
    }
  }

  private spawnOnce(
    args: string[],
    opts: { signal?: AbortSignal; spawnTimeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const full = [this.options.cliPath, ...(this.options.session ? ['--session', this.options.session] : []), ...args]
      let child
      try {
        child = this.spawnImpl(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(new HerdrCliError('HERDR_UNAVAILABLE', `failed to spawn '${full[0]}': ${(err as Error).message}`))
        return
      }
      let stdout = ''
      let stderr = ''
      const outStream = child.stdout as NodeJS.ReadableStream | null
      const errStream = child.stderr as NodeJS.ReadableStream | null
      let settled = false
      const timer = opts.spawnTimeoutMs
        ? setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGKILL')
            reject(new HerdrCliError('HERDR_TIMEOUT', `herdr ${args[0]} timed out after ${opts.spawnTimeoutMs}ms`))
          }, opts.spawnTimeoutMs)
        : undefined
      const finish = (code: number | null, sig: string | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (code === null && sig === 'SIGKILL' && timer) {
          // 已由超时分支 reject；此处仅防重复
          return
        }
        resolve({ stdout, stderr, exitCode: code })
      }
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (err.code === 'ENOENT') {
          reject(new HerdrCliError('HERDR_UNAVAILABLE', `herdr CLI not found: '${full[0]}' (check config cliPath / HERDR_BIN_PATH)`))
        } else {
          reject(new HerdrCliError('HERDR_UNAVAILABLE', `failed to run '${full[0]}': ${err.message}`))
        }
      })
      outStream?.on('data', (d: Buffer | string) => { stdout += String(d) })
      errStream?.on('data', (d: Buffer | string) => { stderr += String(d) })
      child.on('close', (code, sig) => finish(code, sig))
    })
  }
}
