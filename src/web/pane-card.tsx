// PaneCard：pane 纵向卡片（替代 PaneRow 行式结构），日志主体用 PaneLog。
// header 为后续任务预留 actions 区域（T10 拖拽手柄，T11 关闭 ✕，T12 改名 ✎）。
// 拖拽交互（HTML5 DnD）：仅 ⋮⋮ 手柄可拖（draggable），卡片本体不可拖以免与"点击展开"冲突；
// 事件由 herdr-view 通过 props 透传（handle 上 onDragStart/onDragEnd，卡片本体上 onDragOver/onDrop/onDragLeave）。

import { useCallback, useRef, useState, type DragEvent } from 'react'
import { Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { agentTheme, dotState, formatTime, validateLabel } from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import type { HerdrAgentStatus, HerdrPaneView } from './types.ts'
import { PaneLog } from './pane-log.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'

/** 显示名：label（用户改名）> title（含 terminal_title 合并）> pane_id。 */
export function displayName(pane: HerdrPaneView): string {
  return pane.label ?? pane.title ?? pane.pane_id
}

/** 拖拽相关 props（由 HerdrView 注入；undefined 时手柄不渲染拖拽行为）。 */
export interface PaneCardDragProps {
  /** 本卡片是否为当前被拖动项（半透明高亮）。 */
  dragging?: boolean
  /** 本卡片上的插入指示位：before / after。 */
  insert?: 'before' | 'after' | null
  /** 手柄 dragstart（写入 dataTransfer + 上报 dragId）。 */
  onHandleDragStart?: (e: DragEvent) => void
  /** 手柄 dragend（清理状态）。 */
  onHandleDragEnd?: (e: DragEvent) => void
  /** 卡片本体 dragover（preventDefault + 判定插入位）。 */
  onCardDragOver?: (e: DragEvent) => void
  /** 卡片本体 drop（落位 + 持久化）。 */
  onCardDrop?: (e: DragEvent) => void
  /** 卡片本体 dragleave（清插入指示）。 */
  onCardDragLeave?: (e: DragEvent) => void
}

export function PaneCard({
  pane,
  agent,
  open,
  onToggle,
  self = false,
  onClose,
  onRename,
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
  open: boolean
  onToggle: () => void
  /** true = 本对话自身 pane（不渲染 ✕，服务端同时兜底拒绝）。 */
  self?: boolean
  /** 关闭确认通过后由父组件执行 POST /herdr-close（乐观移除）。 */
  onClose?: () => void
  /** 重命名提交（label 已校验；null = 清除名称）。由父组件执行 POST /herdr-rename；
   *  返回 promise：pending 期间禁用 input，reject 时在卡片内展示错误。 */
  onRename?: (label: string | null) => Promise<void> | void
} & PaneCardDragProps) {
  // 语言订阅：切语言时标题/按钮/确认文案跟随
  void useHerdrLang()
  const status = agent?.status ?? pane.agent_status
  const muted = !status || status === 'unknown'
  const cwd = pane.cwd ?? pane.foreground_cwd ?? ''

  // ── 关闭确认（T11） ──────────────────────────────────────────────
  const [confirmClose, setConfirmClose] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)

  // ── 重命名（T12） ────────────────────────────────────────────────
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 同步防重入：Enter 与随后的 blur 会各自触发 commit，用 ref 保证只提交一次；
  // 进入编辑（beginRename）时复位。
  const committedRef = useRef(false)

  const copy = useCallback(async () => {
    const text = agent?.output ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (e) {
      // 剪贴板写入失败（如无权限）静默；人工验收项
      console.warn('[herdr] copy failed', e)
    }
  }, [agent?.output])

  // 进入重命名：draft 取当前显示名，input select-all（渲染后选中）
  const beginRename = useCallback(() => {
    if (renameBusy) return
    committedRef.current = false
    setDraft(displayName(pane))
    setRenameError(null)
    setRenaming(true)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    })
  }, [pane, renameBusy])

  // 提交：清空 → null（清除名称）；否则校验；失败内联错误，成功退出编辑。
  // Enter 与失焦都会调用；用 committedRef 保证 Enter+blur 只提交一次。
  const commitRename = useCallback(async () => {
    if (committedRef.current) return
    if (renameBusy) return
    if (!onRename) {
      setRenaming(false)
      return
    }
    let label: string | null
    try {
      label = validateLabel(draft)
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e))
      return
    }
    if (label === displayName(pane) && label !== null) {
      setRenaming(false) // 未变更，直接关闭
      return
    }
    committedRef.current = true // 防止 Enter+blur 双提交
    setRenameBusy(true)
    setRenameError(null)
    setRenaming(false)
    try {
      await onRename(label)
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e))
    } finally {
      setRenameBusy(false)
    }
  }, [draft, renameBusy, onRename, pane])

  // 关闭确认点击确定：父组件执行 POST（乐观移除 + 失败回滚/错误由父组件展示）。
  // busy 短暂保持以防双击；卡片若成功会被乐观移除（此刻卸载），失败回滚后重挂载。
  const doClose = useCallback(() => {
    if (closeBusy || !onClose) return
    setCloseBusy(true)
    onClose()
    window.setTimeout(() => setCloseBusy(false), 300)
  }, [closeBusy, onClose])

  return (
    <article
      className="herdr-pcard"
      data-focused={pane.focused || undefined}
      data-open={open || undefined}
      data-pane-id={pane.pane_id}
      data-self={self || undefined}
      data-dragging={dragging || undefined}
      data-insert={insert ?? undefined}
      onDragOver={onCardDragOver}
      onDrop={onCardDrop}
      onDragLeave={onCardDragLeave}
    >
      <header className="herdr-pcard-head" onClick={onToggle}>
        <span
          className="herdr-pcard-handle"
          draggable
          title={t('pane.drag')}
          onDragStart={onHandleDragStart}
          onDragEnd={onHandleDragEnd}
          onClick={e => e.stopPropagation()} // 拖动手柄不触发卡片展开
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
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRenaming(false) // 取消不提交
            }}
            onBlur={commitRename} // 失焦提交
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
          />
        ) : (
          <span className="herdr-pcard-name" title={pane.pane_id} onDoubleClick={beginRename}>
            {displayName(pane)}
          </span>
        )}
        {agent ? (
          <Pill className="herdr-agent-pill">
            <span className="herdr-agent-name">{agent.agent}</span>
            <span className="herdr-state-text" data-state={dotState(status)}>{status ?? 'unknown'}</span>
          </Pill>
        ) : (
          <Pill className="herdr-agent-pill"><span className="herdr-agent-name">—</span></Pill>
        )}
        {/* header 右侧 actions 区：✎（T12）+ ✕（T11） */}
        <span className="herdr-pcard-actions" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="herdr-pcard-edit"
            title={t('pane.rename')}
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
              disabled={closeBusy}
              onClick={() => setConfirmClose(true)}
            >
              ✕
            </button>
          ) : null}
        </span>
        <time className="herdr-pcard-time">{agent ? formatTime(agent.updated_at) : ''}</time>
        <svg className="herdr-pcard-chev" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
      </header>

      {cwd ? <div className="herdr-pcard-cwd">{cwd}</div> : null}

      <PaneLog agent={agent} open={open} accent={agent ? agentTheme(agent.agent) : undefined} />

      {renameError ? <div className="herdr-inline-error">{renameError}</div> : null}

      <footer className="herdr-pcard-foot">
        <button className="herdr-pcard-foot-btn" type="button" onClick={onToggle}>
          {open ? t('pane.collapse') : t('pane.expand')}
        </button>
        {!agent && !(pane.agent_status) ? <span className="herdr-pcard-empty">{t('pane.noOutput')}</span> : null}
        <button
          className="herdr-pcard-foot-btn"
          type="button"
          onClick={copy}
          disabled={!(agent?.output)}
        >
          {t('pane.copy')}
        </button>
      </footer>

      <ConfirmDialog
        visible={confirmClose}
        busy={closeBusy}
        title={t('pane.closeConfirm', { id: pane.pane_id })}
        confirmLabel={t('pane.close')}
        onConfirm={() => { setConfirmClose(false); doClose() }}
        onCancel={() => setConfirmClose(false)}
      />
    </article>
  )
}
