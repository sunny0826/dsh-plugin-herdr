// PaneTerminal：优先使用 Herdr terminal session observer/controller（实时 ANSI frame 流）。
// - observer 只读；点击终端 → requestControl；controlling 下输入/缩放经 controller 命令；
// - 已有 controller 时进入 conflict 横幅，用户二次确认后才 takeover；
// - terminal session 不可用时回退 viewport ANSI 快照（events.wait + pane.read）+ 兼容模式。

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { agentTheme, dotState, type AgentAccent } from '../client-logic.ts'
import {
  fetchTerminalBootstrap,
  sendPaneInput,
  waitForTerminalChange,
  type TerminalBootstrapResult,
} from './store.ts'
import { terminalSessionStore, type TerminalStoreSignal } from './terminal-session.ts'
import { rebaseTerminalFrame, trimAnsiSnapshotPadding } from '../terminal-ansi.ts'
import { t, useHerdrLang } from './i18n.ts'
import { resolveTerminalFontFamily } from './terminal-font.ts'

const CYBERDREAM_DARK: Record<string, string> = {
  background: '#16181a',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#16181a',
  selectionBackground: '#3c4048',
  selectionForeground: '#ffffff',
  black: '#16181a',
  red: '#ff6e5e',
  green: '#5eff6c',
  yellow: '#f1ff5e',
  blue: '#5ea1ff',
  magenta: '#bd5eff',
  cyan: '#5ef1ff',
  white: '#ffffff',
  brightBlack: '#3c4048',
  brightRed: '#ff6e5e',
  brightGreen: '#5eff6c',
  brightYellow: '#f1ff5e',
  brightBlue: '#5ea1ff',
  brightMagenta: '#bd5eff',
  brightCyan: '#5ef1ff',
  brightWhite: '#ffffff',
}

const CLAUDE_CODE_LIGHT: Record<string, string> = {
  background: '#faf9f5',
  foreground: '#141413',
  cursor: '#d97757',
  cursorAccent: '#faf9f5',
  selectionBackground: '#f0d5c6',
  selectionForeground: '#141413',
  black: '#141413',
  red: '#dc2626',
  green: '#788c5d',
  yellow: '#c08c3a',
  blue: '#6a9bcc',
  magenta: '#9588a8',
  cyan: '#6a9b91',
  white: '#e8e6dc',
  brightBlack: '#6b6a65',
  brightRed: '#ef4444',
  brightGreen: '#8ca075',
  brightYellow: '#d0a052',
  brightBlue: '#88b3dc',
  brightMagenta: '#a99cba',
  brightCyan: '#7fb0a6',
  brightWhite: '#faf9f5',
}

function isDarkMode(): boolean {
  return typeof document !== 'undefined' && !!document.body?.hasAttribute('data-ds-dark-theme')
}

