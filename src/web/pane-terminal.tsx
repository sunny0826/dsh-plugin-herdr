// PaneTerminal：Herdr terminal session 实时终端（ANSI frame 流），默认即可操作。
// - 挂载即 requestControl（无观察模式）；输入/缩放经 controller 命令；
// - 已有其他客户端 controller 时进入 conflict 横幅，用户二次确认后才 takeover；
// - terminal session 不可用时回退 ANSI 快照（events 驱动 + 兜底轮询，recent_unwrapped 重排），
//   快照模式下输入走 /pane.input 兼容路径；
// - compact（网格卡片）：无终端 header，状态收敛为右上角 chip；固定高度终端（约 20 行）。

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { agentTheme, dotState, shouldPushTerminalResize, type AgentAccent } from '../client-logic.ts'
import {
  fetchTerminalBootstrap,
  sendPaneInput,
  subscribePaneOutput,
  type TerminalBootstrapResult,
} from './store.ts'
import { terminalSessionStore, type TerminalStoreSignal } from './terminal-session.ts'
import { rebaseTerminalFrame, trimAnsiSnapshotPadding } from '../terminal-ansi.ts'
import { t, useHerdrLang } from './i18n.ts'
import { resolveTerminalFontFamily } from './terminal-font.ts'

const CYBERDREAM_DARK: Record<string, string> = {
  background: '#1f2937',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#1f2937',
  selectionBackground: '#3c4048',
  selectionForeground: '#ffffff',
  black: '#1f2937',
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

// 终端始终保持深色 surface：浅色主题下灰底终端对比度差、无终端感；
// 卡片是监控 tile，深色底是 observability 场景的惯例。
function computeXtermTheme(): Record<string, string> {
  return CYBERDREAM_DARK
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export interface PaneTerminalProps {
  paneId: string
  status?: string
  accent?: AgentAccent
  maximized?: boolean
  agent?: string
  /** 网格卡片紧凑模式：隐藏终端 header（身份在卡片头），状态收敛为浮层 chip。 */
  compact?: boolean
}

type IoMode = 'controlling' | 'snapshot'

export function PaneTerminal({ paneId, status, accent, maximized, agent, compact = false }: PaneTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const ioModeRef = useRef<IoMode>('controlling')
  const [syncStatus, setSyncStatus] = useState<'syncing' | 'ready' | 'error'>('syncing')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [historyIncomplete, setHistoryIncomplete] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [compatMode, setCompatMode] = useState(false)
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
      allowTransparency: true,
      theme: computeXtermTheme(),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    fitAddon.fit()
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const input = terminal.onData(data => {
      setInputError(null)
      if (ioModeRef.current === 'controlling') {
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
      if (shouldPushTerminalResize(ioModeRef.current)) {
        terminalSessionStore.resize(paneId, currentSize())
      }
    }
    let notifyTimer: number | undefined
    const scheduleFit = () => {
      fit()
      if (notifyTimer !== undefined) window.clearTimeout(notifyTimer)
      notifyTimer = window.setTimeout(() => {
        notifyTimer = undefined
        if (shouldPushTerminalResize(ioModeRef.current)) {
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
    let mode: IoMode = 'controlling'
    let liveSucceeded = false
    let snapshotStarted = false
    let historyReady = false
    let historySeeded = false
    let lastSnapshotText: string | null = null
    // 快照刷新状态：事件防抖计时器 + 兜底定时器 + 单飞合并
    let snapshotOff: (() => void) | null = null
    let snapshotRefreshTimer: number | undefined
    let snapshotFallbackTimer: number | undefined
    let snapshotRefreshing = false
    let snapshotRefreshQueued = false
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
      // 快照取 recent_unwrapped：源 pane 过窄（实测可低至 2~4 列）时逻辑行在
      // 卡片宽度下重排成可读文本，而不是按源宽度逐字碎裂（A2）
      const result = await fetchTerminalBootstrap(paneId, undefined, signal, 'recent_unwrapped')
      if (signal.aborted) return result
      const terminal = terminalRef.current
      if (!terminal) return result
      // 静默轮询下内容未变则跳过 reset+write：避免每周期清屏白闪
      if (result.text === lastSnapshotText) {
        setHistoryIncomplete(result.truncated)
        setSyncError(null)
        setSyncStatus('ready')
        return result
      }
      lastSnapshotText = result.text
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

    // 快照刷新：单飞防重叠，期间到达的触发合并为一次尾随刷新
    const refreshSnapshot = (): void => {
      if (signal.aborted) return
      if (snapshotRefreshing) { snapshotRefreshQueued = true; return }
      snapshotRefreshing = true
      void renderSnapshot(false)
        .catch(error => {
          if (signal.aborted || isAbortError(error)) return
          setSyncError(error instanceof Error ? error.message : String(error))
          setSyncStatus('error')
        })
        .finally(() => {
          snapshotRefreshing = false
          if (snapshotRefreshQueued && !signal.aborted) {
            snapshotRefreshQueued = false
            refreshSnapshot()
          }
        })
    }
    const scheduleSnapshotRefresh = (): void => {
      if (snapshotRefreshTimer !== undefined) window.clearTimeout(snapshotRefreshTimer)
      snapshotRefreshTimer = window.setTimeout(() => {
        snapshotRefreshTimer = undefined
        refreshSnapshot()
      }, 250)
    }

    const startSnapshot = (): void => {
      if (snapshotStarted || signal.aborted) return
      snapshotStarted = true
      setMode('snapshot')
      setSyncStatus('syncing')
      // 快照由共享 /herdr-events 的 output 事件驱动重拉：herdr 0.8.x 的
      // events.wait 不支持 pane_output_changed，逐卡 wait 长轮询会秒报错空转；
      // 20s 兜底定时刷新防止事件丢失（静默，内容未变时 renderSnapshot 跳过重写）。
      void renderSnapshot(true).catch(error => {
        if (signal.aborted || isAbortError(error)) return
        setSyncError(error instanceof Error ? error.message : String(error))
        setSyncStatus('error')
      })
      snapshotOff = subscribePaneOutput(paneId, scheduleSnapshotRefresh)
      snapshotFallbackTimer = window.setInterval(refreshSnapshot, 20_000)
    }

    const onStoreSignal = (sig: TerminalStoreSignal): void => {
      if (signal.aborted) return
      if (sig.type === 'frame') {
        if (mode !== 'controlling') return
        liveSucceeded = true
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
      } else if (sig.status === 'controlling') {
        liveSucceeded = true
        setConflict(false)
        setConfirmTakeover(false)
        setMode('controlling')
        setSyncStatus('ready')
        setSyncError(null)
      } else if (sig.status === 'conflict') {
        setConflict(true)
        setConfirmTakeover(false)
      } else if (sig.status === 'error') {
        if (!liveSucceeded) startSnapshot()
        else { setConflict(false); setSyncError(sig.message ?? null); setSyncStatus('error') }
      } else if (sig.status === 'closed') {
        startSnapshot()
      }
    }

    const unsub = terminalSessionStore.subscribe(paneId, onStoreSignal)
    setMode('controlling')
    void terminalSessionStore.requestControl(paneId, currentSize()).catch(() => {
      if (!liveSucceeded) startSnapshot()
    })

    return () => {
      controller.abort()
      unsub()
      if (snapshotRefreshTimer !== undefined) window.clearTimeout(snapshotRefreshTimer)
      if (snapshotFallbackTimer !== undefined) window.clearInterval(snapshotFallbackTimer)
      snapshotOff?.()
      void terminalSessionStore.release(paneId).catch(() => {})
    }
  }, [paneId])

  const requestTakeover = (): void => {
    setConflict(false)
    void terminalSessionStore.requestControl(paneId, currentSize(), true).catch(() => {})
  }

  useEffect(() => {
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      if (maximized) terminalRef.current?.focus()
    })
  }, [maximized])

  const headerMode: 'controlling' | 'conflict' | 'snapshot' = conflict
    ? 'conflict'
    : compatMode
      ? 'snapshot'
      : 'controlling'

  const modeLabel = (() => {
    if (headerMode === 'controlling') return t('pane.modeControlling')
    if (headerMode === 'snapshot') return t('pane.modeSnapshot')
    return agent ? t('pane.controlledBy', { agent }) : t('pane.terminalControlledByOther')
  })()

  const occupantEl = agent
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
  const supText = supSegments.length ? `·${supSegments.join('·')}` : ''
  const supTitle = supSegments.join(' · ')

  // 紧凑模式：终端 header 收敛为右上角浮层 chip（身份信息已在卡片头）；
  // 健康控制态是默认状态，不出 chip（仅快照/同步中/异常时提示）
  const chipParts: string[] = []
  if (headerMode === 'snapshot') chipParts.push(t('pane.modeSnapshot'))
  if (syncStatus === 'syncing') chipParts.push(t('pane.terminalSyncing'))
  else if (syncStatus === 'error') chipParts.push(t('pane.syncErrorShort'))
  const chipText = chipParts.length > 0 ? chipParts.join(' · ') : null

  return (
    <div ref={wrapRef} className={`herdr-term${maximized ? ' herdr-term-maximized' : ''}${compact ? ' herdr-term--compact' : ''}`} data-accent={accent ?? undefined}>
      {!compact ? (
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
              <sup className="herdr-term-sup" title={supTitle}>
                {supText}
              </sup>
            )
            : null}
        </span>
      </div>
      ) : null}
      {compact && chipText ? (
        <span
          className="herdr-term-chip"
          data-mode={headerMode}
          data-error={syncStatus === 'error' || undefined}
          title={supTitle || modeLabel}
        >
          {chipText}
        </span>
      ) : null}
      {conflict ? (
        <div className="herdr-term-conflict-bar" role="alert">
          <span>{agent ? t('pane.controlledBy', { agent }) : t('pane.terminalControlledByOther')}</span>
          <span className="herdr-term-conflict-actions">
            <button type="button" onClick={() => setConflict(false)}>{t('view.close')}</button>
            {confirmTakeover
              ? (
                <>
                  <span>{t('pane.confirmTakeoverHint')}</span>
                  <button type="button" onClick={requestTakeover}>{t('pane.confirmTakeover')}</button>
                  <button type="button" onClick={() => setConfirmTakeover(false)}>{t('view.close')}</button>
                </>
              )
              : <button type="button" onClick={() => setConfirmTakeover(true)}>{t('pane.requestTakeover')}</button>}
          </span>
        </div>
      ) : null}
      <div className="herdr-term-host-wrap">
        <div
          ref={containerRef}
          className="herdr-xterm-host"
          role="log"
          aria-label={t('pane.terminalOutput')}
        />
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
