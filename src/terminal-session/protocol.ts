/**
 * Herdr terminal session NDJSON 协议（design: pane-terminal-session-state-machine §3.1/§6.3）。
 *
 * - stdout 逐行 JSON；首帧 `full=true` 为基线，后续 `full=false` 是相对上一帧的 ANSI diff；
 * - `seq` 在当前 stream 内单调递增，跨进程/重连不可比较；
 * - `bytes` 是 Base64 编码的 ANSI bytes，解码后写入 xterm；
 * - `terminal.closed` 表示子进程/会话关闭（release 或异常）。
 *
 * 本模块为纯逻辑：分片/粘包解析 + frame 校验，均可 Node 单测（§11.1）。
 */

import { TerminalSessionError, protocolError } from './errors.ts'

/** 校验通过的帧。bytes 已解码为 Buffer（§7.1 直接 `terminal.write(Uint8Array)`）。 */
export interface TerminalFrame {
  seq: number
  width: number
  height: number
  full: boolean
  bytes: Buffer
}

export interface FrameLimits {
  /** 单帧 Base64 解码后最大字节数。 */
  maxDecodedFrameBytes: number
  /** stdout 单行最大字节数（NDJSON 行长）。 */
  maxNdjsonLineBytes: number
}

/**
 * 增量 NDJSON 行解析器：处理任意 chunk 边界、空行、超长行。
 * 以 `\n` 字节切行，行内 Buffer 整体转 UTF-8（避免跨 chunk 切断多字节字符）。
 */
export class NDJSONParser {
  private buf = Buffer.alloc(0)
  private overflow = false
  constructor(private readonly maxLineBytes: number) {}

  /** 喂入一段 stdout 字节，返回完整行（不含换行）。超长行被跳过并置 overflow。 */
  push(chunk: Buffer): string[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const lines: string[] = []
    let start = 0
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] !== 0x0a) continue
      const line = this.buf.subarray(start, i)
      if (line.length > this.maxLineBytes) {
        this.overflow = true
      } else {
        const s = line.toString('utf8')
        if (s.trim().length > 0) lines.push(s)
      }
      start = i + 1
    }
    this.buf = this.buf.subarray(start)
    // 未终止（无换行）的残余行也可能无限增长：残余超过上限即置 overflow 并截断。
    // 否则只有遇到换行才检查，恶意/异常 CLI 连续输出无换行数据会绕过 maxNdjsonLineBytes。
    if (this.buf.length > this.maxLineBytes) {
      this.overflow = true
      this.buf = this.buf.subarray(this.buf.length - this.maxLineBytes)
    }
    return lines
  }

  /** 是否出现过超长行（overflow；调用方应关闭 stream 重建）。 */
  exceeded(): boolean {
    return this.overflow
  }
}

/** 解析单行 JSON 为 TerminalFrame；形状/类型/Base64/大小任一非法抛 protocol_error。 */
export function parseFrame(raw: unknown, limits: Pick<FrameLimits, 'maxDecodedFrameBytes'>): TerminalFrame {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw protocolError('frame 不是对象')
  }
  const f = raw as Record<string, unknown>
  if (f.type !== 'terminal.frame') {
    throw protocolError(`意外的事件类型: ${String(f.type)}`)
  }
  const seq = f.seq
  const width = f.width
  const height = f.height
  const full = f.full
  const bytesB64 = f.bytes
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw protocolError('frame seq 非法')
  }
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1) {
    throw protocolError('frame width 非法')
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 1) {
    throw protocolError('frame height 非法')
  }
  if (typeof full !== 'boolean') {
    throw protocolError('frame full 非法')
  }
  if (typeof bytesB64 !== 'string' || bytesB64.length === 0) {
    throw protocolError('frame bytes 缺失')
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(bytesB64, 'base64')
    // round-trip：拒绝宽松 base64（Buffer 会吞掉非法字符）
    if (bytes.toString('base64') !== bytesB64) {
      throw new Error('non-canonical base64')
    }
  } catch {
    throw protocolError('frame bytes 非法 base64')
  }
  if (bytes.length > limits.maxDecodedFrameBytes) {
    throw new TerminalSessionError('terminal_session_protocol_error', `frame 超限: ${bytes.length} > ${limits.maxDecodedFrameBytes}`)
  }
  return { seq, width, height, full, bytes }
}

/** 判断一条 stdout JSON 是否为 terminal.closed（会话/子进程关闭）。 */
export function isClosedEvent(raw: unknown): raw is { type: 'terminal.closed'; reason?: string } {
  return typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'terminal.closed'
}
