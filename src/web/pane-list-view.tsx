import { useCallback, useEffect, useRef, useState } from 'react'
import { Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  agentTheme,
  ariaStateLabel,
  dotState,
  paneDisplayName,
  paneDisplayState,
} from '../client-logic.ts'
import { t, useHerdrLang } from './i18n.ts'
import { clampNavWidth, getNavWidth, setNavWidth, DEFAULT_NAV_WIDTH } from './layout-mode.ts'
import type { HerdrAgentStatus, HerdrPaneView } from './types.ts'
import { PaneTerminal } from './pane-terminal.tsx'

function PaneListNavRow({
  pane,
  agent,
  active,
  self,
  onSelect,
}: {
  pane: HerdrPaneView
  agent: HerdrAgentStatus | undefined
  active: boolean
  self: boolean
  onSelect: () => void
}) {
  const status = agent?.status ?? pane.agent_status
  const displayState = paneDisplayState(status)
  return (
    <div
      role='option'
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className='herdr-list-row'
      data-active={active || undefined}
      data-self={self || undefined}
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <StateDot state={dotState(status)} className={displayState === 'unknown' ? 'herdr-dot-muted' : undefined} />
      {agent ? <span className='herdr-agent-accent' data-accent={agentTheme(agent.agent)} title={agent.agent} /> : null}
      <span className='herdr-list-row-name' title={pane.pane_id}>{paneDisplayName(pane, agent)}</span>
      {self ? <span className='pl-self-tag'>{t('panel.selfTag')}</span> : null}
      {agent ? (
        <span className='herdr-list-row-agent' title={agent.agent}>{agent.agent}</span>
      ) : null}
    </div>
  )
}

export function PaneListView({
  panes,
  agentByPane,
  selfPaneId,
  activePaneId,
  onSelect,
  onClosePane,
  onRenamePane,
  wsId,
}: {
  panes: HerdrPaneView[]
  agentByPane: Map<string, HerdrAgentStatus>
  selfPaneId: string | null
  activePaneId: string | null
  onSelect: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onRenamePane: (paneId: string, label: string | null) => Promise<void>
  wsId: string
}) {
  void useHerdrLang()
  const activePane = activePaneId ? panes.find(p => p.pane_id === activePaneId) ?? null : null
  const activeAgent = activePaneId ? agentByPane.get(activePaneId) : undefined
  const [navWidth, setNavWidthState] = useState<number>(() => getNavWidth(wsId))
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWRef = useRef(DEFAULT_NAV_WIDTH)

  useEffect(() => {
    setNavWidthState(getNavWidth(wsId))
  }, [wsId])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true
    startXRef.current = e.clientX
    startWRef.current = navWidth
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [navWidth])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    const dx = e.clientX - startXRef.current
    const next = clampNavWidth(startWRef.current + dx)
    setNavWidthState(next)
    const ev = new CustomEvent('herdr:layout-changed')
    window.dispatchEvent(ev)
    document.dispatchEvent(ev)
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    setNavWidth(navWidth, wsId)
  }, [wsId, navWidth])

  // keyboard navigation in list
  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (panes.length === 0) return
    const idx = activePaneId ? panes.findIndex(p => p.pane_id === activePaneId) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = idx < 0 ? 0 : Math.min(panes.length - 1, idx + 1)
      onSelect(panes[next].pane_id)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = idx < 0 ? 0 : Math.max(0, idx - 1)
      onSelect(panes[prev].pane_id)
    }
  }, [panes, activePaneId, onSelect])

  if (panes.length === 0) return null

  // ensure active exists otherwise fallback
  const effectiveActiveId = activePane?.pane_id ?? panes[0]?.pane_id ?? null
  const effectiveActive = effectiveActiveId ? panes.find(p => p.pane_id === effectiveActiveId) ?? null : null
  const effectiveAgent = effectiveActiveId ? agentByPane.get(effectiveActiveId) : undefined

  return (
    <div className='herdr-list-layout'>
      <div
        className='herdr-list-nav'
        role='listbox'
        aria-label={t('view.layoutList')}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        style={{ width: navWidth }}
      >
        {panes.map(pane => (
          <PaneListNavRow
            key={pane.pane_id}
            pane={pane}
            agent={agentByPane.get(pane.pane_id)}
            active={pane.pane_id === effectiveActiveId}
            self={pane.pane_id === selfPaneId}
            onSelect={() => onSelect(pane.pane_id)}
          />
        ))}
      </div>
      <div
        className='herdr-list-resizer'
        role='separator'
        aria-orientation='vertical'
        aria-label='Resize'
        data-dragging={draggingRef.current || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className='herdr-list-detail'>
        {effectiveActive ? (
          <>
            <div className='herdr-list-detail-head'>
              <span className='herdr-list-detail-title' title={effectiveActive.pane_id}>
                {paneDisplayName(effectiveActive, effectiveAgent)}
              </span>
              {effectiveAgent ? (
                <Pill className='herdr-agent-pill'>
                  <span className='herdr-agent-name'>{effectiveAgent.agent}</span>
                  <span className='herdr-state-text' data-state={paneDisplayState(effectiveAgent.status)}>{t(ariaStateLabel(paneDisplayState(effectiveAgent.status)))}</span>
                </Pill>
              ) : null}
              {effectiveActive.pane_id === selfPaneId ? <span className='herdr-pcard-self-tag'>{t('panel.selfTag')}</span> : null}
              <span className='herdr-list-detail-meta' />
              <span className='herdr-pcard-actions' style={{ marginLeft: 'auto' }}>
                <button
                  type='button'
                  className='herdr-pcard-edit'
                  title={t('pane.rename')}
                  aria-label={t('pane.rename')}
                  style={{ opacity: 1 }}
                  onClick={() => {
                    const name = paneDisplayName(effectiveActive, effectiveAgent)
                    const next = window.prompt(t('pane.rename') as string, name)
                    if (next === null) return
                    const trimmed = next.trim()
                    const label = trimmed === '' ? null : trimmed.slice(0, 64)
                    void onRenamePane(effectiveActive.pane_id, label)
                  }}
                >
                  ✎
                </button>
                {effectiveActive.pane_id !== selfPaneId ? (
                  <button
                    type='button'
                    className='herdr-pcard-close'
                    title={t('pane.close')}
                    aria-label={t('pane.close')}
                    style={{ opacity: 1 }}
                    onClick={() => onClosePane(effectiveActive.pane_id)}
                  >
                    ✕
                  </button>
                ) : null}
              </span>
            </div>
            <PaneTerminal
              paneId={effectiveActive.pane_id}
              status={effectiveAgent?.status ?? effectiveActive.agent_status}
              accent={effectiveAgent ? agentTheme(effectiveAgent.agent) : undefined}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}
