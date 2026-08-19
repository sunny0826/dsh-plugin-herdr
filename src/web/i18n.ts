// Web 面板 i18n（design: herdr-hero-branding §4.6 扩展）。
// 语言单一事实源：locale 服务 active（app.tsx 注入）→ setHerdrLang()；
// hero-branding.ts（data-herdr-lang / CSS content）与本模块共享该状态。
// 组件文案经 t(key) 或 useHerdrLang() 切换；新增用户可见文案必须同时补 zh + en。

import { useEffect, useState } from 'react'

/** 界面语言（'zh' | 'en'；未知语言回退 zh）。 */
let herdrLang: 'zh' | 'en' = 'zh'

const listeners = new Set<() => void>()

/** 同步界面语言（app.tsx 订阅 locale 服务调用；hero-branding 的 setHerdrLang 亦转发至此）。 */
export function setHerdrLang(lang: string): void {
  const next = lang === 'en' ? 'en' : 'zh'
  if (next === herdrLang) return
  herdrLang = next
  for (const l of [...listeners]) l()
}

/** 同步读取当前语言（非 React 场景用）。 */
export function getHerdrLang(): 'zh' | 'en' {
  return herdrLang
}

/** 订阅语言变化（非 React 场景，如原生 DOM marker 按钮文案/aria 跟随）。 */
export function subscribeHerdrLang(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React hook：订阅语言变化（组件文案切换）。 */
export function useHerdrLang(): 'zh' | 'en' {
  const [lang, setLang] = useState<'zh' | 'en'>(herdrLang)
  useEffect(() => {
    const update = () => setLang(herdrLang)
    listeners.add(update)
    update()
    return () => {
      listeners.delete(update)
    }
  }, [])
  return lang
}

/** 文案字典：key → { zh, en }。 */
export const I18N_KEYS = {
  'pane.drag': { zh: '拖拽排序', en: 'Drag to reorder' },
  'pane.rename': { zh: '重命名', en: 'Rename' },
  'pane.close': { zh: '关闭窗格', en: 'Close pane' },
  'pane.collapse': { zh: '收起', en: 'Collapse' },
  'pane.expand': { zh: '展开', en: 'Expand' },
  'pane.noOutput': { zh: '（无输出）', en: '(no output)' },
  'pane.copy': { zh: '复制', en: 'Copy' },
  'pane.closeConfirm': { zh: '关闭窗格 {id}？其内进程将终止', en: 'Close pane {id}? Its process will be terminated' },
  'dialog.confirm': { zh: '确定', en: 'OK' },
  'dialog.cancel': { zh: '取消', en: 'Cancel' },
  'dialog.processing': { zh: '处理中…', en: 'Processing…' },
  'panel.collapseToLogo': { zh: '折叠为标志', en: 'Collapse to logo' },
  'panel.noPane': { zh: '本会话暂无窗格', en: 'No pane for this session' },
  'panel.fetchingPane': { zh: '正在获取本会话窗格…', en: 'Fetching this session\'s pane…' },
  'panel.selfTag': { zh: '本对话', en: 'This conversation' },
  'panel.selfTitle': { zh: '{id}（本对话）· 点击在 Herdr 中定位', en: '{id} (this conversation) · Click to locate in Herdr' },
  'panel.paneTitle': { zh: '{id} · 点击在 Herdr 中定位', en: '{id} · Click to locate in Herdr' },
  'panel.plainTerminal': { zh: '纯终端', en: 'Plain terminal' },
  'view.running': { zh: 'herdr 运行中', en: 'herdr running' },
  'view.stopped': { zh: 'herdr 未启动', en: 'herdr not started' },
  'view.starting': { zh: '启动中…', en: 'Starting…' },
  'view.start': { zh: '启动', en: 'Start' },
  'view.refresh': { zh: '刷新', en: 'Refresh' },
  'view.dropHint': { zh: '拖拽仅支持同一工作区内排序', en: 'Dragging only reorders within the same workspace' },
  'view.renameWorkspace': { zh: '重命名工作区', en: 'Rename workspace' },
  'view.close': { zh: '关闭', en: 'Close' },
  'view.closeWorkspace': { zh: '关闭工作区', en: 'Close workspace' },
  'view.closeWorkspaceConfirm': { zh: '关闭工作区 {id} 及其 {count} 个窗格？', en: 'Close workspace {id} and its {count} panes?' },
  'view.statusSummary': { zh: '窗格状态摘要', en: 'Pane status summary' },
  'view.statusError': { zh: 'herdr 状态：{error}', en: 'herdr status: {error}' },
  'view.tabId': { zh: '标签页 {id}', en: 'tab {id}' },
  'view.listMeta': { zh: '{workspaces} 个工作区 · {panes} 个窗格', en: '{workspaces} workspaces · {panes} panes' },
  'banner.checking': { zh: '检查 herdr 服务…', en: 'Checking herdr service…' },
  'banner.unavailable': { zh: 'herdr 服务状态不可用', en: 'herdr service unavailable' },
  'banner.running': { zh: 'herdr 服务运行中', en: 'herdr service running' },
  'banner.stopped': { zh: 'herdr 服务未启动', en: 'herdr server is not started' },
  'banner.start': { zh: '启动 herdr', en: 'Start herdr' },
  'banner.startFailed': { zh: '启动失败：{error}', en: 'Failed to start: {error}' },
  // ── Dashboard（design: dashboard §5.4；zh+en 双语同增） ──────────────
  'dashboard.overview': { zh: '本机概览', en: 'Local overview' },
  'dashboard.server': { zh: 'Herdr 服务', en: 'Herdr server' },
  'dashboard.socket': { zh: 'Socket 连接', en: 'Socket connection' },
  'dashboard.socketStatus': { zh: 'Socket 状态', en: 'Socket status' },
  'dashboard.connected': { zh: '已连接', en: 'Connected' },
  'dashboard.disconnected': { zh: '未连接', en: 'Disconnected' },
  'dashboard.stale': { zh: '数据可能已过期', en: 'Data may be stale' },
  'dashboard.versionProtocol': { zh: '版本 · 协议', en: 'Version · protocol' },
  'dashboard.socketPath': { zh: 'Socket 路径', en: 'Socket path' },
  'dashboard.lastSuccess': { zh: '最近成功', en: 'Last success' },
  'dashboard.lastError': { zh: '最近错误', en: 'Last error' },
  'dashboard.fetchError': { zh: '获取 Dashboard 失败', en: 'Failed to fetch dashboard' },
  'dashboard.host': { zh: '主机', en: 'Host' },
  'dashboard.hostname': { zh: '主机名', en: 'Hostname' },
  'dashboard.os': { zh: '操作系统', en: 'Operating system' },
  'dashboard.platform': { zh: '平台', en: 'Platform' },
  'dashboard.arch': { zh: '架构', en: 'Architecture' },
  'dashboard.agents': { zh: '代理', en: 'Agents' },
  'dashboard.agentsTotal': { zh: '总数', en: 'Total' },
  'dashboard.workspaces': { zh: '工作区', en: 'Workspaces' },
  'dashboard.tabs': { zh: '标签页', en: 'Tabs' },
  'dashboard.panes': { zh: '窗格', en: 'Panes' },
  'dashboard.working': { zh: '工作中', en: 'Working' },
  'dashboard.idle': { zh: '空闲', en: 'Idle' },
  'dashboard.blocked': { zh: '等待处理', en: 'Blocked' },
  'dashboard.done': { zh: '已完成', en: 'Done' },
  'dashboard.unknown': { zh: '未知', en: 'Unknown' },
  'dashboard.lastUpdated': { zh: '最近更新：{time}', en: 'Last updated: {time}' },
  'dashboard.refresh': { zh: '刷新 Dashboard', en: 'Refresh dashboard' },
  'dashboard.noData': { zh: '暂无数据', en: 'No data' },
  'dashboard.checking': { zh: '检查中…', en: 'Checking…' },
  'dashboard.empty': { zh: '本机暂无工作区', en: 'No workspaces on this machine' },
  'dashboard.pid': { zh: 'PID', en: 'PID' },
  'dashboard.cpu': { zh: 'CPU', en: 'CPU' },
  'dashboard.memory': { zh: '内存', en: 'Memory' },
  'dashboard.uptime': { zh: '运行时长', en: 'Uptime' },
  'dashboard.sampledHint': { zh: '采样于 {time}', en: 'sampled at {time}' },
  'dashboard.reason': { zh: '原因', en: 'Reason' },
  'dashboard.unavailable': { zh: '不可用', en: 'Unavailable' },
  'dashboard.bestEffort': { zh: '尽力采集', en: 'Best effort' },
  // ── Dashboard 重设计（design: dashboard-redesign —— 服务与环境合并卡 + KPI 条） ──
  'dashboard.env': { zh: '服务与环境', en: 'Server & environment' },
  'dashboard.details': { zh: '详情', en: 'Details' },
  // ── 全局 Dashboard 入口与面板（design: dashboard-global §5.2/§7） ──────
  'global.title': { zh: 'Herdr 仪表盘', en: 'Herdr Dashboard' },
  'global.close': { zh: '关闭', en: 'Close' },
  // ── v4：marker 三态状态点 / Treemap / 代理 列表 ──────────────────
  'global.stateRunning': { zh: '运行中', en: 'Running' },
  'global.stateStopped': { zh: '已停止', en: 'Stopped' },
  'global.stateNotInstalled': { zh: '未安装', en: 'Not installed' },
  'global.stateChecking': { zh: '检查中', en: 'Checking' },
  'dashboard.showAllAgents': { zh: '显示全部', en: 'Show all' },
  'dashboard.collapseAgents': { zh: '收起', en: 'Collapse' },
  'dashboard.agentUnnamed': { zh: '未命名代理', en: 'Unnamed agent' },
  // ── Treemap 块点击跳转（pane → 对应会话 Herdr Tab） ──────────────────
  'dashboard.paneMultiple': { zh: '该分类下有 {count} 个窗格，无法定位具体窗格', en: '{count} panes in this group, cannot locate a specific pane' },
  // ── 五态展示模型（design: herdr-tab-redesign §4.3） ──────────────────
  'status.working': { zh: '工作中', en: 'Working' },
  'status.blocked': { zh: '等待处理', en: 'Blocked' },
  'status.idle': { zh: '空闲', en: 'Idle' },
  'status.done': { zh: '已完成', en: 'Done' },
  'status.unknown': { zh: '未知', en: 'Unknown' },
  // ── 统计格式 ──────────────────────────────────────────────────────
  'view.stats': { zh: '{ws} 个工作区 · {panes} 个窗格 · {agents} 个代理', en: '{ws} workspaces · {panes} panes · {agents} agents' },
  'view.wsMeta': { zh: '{count} 个窗格 · {agents} 个代理', en: '{count} panes · {agents} agents' },
  // ── 安装提示 ─────────────────────────────────────────────────────
  'view.installTitle': { zh: 'herdr 服务未就绪', en: 'herdr server is not reachable' },
  'view.installBody': { zh: '面板通过 socket 与 herdr 无头服务通信。请先启动服务（或使用横幅中的启动按钮），然后刷新。安装 herdr：', en: 'The panel talks to the herdr headless server over its socket. Start it (or use the start button in the banner), then refresh. Install herdr: ' },
  // ── 工作指示器 ────────────────────────────────────────────────────
  'pane.workingIndicator': { zh: '代理正在工作中', en: 'agent working' },
  'pane.terminalOutput': { zh: '终端输出', en: 'Terminal output' },
  'pane.outputTruncated': { zh: '输出已截断', en: 'Output truncated' },
  'pane.maximize': { zh: '最大化终端', en: 'Maximize terminal' },
  'pane.restore': { zh: '退出最大化', en: 'Exit maximized terminal' },
  'pane.terminalInput': { zh: '终端输入', en: 'Terminal input' },
  'pane.terminalInputFailed': { zh: '输入发送失败', en: 'Failed to send terminal input' },
  'pane.terminalScrollPending': { zh: '有新输出，回到底部', en: 'New output, jump to bottom' },
  'pane.terminalCopySelection': { zh: '复制选区', en: 'Copy selection' },
  'pane.terminalKeyUnsupported': { zh: '此按键未被终端协议确认', en: 'This key is not confirmed by the terminal protocol' },
  'pane.terminalSyncing': { zh: '正在同步终端', en: 'Syncing terminal' },
  'pane.terminalReady': { zh: '终端已同步', en: 'Terminal ready' },
  'pane.terminalReconnect': { zh: '终端连接已断开，正在重连', en: 'Terminal disconnected, reconnecting' },
  'pane.terminalResync': { zh: '终端历史需要重新同步', en: 'Terminal history needs resync' },
  'pane.terminalHistoryIncomplete': { zh: '终端历史不完整', en: 'Terminal history incomplete' },
  'pane.terminalRetry': { zh: '重试同步', en: 'Retry sync' },
  'pane.terminalReadOnly': { zh: '只读观察', en: 'Read-only view' },
  'pane.terminalClickToControl': { zh: '点击控制终端', en: 'Click to control terminal' },
  'pane.terminalCompatMode': { zh: '兼容模式', en: 'Compatibility mode' },
  'pane.terminalControlledByOther': { zh: '终端正由另一个客户端控制', en: 'Terminal is controlled by another client' },
  'pane.terminalContinueObserve': { zh: '继续观察', en: 'Continue observing' },
  'pane.terminalTakeover': { zh: '接管控制', en: 'Take over control' },
  'pane.terminalReleaseControl': { zh: '释放控制', en: 'Release control' },
  'pane.terminalTakeoverConfirm': { zh: '接管将关闭现有控制端，确认接管？', en: 'Takeover will close the current controller. Confirm?' },
  // ── 展开/收起日志按钮 ────────────────────────────────────────────
  'pane.expandLog': { zh: '展开日志', en: 'Expand log' },
  'pane.collapseLog': { zh: '收起日志', en: 'Collapse log' },
  'dashboard.checkoutBase': { zh: '检出目录', en: 'Checkout' },
  // ── v5：workspace 卡片关闭 / pane 列表跳转（design: dashboard-close-jump） ──
  'dashboard.closeWorkspace': { zh: '关闭工作区', en: 'Close workspace' },
  'dashboard.closeWorkspaceTitle': { zh: '关闭工作区 {id}', en: 'Close workspace {id}' },
  'dashboard.closePaneTitle': { zh: '关闭窗格 {id}', en: 'Close pane {id}' },
  'dashboard.expandPanes': { zh: '展开窗格', en: 'Expand panes' },
  'dashboard.collapsePanes': { zh: '收起窗格', en: 'Collapse panes' },
  'dashboard.paneJumpTitle': { zh: '{id} · 点击跳转到所属会话', en: '{id} · Click to jump to its session' },
  'dashboard.paneSelfTitle': { zh: '{id}（本对话）· 在 Herdr 中定位', en: '{id} (this conversation) · Locate in Herdr' },
} as const

export type I18nKey = keyof typeof I18N_KEYS

/** 取当前语言文案（模板参数 {x} 用 params 替换；缺失 key 回退 zh，再缺失返回 key 本身）。 */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const entry = I18N_KEYS[key]
  if (entry === undefined) return key
  const text = entry[herdrLang] ?? entry.zh
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}
