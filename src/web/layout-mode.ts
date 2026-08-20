// Herdr Tab 布局模式（design: herdr-tab-dual-layout）。
// 默认 window（兼容现行为）；按 workspace 隔离持久化到 localStorage。

import { useCallback, useEffect, useState } from 'react'

export type HerdrLayoutMode = 'window' | 'list'

const LS_MODE_GLOBAL = 'herdr:layout-mode'
const LS_ACTIVE_PREFIX = 'herdr:active-pane:'
const LS_NAV_WIDTH_PREFIX = 'herdr:list-nav-width:'

const DEFAULT_NAV_WIDTH = 220
const MIN_NAV_WIDTH = 160
const MAX_NAV_WIDTH = 400

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

function keyForMode(wsId?: string): string {
  return wsId ? `${LS_MODE_GLOBAL}:${wsId}` : LS_MODE_GLOBAL
}

function keyForActive(wsId: string): string {
  return `${LS_ACTIVE_PREFIX}${wsId}`
}

function keyForNavWidth(wsId?: string): string {
  return wsId ? `${LS_NAV_WIDTH_PREFIX}${wsId}` : `${LS_NAV_WIDTH_PREFIX}global`
}

function readMode(wsId?: string): HerdrLayoutMode | null {
  const s = storage()
  if (!s) return null
  try {
    // priority: ws-specific → global
    if (wsId) {
      const v = s.getItem(keyForMode(wsId))
      if (v === 'window' || v === 'list') return v
    }
    const g = s.getItem(LS_MODE_GLOBAL)
    if (g === 'window' || g === 'list') return g
    return null
  } catch {
    return null
  }
}

export function getLayoutMode(wsId?: string): HerdrLayoutMode {
  return readMode(wsId) ?? 'window'
}

export function setLayoutMode(mode: HerdrLayoutMode, wsId?: string): void {
  const s = storage()
  if (!s) return
  try {
    // write both global fallback and ws-specific for isolation
    s.setItem(LS_MODE_GLOBAL, mode)
    if (wsId) s.setItem(keyForMode(wsId), mode)
  } catch {
    // quota/disabled → silent
  }
}

// ── active pane 记忆（列表模式焦点） ───────────────────────────────

export function getActivePane(wsId: string): string | null {
  const s = storage()
  if (!s) return null
  try {
    const v = s.getItem(keyForActive(wsId))
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function setActivePane(wsId: string, paneId: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(keyForActive(wsId), paneId)
  } catch {
    // silent
  }
}

// ── 列表侧栏宽度（可拖拽 resize，按 workspace 隔离，160–400，默认 220） ──

export function clampNavWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_NAV_WIDTH
  return Math.max(MIN_NAV_WIDTH, Math.min(MAX_NAV_WIDTH, Math.round(n)))
}

export function getNavWidth(wsId?: string): number {
  const s = storage()
  if (!s) return DEFAULT_NAV_WIDTH
  try {
    const raw = s.getItem(keyForNavWidth(wsId))
    if (!raw) return DEFAULT_NAV_WIDTH
    const v = Number(raw)
    if (!Number.isFinite(v)) return DEFAULT_NAV_WIDTH
    return clampNavWidth(v)
  } catch {
    return DEFAULT_NAV_WIDTH
  }
}

export function setNavWidth(width: number, wsId?: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(keyForNavWidth(wsId), String(clampNavWidth(width)))
  } catch {
    // silent
  }
}

export { DEFAULT_NAV_WIDTH, MIN_NAV_WIDTH, MAX_NAV_WIDTH }

// ── React hook ─────────────────────────────────────────────────────

export function useLayoutMode(wsId?: string): [HerdrLayoutMode, (m: HerdrLayoutMode) => void] {
  const [mode, setMode] = useState<HerdrLayoutMode>(() => getLayoutMode(wsId))

  useEffect(() => {
    setMode(getLayoutMode(wsId))
  }, [wsId])

  // cross-tab sync
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e: StorageEvent) => {
      if (!e.key) return
      if (e.key === LS_MODE_GLOBAL || (wsId && e.key === keyForMode(wsId))) {
        setMode(getLayoutMode(wsId))
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [wsId])

  const update = useCallback((next: HerdrLayoutMode) => {
    setLayoutMode(next, wsId)
    setMode(next)
  }, [wsId])

  return [mode, update]
}
