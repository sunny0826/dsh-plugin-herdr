import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { applyPaneOrder, buildGroups, loadPaneOrder, reorderPanes, savePaneOrder, validateLabel } from '../client-logic.ts'
import { getPendingFocusPane, setPendingFocusPane, getSessionId } from './navigation.ts'
import { HerdrServerBanner } from './server-banner.tsx'
import { useHerdrStatus, useHerdrStart, setStatusScope, type StatusScope } from './store.ts'
import type { HerdrAgentStatus, HerdrPaneView, HerdrWorkspaceView } from './types.ts'
import { PaneCard } from './pane-card.tsx'
import { ConfirmDialog } from './confirm-dialog.tsx'

// localStorage 键：看板 scope（design-v2 §7.4 契约④）
const SCOPE_STORAGE_KEY = 'herdr:show-all-ws'

/** 读 scope（SSR 防御：无 localStorage / 非法值回退 'project'）。 */
function loadStatusScope(): StatusScope {
  if (typeof localStorage === 'undefined') return 'project'
  return localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'project'
}

// 会话页 header 状态胶囊（conversation.session.header.actions）
export function HerdrHeaderPill() {
  const { snap, refresh } = useHerdrStatus()
  const { starting, startError, start } = useHerdrStart()
  const server = snap?.server
  const running = server?.running === true
  const stopped = snap !== null && server !== null && !running
  const dotCls = running ? 'ok' : stopped ? 'bad' : ''

  return (
    <span className="herdr-pill">
      <span className={"herdr-conn-dot " + dotCls} />
      {running ? 'herdr 运行中' : stopped ? 'herdr 未启动' : 'herdr …'}
      {stopped ? (
        <button
          disabled={starting}
          onClick={() => {
            void start().then(ok => {
              if (ok) refresh()
            })
          }}
        >
          {starting ? '启动中…' : '启动'}
        </button>
      ) : null}
      {startError ? <span className="herdr-server-error">{startError}</span> : null}
    </span>
  )
}

// ── 操作错误采集（关闭失败等，显示在工具栏下方一条横幅） ─────────────
type ActionError = { message: string; key: number }

