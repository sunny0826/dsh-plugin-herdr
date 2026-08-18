// 轻量确认 modal（删除交互 T11）：DSH token 样式，遮罩 + 卡片。
// 独立组件以便 PaneCard 与 HerdrView 共用；受控：visible + 文案 props。
// 确认/取消均为原生 <button>（样式由本插件 CSS 控制），不依赖 primitives 的
// 未验证 variant/className 透传，保证破坏性确认按钮视觉确定。

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import type { MouseEvent } from 'react'
import { dialogFocusModel } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'

export interface ConfirmDialogProps {
  /** 是否显示。 */
  visible: boolean
  /** 确认文案（渲染为 ReactNode，用于嵌入 pane/workspace 名与计数）。 */
  title: ReactNode
  /** 确认按钮文字（默认「确定」）。 */
  confirmLabel?: string
  /** 确认中禁用按钮（提交期间防重复）。 */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 遮罩点击（非卡片）→ 取消；回车/点击确定 → 确认。 */
export function ConfirmDialog({
  visible,
  title,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // 语言订阅：切语言时默认按钮文案跟随（显式传入的 confirmLabel 优先）
  void useHerdrLang()
  const titleId = `herdr-confirm-title-${useId()}`
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const triggeredRef = useRef<HTMLElement | null>(null)
  const previouslyVisibleRef = useRef(false)
  const model = dialogFocusModel({ busy, titleId })

  useEffect(() => {
    const opened = visible && !previouslyVisibleRef.current
    const closed = !visible && previouslyVisibleRef.current && model.restoreFocus && model.restoreTarget === 'trigger'
    if (opened) triggeredRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (closed) {
      triggeredRef.current?.focus()
      triggeredRef.current = null
    }
    previouslyVisibleRef.current = visible
  }, [visible, model.restoreFocus, model.restoreTarget])

  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      const target = model.initialFocus === 'confirm' ? confirmRef.current : cancelRef.current
      target?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, model.initialFocus])

  // Escape 取消（处理中不可取消）
  useEffect(() => {
    if (!visible || !model.escapeCancels) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, model.escapeCancels, onCancel])

  if (!visible) return null
  const confirmText = confirmLabel ?? t('dialog.confirm')
  return (
    <div
      className="herdr-mask"
      onPointerDown={(e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="herdr-modal" role="dialog" aria-modal="true" aria-labelledby={model.titleId}>
        <div className="herdr-modal-title" id={model.titleId}>{title}</div>
        <div className="herdr-modal-actions">
          <button className="herdr-modal-btn" type="button" ref={cancelRef} onClick={onCancel} disabled={busy}>{t('dialog.cancel')}</button>
          <button className="herdr-modal-btn herdr-modal-btn-danger" type="button" ref={confirmRef} onClick={onConfirm} disabled={busy}>
            {busy ? t('dialog.processing') : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
