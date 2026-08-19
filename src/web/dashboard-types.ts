// Dashboard DTO 的 Web 类型（镜像服务端 src/dashboard.ts / src/client-logic.ts；
// v4：彻底去会话边界——无 is_self/focused/active tab/pane，agent 明细挂 workspace）。

export interface HerdrDashboardHost {
  hostname: string
  platform: string
  arch: string
  os_type: string
  os_release: string
  node_version: string
}

/** Herdr server 进程采样（best-effort）；available=false → UI 显示 Unavailable 并附 error。 */
export interface HerdrDashboardProcess {
  available: boolean
  pid: number | null
  started_at: number | null
  cpu_percent: number | null
  rss_bytes: number | null
  source: string | null
  sampled_at: number
  error: string | null
}

export interface HerdrDashboardServerInfo {
  status: string
  running: boolean
  version: string | null
  protocol: number | null
  /** 脱敏：socket 绝对路径的 basename。 */
  socket: string | null
  session: string | null
  checked_at: number
  /** Herdr CLI/server binary 可用性（PATH fs.access 探测）。 */
  installation: 'installed' | 'missing' | 'unknown'
}

export interface HerdrDashboardConnection {
  connected: boolean
  last_success_at: number
  collectors: {
    server: boolean
    topology: boolean
    agents: boolean
    host: boolean
    process: boolean
  }
}

/** workspace 内 agent 明细（名称列表/Treemap/tooltip 同一份数据）。 */
export interface HerdrDashboardAgent {
  pane_id: string
  name?: string
  /** best-effort kind（kind → agent → unknown 回退链；协议兼容推断）。 */
  kind: string
  status: string
}

/** 跳转目标的最小形状（agent 行 / pane 行共用的 pane_id 引用）。 */
export interface HerdrDashboardPaneRef {
  pane_id: string
}

/** workspace 内单个 pane 明细（含非 agent 纯终端 pane；点击跳转 / 关闭的数据源）。 */
export interface HerdrDashboardPane {
  pane_id: string
  /** topology label（pane 显示名；可能为 null）。 */
  label: string | null
  /** 归属 agent 的归一化 kind；非 agent pane 为 'unknown'。 */
  kind: string
  /** 自定义 target 名称（无则 undefined）。 */
  name?: string
  /** 状态输入（agent.status；非 agent 回退 agent_status）。 */
  status: string
}

export interface HerdrDashboardWorkspace {
  workspace_id: string
  label: string | null
  /** 脱敏：checkout_path 的 basename。 */
  checkout_path_base: string | null
  tab_count: number
  pane_count: number
  agent_count: number
  agents_working: number
  agents_blocked: number
  agents: HerdrDashboardAgent[]
  /** pane 明细（可点击跳转 / 可关闭）。 */
  panes: HerdrDashboardPane[]
}

export interface HerdrDashboardSummary {
  workspaces: number
  tabs: number
  panes: number
  agents: number
  agents_by_status: Record<string, number>
}

export interface HerdrDashboardSnapshot {
  updated_at: number
  stale: boolean
  last_error: string | null
  server: HerdrDashboardServerInfo
  connection: HerdrDashboardConnection
  host: HerdrDashboardHost
  process: HerdrDashboardProcess
  summary: HerdrDashboardSummary
  workspaces: HerdrDashboardWorkspace[]
}
