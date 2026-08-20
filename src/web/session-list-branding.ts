// 左侧边栏会话列表 herdr 打标控制器（design: session-list-branding）。
// 思路：订阅 sessions.list 的 ObservableSnapshot，派生 herdr 会话集合（agentPreset === HERDR_PRESET_ID），
// 通过 MutationObserver + rAF 批量为左侧边栏中对应会话行在名称前插入 herdr logo（SVG），
// 非 herdr 行移除 logo；幂等（重复 patch 不重复插入，重复调用不重复创建节点），
// 清理时断开 observer/订阅并取消 rAF。

import { HERDR_PRESET_ID } from '../client-logic.ts'
import { HERDR_LOGO_PATH_D } from './logo-path.ts'
import type { SessionListLike } from './mode.ts'

const LOGO_CLASS = 'herdr-session-logo'
const ROW_ATTR = 'data-herdr-session'
const REGION_SELECTOR = '[class*="regionArea"]'
const SESSION_ROW_SELECTOR = '[class*="sessionRow"]'
const TREEITEM_SELECTOR = '[role="treeitem"]'

function getHerdrSessionIds(byId?: Record<string, { agentPreset?: string }>): Set<string> {
  const s = new Set<string>()
  if (!byId) return s
  for (const [id, v] of Object.entries(byId)) {
    if (v?.agentPreset === HERDR_PRESET_ID) s.add(id)
  }
  return s
}

function getRegionArea(): Element | null {
  if (typeof document === 'undefined') return null
  try {
    const el = document.querySelector(REGION_SELECTOR)
    if (el) return el
  } catch {
    // 选择器异常时回退到 body
  }
  return document.body ?? null
}

function collectCandidates(regionArea: Element): Element[] {
  // 会话行优先使用 sessionRow（DSH sidebar 的会话专用类，形如 l6i7Uq_sessionRow）
  try {
    const sessionRows = Array.from(regionArea.querySelectorAll(SESSION_ROW_SELECTOR))
    if (sessionRows.length > 0) return sessionRows
  } catch {
    // ignore
  }
  let items: Element[] = []
  try {
    items = Array.from(regionArea.querySelectorAll(TREEITEM_SELECTOR))
    // 过滤出会话行（排除项目文件夹 l6i7Uq_projectRow）
    const filtered = items.filter(el => {
      const cls = (el as HTMLElement).className || ''
      return cls.includes('sessionRow')
    })
    if (filtered.length > 0) return filtered
    // 若无 sessionRow 标记，则排除 aria-expanded 的项目行，仅保留无展开属性的叶子
    const leaf = items.filter(el => !el.hasAttribute('aria-expanded'))
    if (leaf.length > 0) return leaf
    if (items.length > 0) return items
  } catch {
    items = []
  }
  const children = Array.from(regionArea.children).filter(el => el instanceof Element)
  if (children.length > 0) return children
  return []
}

function getSessionIdFromFiber(row: Element): string | null {
  const fiberKey = Object.keys(row).find(k => k.startsWith('__reactFiber'))
  if (!fiberKey) return null
  let fiber: unknown = (row as unknown as Record<string, unknown>)[fiberKey]
  for (let i = 0; i < 10 && fiber; i++) {
    const f = fiber as Record<string, unknown>
    const key = f['key']
    if (typeof key === 'string' && key.startsWith('session-')) return key
    const pending = f['pendingProps'] as Record<string, unknown> | null | undefined
    const memo = f['memoizedProps'] as Record<string, unknown> | null | undefined
    const ppNode = pending?.['node'] as Record<string, unknown> | undefined
    if (ppNode && typeof ppNode['id'] === 'string') return ppNode['id'] as string
    const mpNode = memo?.['node'] as Record<string, unknown> | undefined
    if (mpNode && typeof mpNode['id'] === 'string') return mpNode['id'] as string
    // content.node.id 也在高层 U7 / groupSection 层
    const ppContent = pending?.['content'] as Record<string, unknown> | undefined
    if (ppContent && typeof (ppContent['props'] as Record<string, unknown> | undefined)?.['node'] === 'object') {
      const n = ((ppContent['props'] as Record<string, unknown>)['node'] as Record<string, unknown>)
      if (n && typeof n['id'] === 'string') return n['id'] as string
    }
    fiber = f['return'] as unknown
  }
  return null
}

