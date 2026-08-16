import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  AgentStatus,
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    herdr: HerdrClient
  }
}

export type { AgentStatus, PaneAgentState, SplitDirection, ReadSource } from './types.js'

// ---------------------------------------------------------------------------
// 领域类型（字段名对齐 Herdr 协议 snake_case，便于对照 herdr api schema）
// ---------------------------------------------------------------------------

/**
 * session.snapshot 的 result.snapshot 结构。
 * CA-004：panes/workspaces/tabs/layouts 由 fixture 生成类型（替代 unknown[]）。
 */
export interface HerdrSnapshot extends Omit<SessionSnapshot, 'agents' | 'panes' | 'workspaces' | 'tabs' | 'layouts'> {
  agents: HerdrAgentInfo[]
  panes: PaneInfo[]
  workspaces: WorkspaceInfo[]
  tabs: TabInfo[]
  layouts: PaneLayoutSnapshot[]
}

/** pane list / split 返回的 pane 记录（核心字段）。 */
export interface HerdrPaneInfo {
  pane_id: string
  workspace_id: string
  tab_id: string
  cwd?: string
  foreground_cwd?: string | null
  focused: boolean
  agent_status?: string
  revision?: number
  [key: string]: unknown
}

/** agent 记录（agent.list / snapshot.agents）。 */
export interface HerdrAgentInfo {
  pane_id?: string
  workspace_id?: string
  tab_id?: string
  agent?: string | null
  status?: AgentStatus
  message?: string | null
  foreground_cwd?: string | null
  [key: string]: unknown
}

export interface AgentFilter {
  workspace_id?: string
  status?: AgentStatus
}

export interface RunCommandRequest {
  command: string
  /** 复用已有 pane；缺省新建 split pane。 */
  pane_id?: string
  workspace_id?: string
  direction?: 'right' | 'down'
  ratio?: number
  cwd?: string
  env?: Record<string, string>
  /** 等待输出的时间上限（ms），默认配置 timeoutMs。 */
  wait_ms?: number
}

export type RunCommandResult =
  | {
      kind: 'completed'
      pane_id: string
      exit_code: number | null
      output: string
      truncated: boolean
      timed_out?: boolean
    }
  | { kind: 'background'; jobId: string } // M2 启用后台化后使用

export interface WaitAgentRequest {
  target: string
  /** 可多状态（对齐 CLI --until 可重复）；命中任一即返回。 */
  until: AgentStatus[]
  timeout_ms?: number
}

export type WaitAgentResult =
  | { kind: 'completed'; pane_id?: string; agent?: string; status: AgentStatus; message?: string; waited_ms: number }
  | { kind: 'timeout'; pane_id?: string; agent?: string; status?: AgentStatus; waited_ms: number }
  | { kind: 'not_found'; target: string }

// ---- 扩展方法请求类型（M2-05/06） ----

export interface WorkspaceCreateRequest {
  cwd?: string
  label?: string
  env?: Record<string, string>
}

export interface PaneSplitRequest {
  /** CLI 传输：分裂目标 pane（位置参数）；socket：target_pane_id。 */
  pane_id?: string
  workspace_id?: string
  direction: 'right' | 'down'
  ratio?: number
  cwd?: string
  env?: Record<string, string>
}

export interface PaneSendKeysRequest {
  pane_id: string
  keys: string[]
}

export interface PaneReadRequest {
  pane_id: string
  source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
  lines?: number
  format?: 'text' | 'ansi'
}

export interface PaneLayoutRequest {
  pane_id?: string
}

export interface LayoutApplyRequest {
  root: unknown
  workspace_id?: string
  tab_id?: string
  tab_label?: string
  focus?: boolean
}

export interface AgentPromptRequest {
  target: string
  text: string
  /** 提交后等待首个状态（CLI --wait 语义）。 */
  wait?: boolean
  until?: AgentStatus[]
  timeout_ms?: number
}

export interface AgentExplainRequest {
  target?: string
}

export interface AgentSendKeysRequest {
  target: string
  keys: string[]
}

export interface NotificationShowRequest {
  title: string
  body?: string
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  sound?: 'none' | 'done' | 'request'
}

export interface AgentPromptResult {
  submitted: true
  status?: string
  message?: string
  waited_ms?: number
}

// ---- M3 状态上报 ----

