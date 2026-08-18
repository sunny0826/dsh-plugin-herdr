// 领域类型（与服务端 src/status.ts 一致）。Web 面板各组件共享这些类型；
// 与传输层 src/client/types.ts（协议类型）互不相关。

export interface HerdrAgentStatus {
  pane_id: string
  workspace_id?: string
  agent: string
  status: string
  message?: string
  output: string
  /** 输出是否被截断（服务器 truncated 或客户端 OUTPUT_CAP/transport cap）。 */
  outputTruncated?: boolean
  updated_at: number
}

export interface HerdrServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  socket: string | null
  session: string | null
  checked_at: number
}

export interface HerdrWorkspaceView {
  workspace_id: string
  label?: string
  active_tab_id?: string
}

export interface HerdrTabView {
  tab_id: string
  workspace_id: string
  label?: string
  active_pane_id?: string
  pane_count?: number
}

export interface HerdrPaneView {
  pane_id: string
  workspace_id: string
  tab_id?: string
  label?: string
  title?: string
  terminal_title_stripped?: string
  display_agent?: string
  cwd?: string
  foreground_cwd?: string
  focused: boolean
  agent_status?: string
}

export interface HerdrTopology {
  workspaces: HerdrWorkspaceView[]
  tabs: HerdrTabView[]
  panes: HerdrPaneView[]
}

/** 看板目录过滤元数据（与服务端 src/status.ts 一致）。matched/total 以全量为口径。 */
export interface HerdrFilterInfo {
  project_root: string
  matched: number
  total: number
  hidden_workspaces: string[]
}

export interface HerdrStatusSnapshot {
  agents: HerdrAgentStatus[]
  updated_at: number
  connected: boolean
  server?: HerdrServerInfo
  topology?: HerdrTopology
  filter?: HerdrFilterInfo
}
