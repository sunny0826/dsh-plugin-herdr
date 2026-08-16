// 浮动拖动：面板/折叠按钮可拖动，松手水平吸附到最近的页面边界。
// （纯数学见 client-logic.ts 的 computeSnapPosition / isDragMovement）

import { useRef } from 'react'
import { computeSnapPosition, isDragMovement } from '../client-logic.ts'

export interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
}

export type ReactPointerEvent = {
  button?: number
  clientX: number
  clientY: number
  pointerId: number
  currentTarget: { setPointerCapture(id: number): void; releasePointerCapture(id: number): void }
}

export const SNAP = 16

/**
 * 拖动 + 吸附（position: fixed 元素；ref 提供元素尺寸）。
 * pos/setPos 由调用方传入——面板与折叠圆钮共享同一位置，折叠/展开不丢失位置。
 * consumeDragged()：读取并清除"本次指针序列是否发生拖动"（pointerup 设、click 读），
 * 防止拖动后的 click 误触（如拖动 logo 圆钮不应展开面板）。
 */
export function useFloatingDrag<T extends HTMLElement>(
  ref: { current: T | null },
  pos: { x: number; y: number } | null,
  setPos: (p: { x: number; y: number } | null) => void,
  enabled: boolean,
): { handlers: DragHandlers; consumeDragged: () => boolean } {
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!enabled || e.button !== 0) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && isDragMovement(dx, dy)) d.moved = true
    if (d.moved) setPos({ x: d.baseX + dx, y: d.baseY + dy })
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!d) return
    if (d.moved) {
      draggedRef.current = true
      const el = ref.current
      if (!el) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const x = d.baseX + (e.clientX - d.startX)
      const y = d.baseY + (e.clientY - d.startY)
      // 分左右吸附：右侧 → 视口右边界；左侧 → 侧边栏右缘（AppFrame 的
      // sidebar col，overlay 层的父级 frame 的首个子元素）
      let sidebarW = 0
      if (x + el.offsetWidth / 2 < vw / 2) {
        const overlay = document.querySelector('[data-shell-overlay]')
        const sidebar = overlay?.parentElement?.firstElementChild
        sidebarW = sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
      }
      setPos(computeSnapPosition({
        x, y,
        w: el.offsetWidth,
        h: el.offsetHeight,
        vw, vh,
        sidebarW,
        snap: SNAP,
      }))
    }
  }

  const consumeDragged = (): boolean => {
    const v = draggedRef.current
    draggedRef.current = false
    return v
  }

  return { handlers: { onPointerDown, onPointerMove, onPointerUp }, consumeDragged }
}
