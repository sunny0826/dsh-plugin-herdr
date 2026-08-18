/**
 * 结构化错误（design: pane-terminal-session-state-machine §10）。
 * 错误码与设计 §10 对齐；`retryable` 供重连原则判定（observer 可指数退避重连，
 * controller 仅在短宽限期、且无 takeover/ownership conflict 时才尝试恢复）。
 */

export type TerminalSessionErrorCode =
  | 'terminal_session_unavailable'
  | 'terminal_session_conflict'
  | 'terminal_session_not_found'
  | 'terminal_session_forbidden'
  | 'terminal_session_protocol_error'
  | 'terminal_session_frame_gap'
  | 'terminal_session_input_backpressure'
  | 'terminal_session_process_exited'
  | 'terminal_session_timeout'

export class TerminalSessionError extends Error {
  readonly code: TerminalSessionErrorCode
  readonly retryable: boolean
  constructor(code: TerminalSessionErrorCode, message: string, opts: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'TerminalSessionError'
    this.code = code
    this.retryable = opts.retryable ?? false
  }
}

export function isTerminalSessionError(e: unknown): e is TerminalSessionError {
  return e instanceof TerminalSessionError
}

/** 构造 protocol_error；默认不可重试（属于需重建 stream 的协议级失败）。 */
export function protocolError(message: string): TerminalSessionError {
  return new TerminalSessionError('terminal_session_protocol_error', message)
}
