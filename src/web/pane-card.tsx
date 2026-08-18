// PaneCard：交互式终端卡片（替代日志卡片设计）。
// 设计：pane-interactive-terminal §4.2
// 保留：pane 名/双击改名、拖拽手柄、StateDot、agent accent、agent pill、改名、关闭确认、状态
// 移除：open/onToggle/disclosure/expand/copy footer
// 新增：maximize 按钮、PaneTerminal

import { useCallback, useRef, useState, type DragEvent } from 'react'
import { Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  agentTheme,
  ariaStateLabel,
  dotState,
  paneDisplayName,
  paneDisplayState,
  validateLabel,
  focusBeforeRemoval,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import type { HerdrAgentStatus, HerdrPaneView } from './types.ts'
import { PaneTerminal } from './pane-terminal.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'

/** 拖拽相关 props（由 HerdrView 注入）。 */
export interface PaneCardDragProps {
  dragging?: boolean
  insert?: 'before' | 'after' | null
  onHandleDragStart?: (e: DragEvent) => void
  onHandleDragEnd?: (e: DragEvent) => void
  onCardDragOver?: (e: DragEvent) => void
  onCardDrop?: (e: DragEvent) => void
  onCardDragLeave?: (e: DragEvent) => void
}

export function PaneCard({
  pane,
  agent,
  self = false,
  onClose,
  onRename,
  onMaximize,
  dragging,
  insert,
  onHandleDragStart,
  onHandleDragEnd,
  onCardDragOver,
  onCardDrop,
  onCardDragLeave,
}: {
  pane: HerdrPaneView
  agent: HerdrAgentStatus | undefined
  self?: boolean
  onClose?: () => void
  onRename?: (label: string | null) => Promise<void> | void
  onMaximize?: (triggerEl: HTMLElement | null) => void
} & PaneCardDragProps) {
  void useHerdrLang()
  const status = agent?.status ?? pane.agent_status
  const displayState = paneDisplayState(status)
  const stateLabel = t(ariaStateLabel(displayState))
  const muted = displayState === 'unknown'

  // ── 关闭确认 ──────────────────────────────────────────────
  const [confirmClose, setConfirmClose] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)

  // ── 重命名 ────────────────────────────────────────────────
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const committedRef = useRef(false)

  const beginRename = useCallback(() => {
    if (renameBusy) return
    committedRef.current = false
    setDraft(paneDisplayName(pane, agent))
    setRenameError(null)
    setRenaming(true)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) { el.focus(); el.select() }
    })
  }, [pane, agent, renameBusy])

  const commitRename = useCallback(async () => {
    if (committedRef.current) return
    if (renameBusy) return
    if (!onRename) { setRenaming(false); return }
    let label: string | null
    try { label = validateLabel(draft) } catch (e) { setRenameError(e instanceof Error ? e.message : String(e)); return }
    if (label === paneDisplayName(pane, agent) && label !== null) { setRenaming(false); return }
    committedRef.current = true
    setRenameBusy(true)
    setRenameError(null)
    setRenaming(false)
    try { await onRename(label) } catch (e) { setRenameError(e instanceof Error ? e.message : String(e)) } finally { setRenameBusy(false) }
  }, [draft, renameBusy, onRename, pane, agent])

  const doClose = useCallback(() => {
    if (closeBusy || !onClose) return
    setCloseBusy(true)
    onClose()
    window.setTimeout(() => setCloseBusy(false), 300)
  }, [closeBusy, onClose])

  const maximizeRef = useRef<HTMLButtonElement>(null)

  return (
    <article
      className="herdr-pcard"
      data-focused={pane.focused || undefined}
      data-pane-id={pane.pane_id}
      data-self={self || undefined}
      data-dragging={dragging || undefined}
      data-insert={insert ?? undefined}
      onDragOver={onCardDragOver}
      onDrop={onCardDrop}
      onDragLeave={onCardDragLeave}
    >
      <header className="herdr-pcard-head">
        <span
          className="herdr-pcard-handle"
          draggable
          title={t('pane.drag')}
          onDragStart={onHandleDragStart}
          onDragEnd={onHandleDragEnd}
          onClick={e => e.stopPropagation()}
        >
          ⋮⋮
        </span>
        <StateDot state={dotState(status)} className={muted ? 'herdr-dot-muted' : undefined} />
        {agent ? <span className="herdr-agent-accent" data-accent={agentTheme(agent.agent)} title={agent.agent} /> : null}
        {renaming ? (
          <input
            ref={inputRef}
            className="herdr-pcard-rename-input"
            value={draft}
            maxLength={64}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(false) }}
            onBlur={commitRename}
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
          />
        ) : (
          <span className="herdr-pcard-name" title={pane.pane_id} onDoubleClick={beginRename}>
            {paneDisplayName(pane, agent)}
          </span>
        )}
        {self ? <span className="herdr-pcard-self-tag">{t('panel.selfTag')}</span> : null}
        {agent ? (
          <Pill className="herdr-agent-pill">
            <span className="herdr-agent-name">{agent.agent}</span>
            <span className="herdr-state-text" data-state={displayState} aria-label={stateLabel}>{stateLabel}</span>
          </Pill>
        ) : (
          <Pill className="herdr-agent-pill"><span className="herdr-agent-name">—</span></Pill>
        )}
        <span className="herdr-pcard-actions" onClick={e => e.stopPropagation()}>
          {onMaximize ? (
            <button
              type="button"
              className="herdr-pcard-maximize"
              ref={maximizeRef}
              title={t('pane.maximize')}
              aria-label={t('pane.maximize')}
              onClick={() => onMaximize?.(maximizeRef.current)}
            >
              ⤢
            </button>
          ) : null}
          <button
            type="button"
            className="herdr-pcard-edit"
            title={t('pane.rename')}
            aria-label={t('pane.rename')}
            disabled={renaming || renameBusy}
            onClick={beginRename}
          >
            ✎
          </button>
          {!self && onClose ? (
            <button
              type="button"
              className="herdr-pcard-close"
              title={t('pane.close')}
              aria-label={t('pane.close')}
              ref={closeTriggerRef}
              disabled={closeBusy}
              onClick={event => { closeTriggerRef.current = event.currentTarget; setConfirmClose(true) }}
            >
              ✕
            </button>
          ) : null}
        </span>
      </header>

      <PaneTerminal
        paneId={pane.pane_id}
        status={status}
        accent={agent ? agentTheme(agent.agent) : undefined}
      />

      {renameError ? <div className="herdr-inline-error">{renameError}</div> : null}

      <ConfirmDialog
        visible={confirmClose}
        busy={closeBusy}
        title={t('pane.closeConfirm', { id: pane.pane_id })}
        confirmLabel={t('pane.close')}
        onConfirm={() => { setConfirmClose(false); focusBeforeRemoval(closeTriggerRef.current); closeTriggerRef.current = null; doClose() }}
        onCancel={() => setConfirmClose(false)}
      />
    </article>
  )
}
