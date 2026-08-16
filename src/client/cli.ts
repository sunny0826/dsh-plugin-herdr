import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { HerdrClient } from './index.ts'
import { pollPaneUntilStable } from './poll.ts'
import type { HerdrResultMap } from './types.ts'
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
  ReportMetadataRequest,
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

/** CA-002：单条 CLI 流（stdout/stderr）的固定累积上限；超过即截断并报告 truncated。 */
export const MAX_CLI_OUTPUT_BYTES = 1024 * 1024

/**
 * CR P2：按 UTF-8 字节预算截断字符串，保证结果不超过 maxBytes。
 * 直接 Buffer.subarray+toString 在切点落在多字节字符中间时会产生 U+FFFD 替换符
 * （3 字节），可能超出预算——这里解码后回退到有效边界。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  let out = Buffer.from(text).subarray(0, maxBytes).toString('utf8')
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, -1)
  return out
}

/**
 * CA-002：终止 CLI 子进程及其进程树。
 * - POSIX：子进程以 detached 方式 spawn 成为进程组 leader，负 pid 可对整个组发信号，
 *   保证 sh -c 包装出的 shell 后代（pane run 的 COMMAND 等）不会残留；
 * - Windows：策略明确为“仅终止直接子进程”（CLI 传输本身仅支持 POSIX sh -c；
 *   如需整树终止可改用 taskkill /T /F，当前不实现）。
 */