function computeXtermTheme(): Record<string, string> {
  return isDarkMode() ? CYBERDREAM_DARK : CLAUDE_CODE_LIGHT
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = window.setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      window.clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export interface PaneTerminalProps {
  paneId: string
  status?: string
  accent?: AgentAccent
  maximized?: boolean
  readOnly?: boolean
  agent?: string
}

type IoMode = 'observer' | 'controlling' | 'snapshot'

export function PaneTerminal({ paneId, status, accent, maximized, readOnly = false, agent }: PaneTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const ioModeRef = useRef<IoMode>('observer')
  const [syncStatus, setSyncStatus] = useState<'syncing' | 'ready' | 'error'>('syncing')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [historyIncomplete, setHistoryIncomplete] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [compatMode, setCompatMode] = useState(false)
  const [idleHint, setIdleHint] = useState(false)
  const lastInputAtRef = useRef<number>(Date.now())
  const hiddenSinceRef = useRef<number | null>(null)
  const escSelectionPendingRef = useRef(false)
  void useHerdrLang()

  const currentSize = (): { cols: number; rows: number } => {
    const term = terminalRef.current
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 }
  }

  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: resolveTerminalFontFamily(host),
      lineHeight: 1.2,
      scrollback: 5000,
      theme: computeXtermTheme(),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const input = terminal.onData(data => {
      lastInputAtRef.current = Date.now()
      setIdleHint(false)
      const mode = ioModeRef.current
      if (mode === 'observer') return
      setInputError(null)
      if (mode === 'controlling') {
        terminalSessionStore.sendInput(paneId, bytes(data))
      } else {
        void sendPaneInput(paneId, { text: data }).catch(error => {
          setInputError(error instanceof Error ? error.message : String(error))
        })
      }
    })
    const fit = () => {
      try { fitAddon.fit() } catch { /* ignore measure race */ }
    }
    const fitAndNotify = () => {
      fit()
      if (ioModeRef.current === 'controlling') {
        lastInputAtRef.current = Date.now()
        setIdleHint(false)
        terminalSessionStore.resize(paneId, currentSize())
      }
    }
    let notifyTimer: number | undefined
    const scheduleFit = () => {
      fit()
      if (notifyTimer !== undefined) window.clearTimeout(notifyTimer)
      notifyTimer = window.setTimeout(() => {
        notifyTimer = undefined
        if (ioModeRef.current === 'controlling') {
          lastInputAtRef.current = Date.now()
          setIdleHint(false)
          terminalSessionStore.resize(paneId, currentSize())
        }
      }, 120)
    }
    const ro = new ResizeObserver(() => scheduleFit())
    ro.observe(host)
    if (host.parentElement) ro.observe(host.parentElement)
    const card = host.closest('.herdr-pcard, .herdr-list-detail, .herdr-terminal-maximized') as HTMLElement | null
    if (card && card !== host.parentElement) ro.observe(card)
    const onWindowResize = () => fitAndNotify()
    window.addEventListener('resize', onWindowResize)
    let raf1 = requestAnimationFrame(() => {
      fit()
      raf1 = requestAnimationFrame(() => fitAndNotify())
    })
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) fitAndNotify()
    }, { threshold: 0 })
    io.observe(host)
    const onLayout = () => {
      requestAnimationFrame(() => fitAndNotify())
      window.setTimeout(() => fitAndNotify(), 180)
    }
    window.addEventListener('herdr:layout-changed', onLayout as EventListener)
    document.addEventListener('herdr:layout-changed', onLayout as EventListener)

    return () => {
      if (notifyTimer !== undefined) window.clearTimeout(notifyTimer)
      cancelAnimationFrame(raf1)
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('herdr:layout-changed', onLayout as EventListener)
      document.removeEventListener('herdr:layout-changed', onLayout as EventListener)
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [paneId])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let mode: IoMode = 'observer'
    let observerSucceeded = false
    let snapshotStarted = false
    let historyReady = false
    let historySeeded = false
    const pendingFrames: Array<{ bytesArr: Uint8Array; seq: number; full: boolean }> = []
    const writeFrame = (frame: { bytesArr: Uint8Array; seq: number; full: boolean }): void => {
      const t = terminalRef.current
      if (!t) return
      t.write(rebaseTerminalFrame(frame.bytesArr, frame.full), () => terminalSessionStore.confirmFrame(paneId, frame.seq))
    }
    const flushFrames = (): void => {
      for (const f of pendingFrames.splice(0)) {
        writeFrame(f)
      }
    }

    const setMode = (m: IoMode): void => {
      mode = m
      ioModeRef.current = m
      if (m === 'snapshot') setCompatMode(true)
    }

    const renderSnapshot = async (initial: boolean): Promise<TerminalBootstrapResult> => {
      if (initial) setSyncStatus('syncing')
      const result = await fetchTerminalBootstrap(paneId, undefined, signal)
      if (signal.aborted) return result
      const terminal = terminalRef.current
      if (!terminal) return result
      const buffer = terminal.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      const viewportY = buffer.viewportY
      terminal.reset()
      terminal.write(trimAnsiSnapshotPadding(result.text), () => {
        if (atBottom) terminal.scrollToBottom()
        else terminal.scrollToLine(viewportY)
      })
      setHistoryIncomplete(result.truncated)
      setSyncError(null)
      setSyncStatus('ready')
      return result
    }

    const runSnapshot = async (): Promise<void> => {
      let revision: number | undefined
      let retryMs = 500
      while (!signal.aborted) {
        try {
          if (revision === undefined) {
            const snapshot = await renderSnapshot(true)
            revision = snapshot.revision
            if (revision === undefined) { await abortableDelay(1_000, signal); continue }
          }
          const change = await waitForTerminalChange(paneId, revision, signal)
          if (signal.aborted) return
          if (!change.changed) continue
          const deltaB64 = change.bytes ?? change.delta
          if (typeof deltaB64 === 'string' && deltaB64.length > 0) {
            const terminal = terminalRef.current
            if (terminal) {
              const buf = terminal.buffer.active
              const atBottom = buf.viewportY >= buf.baseY
              let bytesArr: Uint8Array | null = null
              try {
                const raw = atob(deltaB64)
                bytesArr = Uint8Array.from(raw, c => c.charCodeAt(0))
              } catch { bytesArr = null }
              if (bytesArr) {
                terminal.write(rebaseTerminalFrame(bytesArr, change.full === true), () => {
                  if (atBottom) terminal.scrollToBottom()
                })
                revision = change.revision
                retryMs = 500
                continue
              }
            }
          }
          await renderSnapshot(false)
          revision = change.revision
          retryMs = 500
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return
          setSyncError(error instanceof Error ? error.message : String(error))
          setSyncStatus('error')
          revision = undefined
          await abortableDelay(retryMs, signal)
          retryMs = Math.min(retryMs * 2, 5_000)
        }
      }
    }

    const startSnapshot = (): void => {
      if (snapshotStarted || signal.aborted) return
      snapshotStarted = true
      setMode('snapshot')
      setSyncStatus('syncing')
      void runSnapshot()
    }

    const onStoreSignal = (sig: TerminalStoreSignal): void => {
      if (signal.aborted) return
      if (sig.type === 'frame') {
        if (mode !== 'observer' && mode !== 'controlling') return
        observerSucceeded = true
        setSyncStatus('ready')
        setSyncError(null)
        setHistoryIncomplete(false)
        const terminal = terminalRef.current
        if (!terminal) return
        const raw = atob(sig.bytes)
        const bytesArr = Uint8Array.from(raw, c => c.charCodeAt(0))
        if (historyReady) {
          writeFrame({ bytesArr, seq: sig.seq, full: sig.full })
          return
        }
        if (!historySeeded) {
          historySeeded = true
          void fetchTerminalBootstrap(paneId, 500, signal, 'recent_unwrapped')
            .then(hist => {
              if (signal.aborted) return
              const t = terminalRef.current
              if (!t) return
              t.write(trimAnsiSnapshotPadding(hist.text), () => {
                historyReady = true
                flushFrames()
              })
            })
            .catch(() => {
              historyReady = true
              flushFrames()
            })
        }
        pendingFrames.push({ bytesArr, seq: sig.seq, full: sig.full })
        return
      } else if (sig.status === 'observing') {
        observerSucceeded = true
        setMode('observer')
        setSyncStatus('ready')
        setSyncError(null)
      } else if (sig.status === 'controlling') {
        observerSucceeded = true
        setMode('controlling')
        setSyncStatus('ready')
        setSyncError(null)
        lastInputAtRef.current = Date.now()
        setIdleHint(false)
        if (terminalRef.current) terminalRef.current.focus()
      } else if (sig.status === 'conflict') {
        setConflict(true)
        setConfirmTakeover(false)
      } else if (sig.status === 'error') {
        if (!observerSucceeded) startSnapshot()
        else { setConflict(false); setSyncError(sig.message ?? null); setSyncStatus('error') }
      } else if (sig.status === 'closed') {
        startSnapshot()
      }
    }

    const unsub = terminalSessionStore.subscribe(paneId, onStoreSignal)
    setMode('observer')
    void terminalSessionStore.acquireObserver(paneId, currentSize()).catch(() => {
      if (!observerSucceeded) startSnapshot()
    })

    return () => {
      controller.abort()
      unsub()
      void terminalSessionStore.release(paneId).catch(() => {})
    }
  }, [paneId])

  const requestControl = (takeover = false): void => {
    setConflict(false)
    lastInputAtRef.current = Date.now()
    setIdleHint(false)
    void terminalSessionStore.requestControl(paneId, currentSize(), takeover).catch(() => {})
  }
  const releaseControl = (): void => {
    escSelectionPendingRef.current = false
    setIdleHint(false)
    void terminalSessionStore.releaseControl(paneId, currentSize()).catch(() => {})
  }
  const onTerminalClick = (): void => {
    if (readOnly || conflict) return
    if (ioModeRef.current === 'observer') requestControl(false)
  }

  useEffect(() => {
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      if (maximized) terminalRef.current?.focus()
    })
  }, [maximized])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (terminalRef.current) terminalRef.current.options.theme = computeXtermTheme()
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const hasFocus = !!document.activeElement?.closest('.herdr-xterm-host')
      const term = terminalRef.current
      const mode = ioModeRef.current
      if (e.key === 'Enter' && mode === 'observer' && !readOnly && !conflict && hasFocus) {
        e.preventDefault()
        requestControl(false)
        return
      }
      if (e.key === 'Escape' && mode === 'controlling' && hasFocus) {
        if (term?.hasSelection()) {
          if (!escSelectionPendingRef.current) {
            escSelectionPendingRef.current = true
            e.stopPropagation()
            e.preventDefault()
            window.setTimeout(() => { escSelectionPendingRef.current = false }, 1200)
            return
          }
          escSelectionPendingRef.current = false
          term.clearSelection()
        }
        e.stopPropagation()
        e.preventDefault()
        releaseControl()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [readOnly, conflict])

  useEffect(() => {
    let timer: number | undefined
    const tick = (): void => {
      if (!document.hidden) {
        if (ioModeRef.current === 'controlling' && !readOnly && !conflict) {
          const idle = Date.now() - lastInputAtRef.current > 300_000
          setIdleHint(prev => (prev !== idle ? idle : prev))
        } else {
          setIdleHint(prev => (prev ? false : prev))
        }
      }
      timer = window.setTimeout(tick, 30_000)
    }
    timer = window.setTimeout(tick, 30_000)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [readOnly, conflict])

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now()
      } else if (hiddenSinceRef.current !== null) {
        const dur = Date.now() - hiddenSinceRef.current
        lastInputAtRef.current += dur
        hiddenSinceRef.current = null
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const headerMode: 'observing' | 'controlling' | 'conflict' | 'snapshot' = conflict
    ? 'conflict'
    : compatMode
      ? 'snapshot'
      : ioModeRef.current === 'controlling'
        ? 'controlling'
        : 'observing'

  const modeLabel = (() => {
    if (headerMode === 'observing') return t('pane.modeObserving')
    if (headerMode === 'controlling') return t('pane.modeControlling')
    if (headerMode === 'snapshot') return t('pane.modeSnapshot')
    return agent ? t('pane.controlledBy', { agent }) : t('pane.terminalControlledByOther')
  })()

  const paneSession = terminalSessionStore.getPane(paneId)
  const watcherCount = paneSession?.refcount ?? terminalSessionStore.getRefCount(paneId)
  const showPresence = headerMode === 'observing' && watcherCount > 1

  const occupantEl = showPresence
    ? t('pane.presence', { count: watcherCount })
    : headerMode === 'observing'
      ? '--'
      : agent
        ? (
          <span className="herdr-term-occupant">
            <span className="herdr-agent-accent" data-accent={agentTheme(agent)} />
            <span>{agent}</span>
          </span>
        )
        : accent
          ? <span className="herdr-agent-accent" data-accent={accent} />
          : '--'

  const supSegments: string[] = []
  if (compatMode) supSegments.push(t('pane.modeSnapshot'))
  if (historyIncomplete) supSegments.push(t('pane.terminalHistoryIncomplete'))
  if (syncStatus === 'syncing') supSegments.push(t('pane.terminalSyncing'))
  else if (syncStatus === 'error') supSegments.push(syncError ?? t('pane.terminalReconnect'))
  if (inputError) supSegments.push(`${t('pane.terminalInputFailed')}: ${inputError}`)
  if (idleHint && headerMode === 'controlling') supSegments.push(t('pane.idleHint', { minutes: 5 }))
  const supText = supSegments.length ? `·${supSegments.join('·')}` : ''
  const supTitle = supSegments.join(' · ')

  const showHover = !readOnly && headerMode === 'observing' && !conflict

  return (
    <div ref={wrapRef} className={`herdr-term ${maximized ? 'herdr-term-maximized' : ''}`} data-accent={accent ?? undefined}>
      <div className="herdr-term-header" data-mode={headerMode}>
        <span className="herdr-term-header-left">
          <StateDot state={dotState(status)} />
          <span>{modeLabel}</span>
        </span>
        <span className="herdr-term-header-center" title={typeof occupantEl === 'string' ? occupantEl : agent ?? ''}>
          {occupantEl}
        </span>
        <span className="herdr-term-header-right">
          {supText
            ? (
              <sup
                className={`herdr-term-sup${idleHint ? ' herdr-term-sup--idle' : ''}`}
                title={supTitle}
                onClick={idleHint ? releaseControl : undefined}
                role={idleHint ? 'button' : undefined}
                tabIndex={idleHint ? 0 : undefined}
                onKeyDown={idleHint
                  ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); releaseControl() }
                  }
                  : undefined}
                style={idleHint ? { cursor: 'pointer' } : undefined}
              >
                {supText}
              </sup>
            )
            : null}
          {!readOnly && headerMode === 'observing' && !conflict
            ? (
              <button type="button" className="herdr-term-header-btn" onClick={() => requestControl(false)} aria-label={t('pane.acquireControl')}>
                {t('pane.acquireControl')} <span className="herdr-term-header-hint">⌘Enter</span>
              </button>
            )
            : headerMode === 'controlling' && !readOnly
              ? (
                <button type="button" className="herdr-term-header-btn herdr-term-header-btn--release" onClick={releaseControl} aria-label={t('pane.releaseControl')}>
                  {t('pane.releaseControl')} <span className="herdr-term-header-hint">{t('pane.releaseHint')}</span>
                </button>
              )
              : null}
        </span>
      </div>
      {conflict ? (
        <div className="herdr-term-conflict-bar" role="alert">
          <span>{agent ? t('pane.controlledBy', { agent }) : t('pane.terminalControlledByOther')}</span>
          <span className="herdr-term-conflict-actions">
            <button type="button" onClick={() => setConflict(false)}>{t('pane.terminalContinueObserve')}</button>
            {!readOnly
              ? confirmTakeover
                ? (
                  <>
                    <span>{t('pane.confirmTakeoverHint')}</span>
                    <button type="button" onClick={() => requestControl(true)}>{t('pane.confirmTakeover')}</button>
                    <button type="button" onClick={() => setConfirmTakeover(false)}>{t('view.close')}</button>
                  </>
                )
                : <button type="button" onClick={() => setConfirmTakeover(true)}>{t('pane.requestTakeover')}</button>
              : null}
          </span>
        </div>
      ) : null}
      <div className="herdr-term-host-wrap">
        <div
          ref={containerRef}
          className="herdr-xterm-host"
          role="log"
          aria-label={t('pane.terminalOutput')}
          onClick={onTerminalClick}
        />
        {showHover ? (
          <div className="herdr-term-hover" aria-hidden="true">
            <span>{t('pane.acquireHint')}</span>
          </div>
        ) : null}
      </div>
      {status === 'working' ? (
        <span className="herdr-log-live" role="status" title={t('pane.workingIndicator')} aria-label={t('pane.workingIndicator')} />
      ) : null}
    </div>
  )
}

function bytes(s: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(s))
}
