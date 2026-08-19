// PaneTerminal：优先使用 Herdr terminal session observer/controller（实时 ANSI frame 流）。
// - observer 只读；点击终端 → requestControl；controlling 下输入/缩放经 controller 命令；
// - 已有 controller 时进入 conflict 覆盖层，用户二次确认后才 takeover；
// - terminal session 不可用时回退 viewport ANSI 快照（events.wait + pane.read）+ 兼容模式。

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AgentAccent } from '../client-logic.ts'
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

// —— 终端主题：随 DSH 界面亮暗切换（用户指定 Ghostty 主题）——
// 暗模式：Cyberdream（cyberdream.nvim 官方 extras/ghostty/cyberdream）
// 亮模式：Claude Code Light（Anthropic 官方品牌调色板，mundizzle/claude-theme ghostty/claude-light）
// 这两套是产品决策指定的完整终端调色板，故意使用固定色值而非 dsw token。
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

/** DSH 暗模式判定：body[data-ds-dark-theme]（与 styles.ts 及现有 MutationObserver 一致）。 */
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
}

type IoMode = 'observer' | 'controlling' | 'snapshot'

export function PaneTerminal({ paneId, status, accent, maximized }: PaneTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const ioModeRef = useRef<IoMode>('observer')
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
      // xterm canvas 不会解析 CSS var()；先经 DOM 解析再传入具体字体族。
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
      const mode = ioModeRef.current
      if (mode === 'observer') return // 只读
      setInputError(null)
      if (mode === 'controlling') {
        terminalSessionStore.sendInput(paneId, bytes(data))
      } else {
        void sendPaneInput(paneId, { text: data }).catch(error => {
          setInputError(error instanceof Error ? error.message : String(error))
        })
      }
    })
    // resize：observer 只本地 fit；controlling 再发给真实 PTY（80–120ms trailing debounce）
    let rt: number | undefined
    const doResize = () => {
      rt = undefined
      fitAddon.fit()
      if (ioModeRef.current === 'controlling') terminalSessionStore.resize(paneId, currentSize())
    }
    const resizeObserver = new ResizeObserver(() => {
      if (rt !== undefined) window.clearTimeout(rt)
      rt = window.setTimeout(doResize, 100)
    })
    resizeObserver.observe(host)

    return () => {
      if (rt !== undefined) window.clearTimeout(rt)
      resizeObserver.disconnect()
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
        // 历史预填充就绪前缓存帧；首个 full 帧触发拉历史（recent_unwrapped 快照按行
        // 写入，超出视口的行进 scrollback），历史写完再按序回放缓存帧——full/diff 帧
        // 不清空 scrollback，滚轮即可翻看之前输出
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
        if (terminalRef.current) terminalRef.current.focus()
      } else if (sig.status === 'conflict') {
        setConflict(true)
        setConfirmTakeover(false)
      } else if (sig.status === 'error') {
        if (!observerSucceeded) startSnapshot()
        else { setConflict(false); setSyncError(sig.message ?? null); setSyncStatus('error') }
      } else if (sig.status === 'closed') {
        // 流结束/服务端 session 回收（agent 任务结束等）：回退快照轮询保持内容最新
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
    void terminalSessionStore.requestControl(paneId, currentSize(), takeover).catch(() => {})
  }
  const releaseControl = (): void => {
    void terminalSessionStore.releaseControl(paneId, currentSize()).catch(() => {})
  }
  const onTerminalClick = (): void => {
    if (ioModeRef.current === 'observer' && !conflict) requestControl(false)
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

  const readOnly = ioModeRef.current === 'observer' && !compatMode

  return (
    <div className={`herdr-term ${maximized ? 'herdr-term-maximized' : ''}`} data-accent={accent ?? undefined}>
      <div
        ref={containerRef}
        className="herdr-xterm-host"
        role="log"
        aria-label={t('pane.terminalOutput')}
        onClick={onTerminalClick}
      />
      {syncStatus === 'syncing' ? (
        <div className="herdr-term-sync" role="status">{t('pane.terminalSyncing')}</div>
      ) : null}
      {syncStatus === 'error' ? (
        <div className="herdr-term-error" role="status">{syncError ?? t('pane.terminalReconnect')}</div>
      ) : null}
      {inputError ? (
        <div className="herdr-term-input-error" role="alert">{t('pane.terminalInputFailed')}: {inputError}</div>
      ) : null}
      {historyIncomplete && compatMode ? (
        <div className="herdr-term-warning" role="status">{t('pane.terminalHistoryIncomplete')}</div>
      ) : null}
      {readOnly ? (
        <button type="button" className="herdr-term-ro" role="status" onClick={() => requestControl(false)}>
          {t('pane.terminalReadOnly')} · {t('pane.terminalClickToControl')}
        </button>
      ) : null}
      {compatMode ? (
        <div className="herdr-term-compat" role="status">{t('pane.terminalCompatMode')}</div>
      ) : null}
      {ioModeRef.current === 'controlling' ? (
        <button type="button" className="herdr-term-ctrl" role="status" onClick={releaseControl}>
          {t('pane.terminalReleaseControl')}
        </button>
      ) : null}
      {conflict ? (
        <div className="herdr-term-conflict" role="alert">
          <span>{t('pane.terminalControlledByOther')}</span>
          <div className="herdr-term-conflict-actions">
            <button type="button" onClick={() => setConflict(false)}>{t('pane.terminalContinueObserve')}</button>
            {confirmTakeover ? (
              <>
                <span>{t('pane.terminalTakeoverConfirm')}</span>
                <button type="button" onClick={() => requestControl(true)}>{t('pane.terminalTakeover')}</button>
                <button type="button" onClick={() => setConfirmTakeover(false)}>{t('view.close')}</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmTakeover(true)}>{t('pane.terminalTakeover')}</button>
            )}
          </div>
        </div>
      ) : null}
      {status === 'working' ? (
        <span className="herdr-log-live" role="status" title={t('pane.workingIndicator')} aria-label={t('pane.workingIndicator')} />
      ) : null}
    </div>
  )
}

// 浏览器端 UTF-8 → bytes
function bytes(s: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(s))
}