export function killProcessTree(child: ChildProcess, killGroup = process.platform !== 'win32'): void {
  try { child.kill('SIGKILL') } catch { /* 已退出/不可杀 */ }
  if (killGroup && child.pid != null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 组已不存在（ESRCH） */ }
  }
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
    // CA-004：由 fixture 生成的 session_snapshot 分支类型替代宽松强转；
    // agents 仍归一化 status（协议字段 agent_status → 领域 status）
    const raw = (result as HerdrResultMap['session.snapshot'] | undefined)?.snapshot
    if (!raw) throw new HerdrCliError('HERDR_PROTOCOL', 'session.snapshot response missing snapshot')
    const agents = raw.agents.map(a => ({
      ...a,
      status: (a.agent_status ?? (a as unknown as { status?: AgentStatus }).status ?? 'unknown') as AgentStatus,
    })) as HerdrAgentInfo[]
    return { ...raw, agents } as HerdrSnapshot
  }

  async listAgents(filter?: AgentFilter): Promise<HerdrAgentInfo[]> {
    const { result } = await this.runCli(['agent', 'list'], { retryRead: true })
    // CA-004：agent_list 分支由 fixture 生成；status 归一化仍保留（协议字段 agent_status）
    const raw = (result as HerdrResultMap['agent.list'] | undefined)?.agents ?? []
    const agents = raw.map(a => ({
      ...a,
      status: (a.agent_status ?? (a as unknown as { status?: AgentStatus }).status ?? 'unknown') as AgentStatus,
    })) as HerdrAgentInfo[]
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
      const { result } = await this.runCli(args, { signal })
      const pane = (result as HerdrResultMap['pane.split'] | undefined)?.pane
      if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
      paneId = pane.pane_id
    }

    // 2) 执行命令前记录 pane 快照基线（用于裁剪终端历史噪音）
    let baseline = ''
    try {
      baseline = (await this.readPaneVisible(paneId)).text
    } catch {
      // 新 pane 可能尚未就绪；读不到基线则不裁剪
    }

    // 3) 执行命令：sh -c 包装（argv 语义；POSIX。Windows 留待后续）
    //    pane run 异步执行且无 stdout，按纯文本处理；abort 时终止 CLI 子进程（CA-001）
    await this.runCli(['pane', 'run', paneId, 'sh', '-c', req.command], { rawText: true, signal })

    // 4) 前台轮询输出稳定（共享逻辑，CLI 与 socket 传输一致；基线裁剪历史）
    //    CA-002：任一轮 pane read 被截断（超过 MAX_CLI_OUTPUT_BYTES）都如实上报 truncated
    let truncated = false
    const readPane = async (id: string): Promise<string> => {
      const r = await this.readPaneVisible(id)
      if (r.truncated) truncated = true
      return r.text
    }
    const { output, status } = await pollPaneUntilStable(
      readPane,
      paneId,
      req.wait_ms ?? this.options.timeoutMs,
      signal,
      { baseline },
    )
    // CA-011：轮询期取消不是超时——以 HERDR_ABORTED 抛出（工具层转错误/取消语义）
    if (status === 'aborted') {
      throw new HerdrCliError('HERDR_ABORTED', 'runCommand aborted while waiting for pane output')
    }
    return { kind: 'completed', pane_id: paneId, exit_code: null, output, truncated, timed_out: status === 'timed_out' }
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
    // 成功路径：实测 CLI/raw socket 均返回 agent_info 分支（{ agent: AgentInfo, type: 'agent_info' }），
    // 状态字段为 agent.agent_status（CA-004 由 fixture 生成类型，替换宽松强转）
    const res = result as HerdrResultMap['agent.wait'] | undefined
    const agent = res?.agent
    return {
      kind: 'completed',
      status: (agent?.agent_status ?? req.until[0]) as AgentStatus,
      agent: agent?.agent ?? agent?.name ?? undefined,
      pane_id: agent?.pane_id ?? undefined,
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
    const res = result as HerdrResultMap['workspace.create'] | undefined
    if (!res?.workspace?.workspace_id) throw new HerdrCliError('HERDR_PROTOCOL', 'workspace.create response missing workspace_id')
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
    const pane = (result as HerdrResultMap['pane.split'] | undefined)?.pane
    if (!pane?.pane_id) throw new HerdrCliError('HERDR_PROTOCOL', 'pane.split response missing pane_id')
    return { pane_id: pane.pane_id }
  }

  async paneClose(paneId: string): Promise<void> {
    await this.closeOrFail('pane close', ['pane', 'close', paneId])
  }

  async workspaceClose(workspaceId: string): Promise<void> {
    await this.closeOrFail('workspace close', ['workspace', 'close', workspaceId])
  }

  async workspaceRename(workspaceId: string, label: string): Promise<void> {
    // T01-D：多词标签由 CLI 把 LABEL... 位置参数 join 空格；拆参传递与实测一致
    await this.runCli(['workspace', 'rename', workspaceId, ...label.split(/\s+/)])
  }

  async paneRename(paneId: string, label: string | null): Promise<void> {
    // 实测（env-findings v2 关键坑）：--clear 必须在 pane_id 之后且 pane_id 不可省略；
    // 空 label（null/空白）→ --clear；否则把单词拆为位置参数（CLI join 空格）
    const args = ['pane', 'rename', paneId]
    if (label == null || label.trim() === '') args.push('--clear')
    else args.push(...label.split(/\s+/))
    await this.runCli(args)
  }

  async paneSendKeys(req: PaneSendKeysRequest): Promise<void> {
    await this.runCli(['pane', 'send-keys', req.pane_id, ...req.keys], { rawText: true })
  }

  async paneRead(req: PaneReadRequest): Promise<{ text: string; truncated: boolean }> {
    const args = ['pane', 'read', req.pane_id]
    if (req.source) args.push('--source', req.source)
    if (req.lines != null) args.push('--lines', String(req.lines))
    if (req.format) args.push('--format', req.format)
    const { text, truncated } = await this.runCli(args, { rawText: true })
    return { text, truncated }
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
    // CLI envelope：状态在 result.agent.agent_status（agent_prompted 分支，CA-004 生成类型）
    const res = result as HerdrResultMap['agent.prompt'] | undefined
    const status = res?.agent?.agent_status
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

  async reportMetadata(req: ReportMetadataRequest): Promise<void> {
    // CA-006 M3-03：herdr pane report-metadata（display-only；ttl_ms 控制过期）
    const args = ['pane', 'report-metadata', req.pane_id, '--source', req.source]
    if (req.agent) args.push('--agent', req.agent)
    if (req.title) args.push('--title', req.title)
    for (const [k, v] of Object.entries(req.tokens ?? {})) {
      if (v !== null && v !== undefined) args.push('--token', `${k}=${v}`)
    }
    if (req.ttl_ms != null) args.push('--ttl-ms', String(req.ttl_ms))
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

  /**
   * 执行 close 类命令（envelope 模式而非 rawText）。
   * T01-E/F：close 成功 stdout 有 result envelope、exit 0；错误时 exit 1 + error envelope 在 stdout。
   * envelope 模式才能把 pane_not_found / workspace_not_found 业务错误码带给工具层
   * （rawText 非零退出会抛泛化 HERDR_ERROR 丢失错误码）。
   */
  private async closeOrFail(cmd: string, args: string[]): Promise<void> {
    const { error } = await this.runCli(args)
    if (error) {
      throw new HerdrCliError('HERDR_ERROR', `${cmd} failed: ${error.code ?? 'unknown'}: ${error.message ?? ''}`)
    }
  }

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
  // CA-002：同时返回截断标志（超过 MAX_CLI_OUTPUT_BYTES）。
  private async readPaneVisible(paneId: string): Promise<{ text: string; truncated: boolean }> {
    const { text, truncated } = await this.runCli(['pane', 'read', paneId, '--source', 'recent', '--lines', '500'], { rawText: true })
    return { text, truncated }
  }

  /** 执行 CLI 并解析 envelope（或 rawText 纯文本）。 */
  private async runCli(
    args: string[],
    opts: { signal?: AbortSignal; spawnTimeoutMs?: number; retryRead?: boolean; rawText?: boolean } = {},
  ): Promise<{ result?: unknown; error?: { code?: string; message?: string }; text: string; truncated: boolean }> {
    // CA-001：每次调用默认使用配置 timeout（显式 spawnTimeoutMs 优先）。
    const spawnOpts = { ...opts, spawnTimeoutMs: opts.spawnTimeoutMs ?? this.options.timeoutMs }
    const attempt = async (): Promise<{ result?: unknown; error?: { code?: string; message?: string }; text: string; truncated: boolean }> => {
      const out = await this.spawnOnce(args, spawnOpts)
      // CA-002：stdout/stderr 任一流超限即整体标记 truncated
      const truncated = out.stdoutTruncated || out.stderrTruncated
      // CA-001：非零退出码（exitCode === null 表示被信号杀死）映射为稳定错误。
      // 实测多数 CLI 错误 exit 0 且带 error envelope（env-findings §8.1），
      // 但部分错误（不存在的 pane 等）exit 1（§8.2）——此前被当作成功，
      // 导致 pane close/send-keys/run、notification 等失败时仍向工具层报告成功。
      const failed = out.exitCode !== 0
      if (opts.rawText) {
        if (failed) {
          const parsed = this.parseEnvelope(out.stderr)
          const detail = parsed?.error?.message ?? (out.stderr || out.stdout).slice(0, 200)
          throw new HerdrCliError('HERDR_ERROR', `herdr ${args.join(' ')} failed (exit ${out.exitCode ?? 'killed'}): ${detail}`)
        }
        return { text: out.stdout, truncated }
      }
      // 部分错误（如不存在的 pane）把 envelope 输出到 stderr；stdout 为空时回退解析 stderr
      const parsed = this.parseEnvelope(out.stdout) ?? this.parseEnvelope(out.stderr)
      if (!parsed) {
        const code = failed ? 'HERDR_ERROR' : 'HERDR_PROTOCOL'
        throw new HerdrCliError(
          code,
          `unparseable CLI output for 'herdr ${args.join(' ')}'${failed ? ` (exit ${out.exitCode ?? 'killed'})` : ''}: stdout=${out.stdout.slice(0, 200)} stderr=${out.stderr.slice(0, 200)}`,
        )
      }
      if (parsed.error) return { error: parsed.error, text: out.stdout || out.stderr, truncated }
      if (failed) {
        // envelope 有 result 但进程非零退出：退出码权威性更高，仍报稳定错误
        throw new HerdrCliError('HERDR_ERROR', `herdr ${args.join(' ')} exited with code ${out.exitCode} despite a result envelope`)
      }
      return { result: parsed.result, text: out.stdout || out.stderr, truncated }
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    return new Promise((resolve, reject) => {
      const full = [this.options.cliPath, ...(this.options.session ? ['--session', this.options.session] : []), ...args]
      const timeoutMs = opts.spawnTimeoutMs ?? this.options.timeoutMs
      // CA-001：调用前已 abort → 直接返回 HERDR_ABORTED，不启动子进程
      if (opts.signal?.aborted) {
        reject(new HerdrCliError('HERDR_ABORTED', `herdr ${args[0]} aborted before spawn`))
        return
      }
      // CA-002：POSIX 下 detached spawn 让子进程成为独立进程组 leader，
      // 超时/abort 时可 kill 整个进程树（sh -c 包装的 pane run 等不会残留）；
      // Windows 策略：独立 console（windowsHide 隐藏），仅终止直接子进程。
      const isPosix = process.platform !== 'win32'
      let child
      try {
        child = this.spawnImpl(full[0], full.slice(1), {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: isPosix,
          windowsHide: true,
        })
      } catch (err) {
        reject(new HerdrCliError('HERDR_UNAVAILABLE', `failed to spawn '${full[0]}': ${(err as Error).message}`))
        return
      }
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutTruncated = false
      let stderrTruncated = false
      const outStream = child.stdout as NodeJS.ReadableStream | null
      const errStream = child.stderr as NodeJS.ReadableStream | null
      let settled = false
      // CA-001：所有结束路径统一清理 abort 监听器与超时 timer（不留孤儿）。
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      }
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ stdout, stderr, exitCode: code, stdoutTruncated, stderrTruncated })
      }
      const fail = (err: HerdrCliError) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }
      // CA-002：终止直接子进程 + 整个进程组（POSIX 负 pid）
      const killTree = () => killProcessTree(child, isPosix)
      // CA-001：AbortSignal → 终止子进程并返回 HERDR_ABORTED
      const onAbort = () => {
        if (settled) return
        killTree()
        fail(new HerdrCliError('HERDR_ABORTED', `herdr ${args[0]} aborted`))
      }
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        if (settled) return
        killTree()
        fail(new HerdrCliError('HERDR_TIMEOUT', `herdr ${args[0]} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return
        if (err.code === 'ENOENT') {
          fail(new HerdrCliError('HERDR_UNAVAILABLE', `herdr CLI not found: '${full[0]}' (check config cliPath / HERDR_BIN_PATH)`))
        } else {
          fail(new HerdrCliError('HERDR_UNAVAILABLE', `failed to run '${full[0]}': ${err.message}`))
        }
      })
      // CA-002/CR P2：输出上限——超过 MAX_CLI_OUTPUT_BYTES（UTF-8 字节）停止累积
      // （仍继续消费流，避免子进程写满管道阻塞），并置 truncated 标志。
      // 按 Buffer.byteLength 计字节而非字符串 length（UTF-16 码元），非 ASCII 输出
      // （中文/emoji）不再虚高；超限时在有效 UTF-8 字节边界截断。
      const capStdout = (d: Buffer | string) => {
        if (stdoutTruncated) return
        const chunk = Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
        const bytes = Buffer.byteLength(chunk)
        const remaining = MAX_CLI_OUTPUT_BYTES - stdoutBytes
        if (bytes > remaining) {
          const cut = truncateUtf8Bytes(chunk, remaining)
          stdout += cut
          stdoutBytes += Buffer.byteLength(cut)
          stdoutTruncated = true
        } else {
          stdout += chunk
          stdoutBytes += bytes
        }
      }
      const capStderr = (d: Buffer | string) => {
        if (stderrTruncated) return
        const chunk = Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
        const bytes = Buffer.byteLength(chunk)
        const remaining = MAX_CLI_OUTPUT_BYTES - stderrBytes
        if (bytes > remaining) {
          const cut = truncateUtf8Bytes(chunk, remaining)
          stderr += cut
          stderrBytes += Buffer.byteLength(cut)
          stderrTruncated = true
        } else {
          stderr += chunk
          stderrBytes += bytes
        }
      }
      outStream?.on('data', capStdout)
      errStream?.on('data', capStderr)
      child.on('close', (code) => finish(code))
    })
  }
}