export type PaneReportState = 'idle' | 'working' | 'blocked' | 'unknown'

export interface ReportAgentRequest {
  pane_id: string
  source: string
  agent: string
  state: PaneReportState
  message?: string
}

/** pane.report_metadata 载荷（CA-006：title/tokens/ttl；显示性元数据）。 */
export interface ReportMetadataRequest {
  pane_id: string
  source: string
  agent?: string
  /** 侧边栏标题。 */
  title?: string | null
  /** 令牌（如 { model: 'claude-4' }）；值为 null 表示清除该令牌。 */
  tokens?: Record<string, string | null>
  /** 元数据存活时长（ms）；过期后侧边栏清除。TTL 刷新据此周期重报。 */
  ttl_ms?: number | null
}

export interface ClearAgentAuthorityRequest {
  pane_id: string
  source?: string
  /** CLI release-agent 必需。 */
  agent?: string
}

// ---------------------------------------------------------------------------
// 服务定义
// ---------------------------------------------------------------------------

/**
 * Herdr 控制面服务（DESIGN.md §5.3 / §7.3）。
 * 具体实现由传输层提供：CliHerdrClient（cli.ts）、SocketHerdrClient（M2）。
 */
export abstract class HerdrClient extends Service {
  constructor(ctx: Context) {
    super(ctx, 'herdr')
  }

  /** 会话快照（session.snapshot）。 */
  abstract snapshot(): Promise<HerdrSnapshot>

  /** 列出 agent（CLI 传输下由 agent list 解析，按过滤器在内存过滤）。 */
  abstract listAgents(filter?: AgentFilter): Promise<HerdrAgentInfo[]>

  /** 在 pane 中运行命令并（前台）等待输出稳定或超时。 */
  abstract runCommand(req: RunCommandRequest, signal: AbortSignal): Promise<RunCommandResult>

  /** 等待 pane 的 agent 达到目标状态之一。 */
  abstract waitAgent(req: WaitAgentRequest, signal: AbortSignal): Promise<WaitAgentResult>

  // ---- 扩展方法（M2-05/06） ----

  abstract workspaceCreate(req: WorkspaceCreateRequest): Promise<{ workspace_id: string; pane_id?: string }>
  abstract paneSplit(req: PaneSplitRequest): Promise<{ pane_id: string }>
  /** 关闭 pane（会话专属 pane 的清理；pane 内进程随之终止）。 */
  abstract paneClose(paneId: string): Promise<void>
  /** 关闭 workspace（含其中所有 pane；T01-E：不存在时报 workspace_not_found）。 */
  abstract workspaceClose(workspaceId: string): Promise<void>
  /** 重命名 workspace（多词标签由 CLI join 空格；T01-D）。 */
  abstract workspaceRename(workspaceId: string, label: string): Promise<void>
  /** 重命名 pane；label 为空（null/空白）走 --clear 清除名称（T01-A/B）。 */
  abstract paneRename(paneId: string, label: string | null): Promise<void>
  abstract paneSendKeys(req: PaneSendKeysRequest): Promise<void>
  abstract paneRead(req: PaneReadRequest): Promise<{ text: string; truncated: boolean }>
  abstract paneLayout(req: PaneLayoutRequest): Promise<unknown>
  abstract layoutApply(req: LayoutApplyRequest): Promise<unknown>
  abstract agentPrompt(req: AgentPromptRequest, signal: AbortSignal): Promise<AgentPromptResult>
  abstract agentExplain(req: AgentExplainRequest): Promise<unknown>
  abstract agentSendKeys(req: AgentSendKeysRequest): Promise<void>
  abstract showNotification(req: NotificationShowRequest): Promise<void>

  // ---- M3 状态上报 ----

  /** 上报 pane 的 agent 生命周期状态（显示性；PaneAgentState 无 done，done 映射 idle）。 */
  abstract reportAgent(req: ReportAgentRequest): Promise<void>
  /** 上报 pane 的显示性元数据（title/tokens/ttl_ms；CA-006 M3-03）。 */
  abstract reportMetadata(req: ReportMetadataRequest): Promise<void>
  /** 释放本来源对该 pane 的 agent 状态 authority（卸载清理用）。 */
  abstract clearAgentAuthority(req: ClearAgentAuthorityRequest): Promise<void>
}
