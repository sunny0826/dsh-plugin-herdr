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
  'pane.close': { zh: '关闭 pane', en: 'Close pane' },
  'pane.collapse': { zh: '收起', en: 'Collapse' },
  'pane.expand': { zh: '展开', en: 'Expand' },
  'pane.noOutput': { zh: '（无输出）', en: '(no output)' },
  'pane.copy': { zh: '复制', en: 'Copy' },
  'pane.closeConfirm': { zh: '关闭 pane {id}？其内进程将终止', en: 'Close pane {id}? Its process will be terminated' },
  'dialog.confirm': { zh: '确定', en: 'OK' },
  'dialog.cancel': { zh: '取消', en: 'Cancel' },
  'dialog.processing': { zh: '处理中…', en: 'Processing…' },
  'panel.collapseToLogo': { zh: '折叠为 logo', en: 'Collapse to logo' },
  'panel.noPane': { zh: '本会话暂无 pane', en: 'No pane for this session' },
  'panel.fetchingPane': { zh: '正在获取本会话 pane…', en: 'Fetching this session\'s pane…' },
  'panel.selfTag': { zh: '本对话', en: 'This conversation' },
  'panel.selfTitle': { zh: '{id}（本对话）· 点击在 Herdr 中定位', en: '{id} (this conversation) · Click to locate in Herdr' },
  'panel.paneTitle': { zh: '{id} · 点击在 Herdr 中定位', en: '{id} · Click to locate in Herdr' },
  'panel.plainTerminal': { zh: '纯终端', en: 'Plain terminal' },
  'view.running': { zh: 'herdr 运行中', en: 'herdr running' },
  'view.stopped': { zh: 'herdr 未启动', en: 'herdr not started' },
  'view.starting': { zh: '启动中…', en: 'Starting…' },
  'view.start': { zh: '启动', en: 'Start' },
  'view.refresh': { zh: '刷新', en: 'Refresh' },
  'view.dropHint': { zh: '拖拽仅支持同 workspace 内排序', en: 'Dragging only reorders within the same workspace' },
  'view.renameWorkspace': { zh: '重命名 workspace', en: 'Rename workspace' },
  'view.close': { zh: '关闭', en: 'Close' },
  'view.closeWorkspace': { zh: '关闭 workspace', en: 'Close workspace' },
  'view.closeWorkspaceConfirm': { zh: '关闭 workspace {id} 及其 {count} 个 pane？', en: 'Close workspace {id} and its {count} panes?' },
  'banner.checking': { zh: '检查 herdr 服务…', en: 'Checking herdr service…' },
  'banner.unavailable': { zh: 'herdr 服务状态不可用', en: 'herdr service unavailable' },
  'banner.running': { zh: 'herdr 服务运行中', en: 'herdr service running' },
  'banner.stopped': { zh: 'herdr 服务未启动', en: 'herdr service not started' },
  'banner.start': { zh: '启动 herdr', en: 'Start herdr' },
  'banner.startFailed': { zh: '启动失败：{error}', en: 'Failed to start: {error}' },
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