function extractSessionId(row: Element, byId: Record<string, { agentPreset?: string }>): string | null {
  const fiberId = getSessionIdFromFiber(row)
  if (fiberId) return fiberId
  // 兜底：属性/ dataset 匹配（兼容未来 DOM 形态）
  const ids = Object.keys(byId)
  if (ids.length === 0) return null
  const idSet = new Set(ids)
  const elements: Element[] = [row]
  try {
    elements.push(...Array.from(row.querySelectorAll('*')))
  } catch {
    // ignore
  }
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      const val = attr.value
      if (!val) continue
      if (idSet.has(val)) return val
      for (const id of ids) if (val.includes(id)) return id
    }
    if (el instanceof HTMLElement) {
      for (const dv of Object.values(el.dataset)) {
        if (!dv) continue
        if (idSet.has(dv)) return dv
        for (const id of ids) if (dv.includes(id)) return id
      }
    }
  }
  // 最后兜底：按标题文本匹配（部分版本可能尚未挂载 fiber）
  const titleEl = row.querySelector('[class*="title"]')
  const titleText = (titleEl?.textContent ?? row.textContent ?? '').trim()
  if (titleText) {
    for (const [id, v] of Object.entries(byId)) {
      const dh = (v as { displayTitle?: string; title?: string }).displayTitle
        ?? (v as { title?: string }).title
      if (dh && (titleText === dh || dh.includes(titleText) || titleText.includes(dh))) return id
    }
    // 基于 ids 顺序的弱匹配：若标题能精确命中某个 displayTitle 的前缀，则认为匹配
    for (const [id, v] of Object.entries(byId)) {
      const dh = (v as { displayTitle?: string; title?: string }).displayTitle
        ?? (v as { title?: string }).title
      if (!dh) continue
      const a = dh.slice(0, 12)
      const b = titleText.slice(0, 12)
      if (a && b && a === b) return id
    }
  }
  return null
}

function ensureLogo(row: Element, shouldShow: boolean): void {
  const existing = row.querySelector('.' + LOGO_CLASS)
  if (shouldShow) {
    if (existing) {
      if (row instanceof HTMLElement) row.setAttribute(ROW_ATTR, '1')
      return
    }
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', LOGO_CLASS)
    svg.setAttribute('viewBox', '0 0 512 512')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('role', 'img')
    const g = document.createElementNS(NS, 'g')
    g.setAttribute('transform', 'translate(0 512) scale(.1 -.1)')
    g.setAttribute('fill', 'currentColor')
    g.setAttribute('stroke', 'none')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', HERDR_LOGO_PATH_D)
    g.appendChild(path)
    svg.appendChild(g)
    const titleEl = row.querySelector('[class*="title"]')
    if (titleEl) {
      titleEl.insertAdjacentElement('beforebegin', svg)
    } else {
      let inserted = false
      const spans = Array.from(row.querySelectorAll('span'))
      for (const sp of spans) {
        const txt = (sp.textContent ?? '').trim()
        if (txt !== '') {
          sp.insertAdjacentElement('beforebegin', svg)
          inserted = true
          break
        }
      }
      if (!inserted) row.prepend(svg)
    }
    if (row instanceof HTMLElement) row.setAttribute(ROW_ATTR, '1')
  } else {
    if (existing) existing.remove()
    if (row instanceof HTMLElement) row.removeAttribute(ROW_ATTR)
  }
}

function patch(list: SessionListLike): void {
  const snap = list.getSnapshot()
  const byId = snap.byId ?? {}
  const herdrIds = getHerdrSessionIds(byId)
  const regionArea = getRegionArea()
  if (!regionArea) return
  const candidates = collectCandidates(regionArea)
  if (candidates.length === 0) return
  const extracted: Array<{ row: Element; sid: string | null }> = candidates.map(row => ({
    row,
    sid: extractSessionId(row, byId),
  }))
  const unresolvedCount = extracted.filter(x => x.sid === null).length
  if (unresolvedCount > 0 && candidates.length === Object.keys(byId).length) {
    const keys = Object.keys(byId)
    for (let i = 0; i < extracted.length; i++) {
      if (extracted[i].sid === null) {
        extracted[i].sid = keys[i] ?? null
      }
    }
  }
  for (const { row, sid } of extracted) {
    if (!sid) continue
    const shouldShow = herdrIds.has(sid)
    ensureLogo(row, shouldShow)
  }
}

/** 启动会话列表打标；返回停止函数（断开 observer 与订阅，取消 rAF）。 */
export function startSessionListBranding(list: SessionListLike): () => void {
  const noop = () => {}
  if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return noop
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return noop

  let raf = 0
  let stopped = false

  const schedulePatch = () => {
    if (stopped) return
    if (typeof requestAnimationFrame === 'undefined') {
      try {
        patch(list)
      } catch {
        // 忽略单次 patch 异常，避免阻断后续调度
      }
      return
    }
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      try {
        patch(list)
      } catch {
        // 忽略单次 patch 异常
      }
    })
  }

  try {
    patch(list)
  } catch {
    // 初始化异常不阻断监听
  }

  let unsubscribe: () => void
  try {
    unsubscribe = list.subscribe(schedulePatch)
  } catch {
    unsubscribe = noop
  }

  const observer = new MutationObserver(schedulePatch)
  try {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    })
  } catch {
    // observe 失败时仍保留订阅，仅失去 DOM 增量监听
  }

  return () => {
    stopped = true
    try {
      observer.disconnect()
    } catch {
      // 忽略
    }
    if (raf) {
      try {
        cancelAnimationFrame(raf)
      } catch {
        // 忽略
      }
      raf = 0
    }
    try {
      unsubscribe()
    } catch {
      // 忽略
    }
  }
}
