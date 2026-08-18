/**
 * 浏览器 ↔ Node 传输协议类型（design: pane-terminal-session-state-machine §6.3.2）。
 * Node 侧（manager/路由）与浏览器侧（store）共用；与 Herdr CLI stdout 的 terminal.frame
 * 是两层协议，互不混用。
 */

export type TerminalSessionMode = 'observe' | 'control'

/** Node → 浏览器事件（SSE/NDJSON）。 */
export type BrowserTerminalEvent =
  | { type: 'ready'; sessionId: string; mode: TerminalSessionMode; generation: number; resumed: boolean; afterSeq: number }
  | { type: 'frame'; generation: number; seq: number; full: boolean; width: number; height: number; bytes: string }
  | { type: 'conflict'; sessionId: string; message: string }
  | { type: 'closed'; sessionId: string; reason?: string }
  | { type: 'error'; sessionId: string; code: string; message: string; retryable: boolean }

/** 浏览器 → Node 命令（Phase 1 仅 observe；input/resize/control 为 controller-only）。 */
export type BrowserTerminalCommand =
  | { type: 'input'; bytes: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'scroll'; direction: 'up' | 'down'; lines: number }
  | { type: 'release' }

/** start 请求（POST /herdr-terminal-session/start）。 */
export interface TerminalSessionStartRequest {
  pane_id: string
  mode: TerminalSessionMode
  cols: number
  rows: number
  takeover?: boolean
}