export function HerdrView() {
  const { snap, error, refresh } = useHerdrStatus()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [openPanes, setOpenPanes] = useState<Set<string>>(new Set())
  // 拖拽状态：dragId（被拖项）、overId + insertPos（目标卡片与插入方向，渲染指示线）
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [insertPos, setInsertPos] = useState<'before' | 'after' | null>(null)

  // ── T11/T12 本地乐观状态 ──────────────────────────────────────────
  // selfPaneId：本对话绑定 pane（不渲染 ✕）
  const [selfPaneId, setSelfPaneId] = useState<string | null>(null)
  // 关闭成功后的本地隐藏集（乐观移除；轮询收敛/失败回滚前过滤展示）
  const [hiddenPaneIds, setHiddenPaneIds] = useState<Set<string>>(new Set())
  const [hiddenWsIds, setHiddenWsIds] = useState<Set<string>>(new Set())
  // 重命名本地覆盖：Map<id, string | null>（null = 清除名称；undefined = 无覆盖）
  const [labelOverrides, setLabelOverrides] = useState<Map<string, string | null>>(new Map())
  // workspace 组头关闭/重命名 UI 状态
  const [closingWs, setClosingWs] = useState<{ ws: HerdrWorkspaceView; paneCount: number } | null>(null)
  const [renamingWs, setRenamingWs] = useState<string | null>(null)
  const [wsDraft, setWsDraft] = useState('')
  // 同步防重入：workspace rename 的 Enter 与随之而来的 blur 各触发一次，用 ref 去重
  const wsCommittedRef = useRef(false)
  const [wsOpBusy, setWsOpBusy] = useState(false)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  // scope 切换（T13）
  const [scope, setScope] = useState<StatusScope>(() => loadStatusScope())
  // 跨 workspace drop 提示（T15）：拖动手柄拖动但未在同 workspace 内落位时显示的顶部横幅
  const [dropHint, setDropHint] = useState<string | null>(null)
  const dropHintTimerRef = useRef<number | undefined>(undefined)
  // 本次拖拽是否已在同 workspace 内成功落位（用于区分「跨 ws / 未落位」与「正常排序」）
  const droppedRef = useRef(false)

  // 应用 scope：初始挂载 + 切换时驱动共享 store
  useEffect(() => {
    setStatusScope(scope)
    if (typeof localStorage !== 'undefined') localStorage.setItem(SCOPE_STORAGE_KEY, scope)
  }, [scope])

  // 卸载时清理 drop 提示定时器
  useEffect(() => () => {
    window.clearTimeout(dropHintTimerRef.current)
  }, [])

  const showErr = useCallback((message: string) => {
    setActionError(prev => ({ message, key: (prev?.key ?? 0) + 1 }))
  }, [])

  // 面板跳转：展开对应 workspace/pane 并滚动高亮（挂载时消费 pending）
  useEffect(() => {
    const focusPane = (paneId: string) => {
      setCollapsed(new Set())
      setOpenPanes(prev => {
        const next = new Set(prev)
        next.add(paneId)
        return next
      })
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-pane-id='${paneId}']`)
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          el.classList.add('herdr-pane-flash')
          window.setTimeout(() => el.classList.remove('herdr-pane-flash'), 1400)
        }
      })
    }
    const handler = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId: string }>).detail?.paneId
      if (paneId) focusPane(paneId)
    }
    document.addEventListener('herdr:focus-pane', handler)
    if (getPendingFocusPane()) {
      focusPane(getPendingFocusPane()!)
      setPendingFocusPane(null)
    }
    return () => document.removeEventListener('herdr:focus-pane', handler)
  }, [])

  // 本对话 pane 绑定查询（参照 pane-list 轮询模式；只读 /herdr-session-pane）
  useEffect(() => {
    let last: string | undefined
    const timer = setInterval(() => {
      const id = getSessionId()
      if (id === last) return
      last = id
      if (!id) {
        setSelfPaneId(null)
        return
      }
      fetch('/herdr-session-pane?agent=' + encodeURIComponent(id))
        .then(r => r.json())
        .then((d: { pane_id?: string | null }) => setSelfPaneId(d.pane_id ?? null))
        .catch(() => setSelfPaneId(null))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const agentByPane = new Map<string, HerdrAgentStatus>((snap?.agents ?? []).map(a => [a.pane_id, a]))
  // panes → workspace_id 映射（跨 workspace drop 校验用）
  const paneWsByPane = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of snap?.topology?.panes ?? []) m.set(p.pane_id, p.workspace_id)
    return m
  }, [snap?.topology])
  // buildGroups 一次 memo（依赖 topology），随后按隐藏集过滤 + 持久化顺序覆盖每个 ws 的 pane 顺序
  const groups = useMemo(() => buildGroups(snap?.topology), [snap?.topology])
  const orderedByWs = useMemo(() => {
    const m = new Map<string, HerdrPaneView[]>()
    for (const g of groups) {
      // 过滤隐藏 + 应用 label override（null=清除→回退 displayName）
      let panes = g.panes
      if (hiddenPaneIds.size > 0) panes = panes.filter(p => !hiddenPaneIds.has(p.pane_id))
      if (labelOverrides.size > 0) {
        panes = panes.map(p => {
          const ov = labelOverrides.get(p.pane_id)
          if (ov === undefined) return p
          return { ...p, label: ov === null ? undefined : ov }
        })
      }
      m.set(g.workspace.workspace_id, applyPaneOrder(panes, loadPaneOrder(g.workspace.workspace_id)))
    }
    return m
  }, [groups, hiddenPaneIds, labelOverrides])
  // workspace 组可见性 + label override
  const visibleGroups = useMemo(() => {
    return groups
      .filter(g => !(hiddenWsIds.has(g.workspace.workspace_id)))
      .map(g => {
        const ov = labelOverrides.get(g.workspace.workspace_id)
        if (ov === undefined) return g
        return { ...g, workspace: { ...g.workspace, label: ov === null ? undefined : ov } }
      })
  }, [groups, hiddenWsIds, labelOverrides])

  const paneCount = snap?.topology?.panes.length ?? snap?.agents.length ?? 0
  const wsCount = visibleGroups.length ?? 0
  const agentCount = snap?.agents.length ?? 0
  const cli = snap?.cli
  const filter = snap?.filter

  const toggleWs = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const togglePane = (id: string) => {
    setOpenPanes(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── T11 关闭交互 ──────────────────────────────────────────────────
  // 通用：POST + 乐观移除 + 失败回滚 + 错误横幅 + refresh
  const postClose = useCallback(async (kind: 'pane' | 'workspace', id: string): Promise<void> => {
    if (kind === 'pane') {
      setHiddenPaneIds(prev => new Set(prev).add(id))
    } else {
      setHiddenWsIds(prev => new Set(prev).add(id))
    }
    try {
      const resp = await fetch('/herdr-close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      })
      const body = (await resp.json()) as { ok?: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `herdr-close HTTP ${resp.status}`)
      refresh()
    } catch (e) {
      // 回滚乐观移除
      if (kind === 'pane') setHiddenPaneIds(prev => { const n = new Set(prev); n.delete(id); return n })
      else setHiddenWsIds(prev => { const n = new Set(prev); n.delete(id); return n })
      showErr(e instanceof Error ? e.message : String(e))
    }
  }, [refresh, showErr])

  const onClosePane = useCallback((paneId: string) => {
    void postClose('pane', paneId)
  }, [postClose])

  const onConfirmCloseWs = useCallback(() => {
    if (!closingWs || wsOpBusy) return
    setWsOpBusy(true)
    void postClose('workspace', closingWs.ws.workspace_id).finally(() => {
      setWsOpBusy(false)
      // 成功时 closingWs 已无意义；失败也已回滚。UI 上关闭对话框
      setClosingWs(null)
    })
  }, [closingWs, wsOpBusy, postClose])

  // ── T12 重命名交互 ────────────────────────────────────────────────
  const doRename = useCallback(async (kind: 'pane' | 'workspace', id: string, label: string | null): Promise<void> => {
    try {
      const resp = await fetch('/herdr-rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, id, label }),
      })
      const body = (await resp.json()) as { ok?: boolean; error?: string }
      if (!body.ok) throw new Error(body.error ?? `herdr-rename HTTP ${resp.status}`)
      // 乐观覆盖可持续展示（服务端持久化后 refresh 收敛；此处保留覆盖避免闪回）
      setLabelOverrides(prev => { const n = new Map(prev); n.set(id, label); return n })
      refresh()
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e))
    }
  }, [refresh])

  const onRenamePane = useCallback((paneId: string, label: string | null) => {
    return doRename('pane', paneId, label)
  }, [doRename])

  // workspace 重命名：进入 inline input
  const beginRenameWs = useCallback((g: { workspace: HerdrWorkspaceView }) => {
    if (wsOpBusy) return
    wsCommittedRef.current = false
    setRenamingWs(g.workspace.workspace_id)
    setWsDraft(g.workspace.label ?? g.workspace.workspace_id)
    setActionError(null)
  }, [wsOpBusy])

  const commitRenameWs = useCallback(async (wsId: string) => {
    if (wsCommittedRef.current || wsOpBusy) return
    let label: string | null
    try {
      label = validateLabel(wsDraft)
    } catch (e) {
      showErr(e instanceof Error ? e.message : String(e))
      return
    }
    wsCommittedRef.current = true // 防 Enter+blur 双提交
    setRenamingWs(null)
    setWsOpBusy(true)
    try {
      await doRename('workspace', wsId, label)
    } catch (e) {
      showErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWsOpBusy(false)
    }
  }, [wsDraft, doRename, showErr, wsOpBusy])

  // ── 拖拽事件（HTML5 DnD，仅同 workspace 排序） ──────────────────────────

  /** 手柄 dragstart：写入自定义 MIME + 标记被拖项。 */
  const onHandleDragStart = useCallback((e: DragEvent, paneId: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/herdr-pane', paneId)
    setDragId(paneId)
    droppedRef.current = false // 本次拖拽尚未落位
  }, [])

  /** 手柄 dragend：清理所有拖拽状态（含拖到空白 / 跨 ws 取消）。 */
  const clearDrag = useCallback(() => {
    setDragId(null)
    setOverId(null)
    setInsertPos(null)
  }, [])
  const onHandleDragEnd = useCallback((e: DragEvent) => {
    void e
    // 拖拽待结算（未同 ws 落位）：说明用户拖到了跨 workspace / 空白处且被忽略 → 一次性提示
    if (dragId && !droppedRef.current) {
      setDropHint('拖拽仅支持同 workspace 内排序')
      window.clearTimeout(dropHintTimerRef.current)
      dropHintTimerRef.current = window.setTimeout(() => setDropHint(null), 2000)
    }
    clearDrag()
  }, [dragId, clearDrag])

  /** 目标卡片 dragover：preventDefault（否则 drop 不触发）+ 按指针水平半分判定 before/after。 */
  const onCardDragOver = useCallback((e: DragEvent, targetId: string, targetWsId: string) => {
    if (!dragId) return
    if (paneWsByPane.get(dragId) !== targetWsId) return // 跨 workspace：不显示指示
    if (dragId === targetId) return // 拖到自身：不显示指示
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const el = e.currentTarget
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect()
      // 两列按行序排布→水平判定：指针在卡片左半 → before，右半 → after
      const pos: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      setOverId(targetId)
      setInsertPos(pos)
    }
  }, [dragId, paneWsByPane])

  const onCardDragLeave = useCallback(() => {
    setOverId(null)
    setInsertPos(null)
  }, [])

  /** 目标卡片 drop：同 ws 内落位 → reorderPanes → savePaneOrder。 */
  const onCardDrop = useCallback((e: DragEvent, targetId: string, targetWsId: string) => {
    e.preventDefault()
    if (!dragId) return
    if (paneWsByPane.get(dragId) !== targetWsId) return // 跨 workspace：忽略 + 清理
    const ordered = orderedByWs.get(targetWsId) ?? []
    const from = ordered.findIndex(p => p.pane_id === dragId)
    const toTarget = ordered.findIndex(p => p.pane_id === targetId)
    if (from < 0 || toTarget < 0) return
    // 落位后索引 to：考虑"先移除被拖项致目标项左移一位"的位移（见 client-logic.reorderPanes 注释）
    const to = insertPos === 'before'
      ? (from < toTarget ? toTarget - 1 : toTarget)
      : (from < toTarget ? toTarget : toTarget + 1)
    const newOrder = reorderPanes(ordered.map(p => p.pane_id), from, to)
    savePaneOrder(targetWsId, newOrder)
    droppedRef.current = true
    clearDrag()
  }, [dragId, insertPos, orderedByWs, paneWsByPane, clearDrag])

  // scope=all 时的过滤提示：仅当存在过滤元数据且 total>0 时
  const showFilterHint = scope === 'project' && !!filter && filter.total > 0
  const filteredEmpty =
    scope === 'project' && groups.length === 0 && !!filter && filter.total > 0 && filter.matched === 0
  const scopeAll = scope === 'all'

  // 渲染 workspace 名区域：重命名 input 或（label + id + ✎）
  const renderWsName = (g: { workspace: HerdrWorkspaceView }) => {
    if (renamingWs === g.workspace.workspace_id) {
      return (
        <input
          className="herdr-ws-rename-input"
          autoFocus
          maxLength={64}
          value={wsDraft}
          onChange={e => setWsDraft(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') void commitRenameWs(g.workspace.workspace_id)
            else if (e.key === 'Escape') setRenamingWs(null) // 取消不提交
          }}
          onBlur={() => void commitRenameWs(g.workspace.workspace_id)}
          onClick={e => e.stopPropagation()}
        />
      )
    }
    return (
      <span className="herdr-ws-name" onDoubleClick={() => beginRenameWs(g)}>
        <span className="herdr-ws-label">{g.workspace.label ?? g.workspace.workspace_id}</span>
        <button
          type="button"
          className="herdr-ws-edit"
          title="重命名 workspace"
          disabled={wsOpBusy}
          onClick={e => { e.stopPropagation(); beginRenameWs(g) }}
        >
          ✎
        </button>
      </span>
    )
  }

  return (
    <div className="herdr-root">
      <HerdrServerBanner snap={snap} error={error} onStarted={refresh} />

      {dropHint ? <div className="herdr-drop-hint">{dropHint}</div> : null}

      <div className="herdr-head">
        <span className="herdr-head-title">Herdr</span>
        <span className="herdr-head-stats">
          {wsCount} workspaces · {paneCount} panes · {agentCount} agents
          {showFilterHint ? (
            <span className="herdr-filter-hint" title="在项目目录内打开的 herdr 只显示本目录 workspace">
              仅本项目（{filter!.matched}/{filter!.total}）
            </span>
          ) : scopeAll && filter && filter.total > 0 ? (
            <span className="herdr-filter-hint" title="当前显示全部 workspace">
              全部（{filter.total}）
            </span>
          ) : null}
        </span>
        <span className="herdr-head-actions">
          <div className="herdr-scope-toggle" role="group" aria-label="看板范围">
            <button
              type="button"
              className={'herdr-scope-pill' + (scope === 'project' ? ' active' : '')}
              title="只显示本项目目录内的 workspace"
              onClick={() => setScope('project')}
            >
              仅本项目
            </button>
            <button
              type="button"
              className={'herdr-scope-pill' + (scope === 'all' ? ' active' : '')}
              title="显示全部项目目录的 workspace"
              onClick={() => setScope('all')}
            >
              显示全部
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>刷新</Button>
        </span>
      </div>

      {error ? <div className="herdr-server-error">herdr status: {error}</div> : null}
      {actionError ? (
        <div className="herdr-action-error" key={actionError.key}>
          <span>{actionError.message}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="关闭">✕</button>
        </div>
      ) : null}

      {snap && cli && !cli.available ? (
        <div className="herdr-install">
          <div className="herdr-install-title">herdr CLI is not installed</div>
          The Herdr panel needs the <code>herdr</code> binary to inspect and control panes. Install it:
          <br />
          <code>curl -fsSL https://herdr.dev/install.sh | sh</code>
          <br />
          Windows: <code>powershell -ExecutionPolicy Bypass -c &quot;irm https://herdr.dev/install.ps1 | iex&quot;</code>
          <br />
          Homebrew / mise / Nix and verification: <a href="https://herdr.dev/docs/install/" target="_blank" rel="noreferrer">herdr.dev/docs/install</a>
        </div>
      ) : null}

      {visibleGroups.length === 0 ? (
        <div className="herdr-empty">
          {filteredEmpty ? (
            <>
              当前目录没有 herdr workspace。
              <br />
              <button type="button" className="herdr-empty-show-all" onClick={() => setScope('all')}>
                显示全部
              </button>
            </>
          ) : (
            <>
              No panes yet.
              <br />
              Start a coding agent in a Herdr pane (e.g. <code>claude</code>) and it will appear here with live output.
            </>
          )}
        </div>
      ) : (
        <div className="herdr-ws-list">
          {visibleGroups.map(g => {
            const wsPanes = orderedByWs.get(g.workspace.workspace_id) ?? g.panes
            return (
              <section key={g.workspace.workspace_id} className="herdr-ws" data-collapsed={collapsed.has(g.workspace.workspace_id) || undefined}>
                <div className="herdr-ws-head" onClick={() => toggleWs(g.workspace.workspace_id)}>
                  <svg className="herdr-ws-chev" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z" /></svg>
                  {renderWsName(g)}
                  <span className="herdr-ws-stats">
                    <b>{wsPanes.length}</b> panes · <b>{wsPanes.filter(p => agentByPane.has(p.pane_id)).length}</b> agents
                    {g.tabs.length > 0 ? (' · tab ' + g.tabs[0].tab_id) : ''}
                  </span>
                  <button
                    type="button"
                    className="herdr-ws-close"
                    title="关闭 workspace"
                    onClick={e => {
                      e.stopPropagation()
                      if (wsOpBusy) return
                      setClosingWs({ ws: g.workspace, paneCount: g.panes.length })
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="herdr-ws-body">
                  {wsPanes.map(pane => (
                    <PaneCard
                      key={pane.pane_id}
                      pane={pane}
                      agent={agentByPane.get(pane.pane_id)}
                      open={openPanes.has(pane.pane_id)}
                      onToggle={() => togglePane(pane.pane_id)}
                      self={pane.pane_id === selfPaneId}
                      onClose={() => onClosePane(pane.pane_id)}
                      onRename={label => onRenamePane(pane.pane_id, label)}
                      dragging={dragId === pane.pane_id}
                      insert={overId === pane.pane_id ? insertPos : null}
                      onHandleDragStart={e => onHandleDragStart(e, pane.pane_id)}
                      onHandleDragEnd={onHandleDragEnd}
                      onCardDragOver={e => onCardDragOver(e, pane.pane_id, g.workspace.workspace_id)}
                      onCardDrop={e => onCardDrop(e, pane.pane_id, g.workspace.workspace_id)}
                      onCardDragLeave={onCardDragLeave}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        visible={closingWs !== null}
        busy={wsOpBusy}
        title={closingWs ? <>关闭 workspace <code>{closingWs.ws.label ?? closingWs.ws.workspace_id}</code> 及其 {closingWs.paneCount} 个 pane？</> : ''}
        confirmLabel="关闭"
        onConfirm={() => void onConfirmCloseWs()}
        onCancel={() => { if (!wsOpBusy) setClosingWs(null) }}
      />
    </div>
  )
}
