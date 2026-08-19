/**
 * ANSI SGR 终端解析器（design: pane-log-terminal-design §3）。
 * 纯函数，不依赖 React/DOM/CSSOM；node:test 直接覆盖。
 * 输出带样式的 AnsiToken[]，供 pane-log.tsx 安全渲染为 React 文本节点。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** ANSI 颜色类型（16 色索引 / 256 色索引 / RGB truecolor）。 */
export type AnsiColorKind = 'ansi16' | 'ansi256' | 'rgb'

export interface AnsiColor {
  kind: AnsiColorKind
  index: number // ansi16/ansi256: 0-255; rgb: unused
  r: number // rgb only
  g: number // rgb only
  b: number // rgb only
}

/** 单个 token 的 SGR 样式快照（不可变输出）。 */
export interface AnsiStyle {
  bold: boolean
  dim: boolean
  underline: boolean
  inverse: boolean
  foreground: AnsiColor | null
  background: AnsiColor | null
}

/** 解析后的文本段（text 始终是纯文本，由 React 负责转义）。 */
export interface AnsiToken {
  text: string
  style: AnsiStyle
}

/** 一行的解析结果。 */
export interface AnsiLine {
  tokens: AnsiToken[]
  plainText: string
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 默认样式（无 SGR 设置时）。 */
const DEFAULT_STYLE: AnsiStyle = {
  bold: false, dim: false, underline: false, inverse: false,
  foreground: null, background: null,
}

/** 复制样式（避免共享引用被意外修改）。 */
function copyStyle(s: AnsiStyle): AnsiStyle {
  return {
    bold: s.bold, dim: s.dim, underline: s.underline, inverse: s.inverse,
    foreground: s.foreground ? { ...s.foreground } : null,
    background: s.background ? { ...s.background } : null,
  }
}

/** 16 色 ANSI 索引 → AnsiColor。 */
function ansi16Color(index: number): AnsiColor {
  return { kind: 'ansi16', index, r: 0, g: 0, b: 0 }
}

/** xterm 256 色 cube/gray 算法 → RGB 分量。 */
function ansi256ToRgb(index: number): { r: number; g: number; b: number } {
  const n = Math.max(0, Math.min(255, index))
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return { r: v, g: v, b: v }
  }
  if (n >= 16) {
    const cube = n - 16
    const ri = Math.floor(cube / 36)
    const gi = Math.floor((cube % 36) / 6)
    const bi = cube % 6
    const comp = (i: number) => i === 0 ? 0 : 55 + 40 * i
    return { r: comp(ri), g: comp(gi), b: comp(bi) }
  }
  // 0-15: 标准 16 色近似 RGB（仅用于 256 色模式下的索引 0-15）
  const table = [
    [0,0,0],[170,0,0],[0,170,0],[170,85,0],[0,0,170],[170,0,170],[0,170,170],[170,170,170],
    [85,85,85],[255,85,85],[85,255,85],[255,255,85],[85,85,255],[255,85,255],[85,255,255],[255,255,255],
  ]
  const c = table[n] ?? [0, 0, 0]
  return { r: c[0], g: c[1], b: c[2] }
}

// ---------------------------------------------------------------------------
// SGR 参数解析
// ---------------------------------------------------------------------------

/** 解析 SGR 参数序列，更新当前 style。malformed 扩展色整条忽略（不产生部分默认颜色）。 */
function applySgrParams(params: number[], style: AnsiStyle): void {
  let i = 0
  while (i < params.length) {
    const p = params[i]
    if (p === 0) {
      style.bold = false; style.dim = false; style.underline = false; style.inverse = false
      style.foreground = null; style.background = null
    } else if (p === 1) { style.bold = true }
    else if (p === 2) { style.dim = true }
    else if (p === 4) { style.underline = true }
    else if (p === 7) { style.inverse = true }
    else if (p === 22) { style.bold = false; style.dim = false }
    else if (p === 24) { style.underline = false }
    else if (p === 27) { style.inverse = false }
    else if (p === 39) { style.foreground = null }
    else if (p === 49) { style.background = null }
    else if (p >= 30 && p <= 37) { style.foreground = ansi16Color(p - 30) }
    else if (p >= 40 && p <= 47) { style.background = ansi16Color(p - 40) }
    else if (p >= 90 && p <= 97) { style.foreground = ansi16Color(p - 90 + 8) }
    else if (p >= 100 && p <= 107) { style.background = ansi16Color(p - 100 + 8) }
    else if (p === 38) {
      // 扩展前景（38;5;n 或 38;2;r;g;b）—— malformed 整条忽略
      if (i + 1 < params.length && params[i + 1] === 5 && i + 2 < params.length) {
        const idx = Math.max(0, Math.min(255, params[i + 2]))
        const rgb = ansi256ToRgb(idx)
        style.foreground = { kind: 'ansi256', index: idx, ...rgb }
        i += 3
      } else if (i + 1 < params.length && params[i + 1] === 2
        && i + 4 < params.length) {
        const r = Math.max(0, Math.min(255, params[i + 2]))
        const g = Math.max(0, Math.min(255, params[i + 3]))
        const b = Math.max(0, Math.min(255, params[i + 4]))
        style.foreground = { kind: 'rgb', index: 0, r, g, b }
        i += 4
      }
      // malformed（缺子参数或缺 r/g/b）：整条忽略，不改变 style
      else { i++ }
    } else if (p === 48) {
      // 扩展背景（48;5;n 或 48;2;r;g;b）—— malformed 整条忽略
      if (i + 1 < params.length && params[i + 1] === 5 && i + 2 < params.length) {
        const idx = Math.max(0, Math.min(255, params[i + 2]))
        const rgb = ansi256ToRgb(idx)
        style.background = { kind: 'ansi256', index: idx, ...rgb }
        i += 3
      } else if (i + 1 < params.length && params[i + 1] === 2
        && i + 4 < params.length) {
        const r = Math.max(0, Math.min(255, params[i + 2]))
        const g = Math.max(0, Math.min(255, params[i + 3]))
        const b = Math.max(0, Math.min(255, params[i + 4]))
        style.background = { kind: 'rgb', index: 0, r, g, b }
        i += 4
      }
      else { i++ }
    }
    // 未知 SGR 参数安全忽略
    i++
  }
}

// ---------------------------------------------------------------------------
// 主解析器
// ---------------------------------------------------------------------------

/**
 * C0/C1 控制字符安全清洗：不执行、不渲染为可见乱码。
 * BEL(\x07)、BS(\x08)、FF(\x0C)、ESC 已在主循环处理；
 * 其余 C0 (0x00-0x1F 除 ESC/CR/LF) 和 C1 (0x80-0x9F) 直接丢弃。
 */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0)
  // C0: 0x00-0x1F（排除 ESC=0x1B, CR=0x0D, LF=0x0A）
  if (code <= 0x1F && code !== 0x1B && code !== 0x0D && code !== 0x0A) return true
  // C1: 0x80-0x9F（含 0x9B = CSI shortcut）
  if (code >= 0x80 && code <= 0x9F) return true
  return false
}

/**
 * 一次扫描解析完整 ANSI 输出为 AnsiLine[]。
 * 跨行保持 style 状态；不完整 CSI/OSC/SGR 在 EOF 时安全收尾（丢弃未终止序列）。
 * CRLF 归一化：\r\n 或孤立 \r 都作为行分隔。
 * C0/C1 控制字符安全丢弃（不执行、不渲染）。
 */
export function parseAnsiOutput(output: string): AnsiLine[] {
  const lines: AnsiLine[] = []
  let tokens: AnsiToken[] = []
  let buf = ''
  let style = copyStyle(DEFAULT_STYLE)
  const flush = () => {
    if (buf.length > 0) {
      tokens.push({ text: buf, style: copyStyle(style) })
      buf = ''
    }
  }
  const endLine = () => {
    flush()
    const plainText = tokens.reduce((s, t) => s + t.text, '')
    lines.push({ tokens, plainText })
    tokens = []
  }

  let i = 0
  const len = output.length
  while (i < len) {
    const ch = output[i]
    if (ch === '\u001b') {
      // ESC 序列
      if (i + 1 < len && output[i + 1] === '[') {
        // CSI: ESC [ ... <terminator>
        i += 2
        let params = ''
        while (i < len) {
          const c = output[i]
          if (c >= '0' && c <= '?') {
            params += c
            i++
          } else if (c === 'm') {
            // SGR：严格校验每个参数必须为十进制整数（0-9），否则整条忽略
            flush()
            if (params.length > 0) {
              const parts = params.split(';')
              const valid = parts.every(s => /^\d+$/.test(s))
              if (valid) {
                const nums = parts.map(s => parseInt(s, 10))
                applySgrParams(nums, style)
              }
              // malformed 参数：整条忽略，保持当前 style
            } else {
              applySgrParams([0], style) // 空参数等价于 reset
            }
            i++
            break
          } else {
            // 非 SGR CSI（如 cursor move）：忽略整个序列
            i++
            break
          }
        }
        // 不完整 CSI（EOF 前无终止符）：安全忽略
      } else if (i + 1 < len && output[i + 1] === ']') {
        // OSC: ESC ] ... BEL (\x07) 或 ESC \\ (ST)
        i += 2
        while (i < len) {
          if (output[i] === '\u0007') { i++; break }
          if (output[i] === '\u001b' && i + 1 < len && output[i + 1] === '\\') { i += 2; break }
          i++
        }
      } else if (i + 1 < len && output[i + 1] === '\\') {
        // ST (String Terminator) 单独出现
        i += 2
      } else {
        // 其他 ESC 引导序列：忽略下一个字符
        i += 2
      }
    } else if (ch === '\r') {
      // CRLF (\r\n) 归一为单个换行；孤立 \r 也作为行分隔
      if (i + 1 < len && output[i + 1] === '\n') {
        endLine()
        i += 2
      } else {
        endLine()
        i++
      }
    } else if (ch === '\n') {
      endLine()
      i++
    } else if (isControlChar(ch)) {
      // C0/C1 控制字符：安全丢弃（BEL/BS/FF 等不执行、不渲染）
      i++
    } else {
      buf += ch
      i++
    }
  }
  // 收尾：flush 剩余 buffer
  endLine()
  return lines
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** ANSI 输出 → 纯文本投影（去除所有控制序列）。 */
export function ansiPlainText(output: string): string {
  return parseAnsiOutput(output).map(l => l.plainText).join('\n')
}

/** stripAnsi：兼容导出，委托到 ansiPlainText。 */
export function stripAnsi(text: string): string {
  return ansiPlainText(text)
}

/** ANSI 安全清理 viewport 快照填充：去首部纯空白行 + 每行行尾空白（pane.read visible 每行按终端宽度右补空格）。
 *  行间用 CRLF 重连：该输出直供 xterm `write()`，而 ANSI 的 LF(0x0A) 只做 index（下移、列不变）、
 *  不会归列到 0——裸 `\n` 会使每一行从上一行末列起写，造成阶梯错位（首行产生"贴顶乱码"），
 *  必须用 `\r\n` 才让每行从第 0 列开始。 */
export function trimAnsiSnapshotPadding(text: string): string {
  const lines = text.split(/\r?\n/)
  let first = 0
  while (first < lines.length && /^[ \t]*$/.test(lines[first])) first++
  return lines
    .slice(first)
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\r\n')
}

/**
 * 在 xterm 中建立新的 full-frame 屏幕基线。
 *
 * Herdr 的 full frame 是 Ghostty 终端模型的完整画面，但浏览器端可能
 * 已经写入了历史快照；先清理可见屏幕并回到左上角，避免旧 prompt/字符
 * 残留在新画面之外。保留 scrollback，因此历史内容仍可滚动查看。
 */
export function rebaseTerminalFrame(bytes: Uint8Array, full: boolean): Uint8Array {
  if (!full) return bytes
  const prefix = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48]) // CSI 2 J + CSI H
  const rebased = new Uint8Array(prefix.length + bytes.length)
  rebased.set(prefix)
  rebased.set(bytes, prefix.length)
  return rebased
}

/** 压缩连续空行（保留至多 1 个空行分隔）；基于 AnsiLine.plainText 判断。 */
export function compactAnsiLines(lines: AnsiLine[]): AnsiLine[] {
  const out: AnsiLine[] = []
  let blank = false
  for (const l of lines) {
    if (l.plainText.trim() === '') {
      if (!blank) out.push(l)
      blank = true
    } else {
      out.push(l)
      blank = false
    }
  }
  return out
}

/** 安全尾部截断：保留尾部 maxChars 个可见字符，不在 ESC/CSI/OSC/SGR 扩展色参数中间截断。 */
export function truncateAnsiTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // Pass 1: 从尾部向前扫描，找到不完整 escape 的位置
  let escapePos = -1
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '\u001b') {
      escapePos = i
      break
    }
  }
  // 如果找到不完整 escape，丢弃 escape 及其后所有内容
  if (escapePos >= 0) {
    text = text.slice(0, escapePos)
  }
  // Pass 2: 从新的末尾向前扫描，保留 maxChars 个可见字符
  let end = text.length
  let visibleCount = 0
  while (end > 0 && visibleCount < maxChars) {
    end--
    const ch = text[end]
    if (ch !== '\r') visibleCount++
  }
  // UTF-8 安全边界
  while (end > 0) {
    const ch = text.charCodeAt(end - 1)
    if (ch <= 0x7F || ch >= 0xC0) break
    end--
  }
  return text.slice(end)
}

// ---------------------------------------------------------------------------
// 终端屏幕模型（design: pane-interactive-terminal §3.1）
// screen replay：从 ANSI snapshot 重放为可渲染的行 + 光标状态。
// ---------------------------------------------------------------------------

export interface TerminalCell {
  text: string
  style: AnsiStyle
}

export interface TerminalCursor {
  row: number
  column: number
  visible: boolean
}

export interface TerminalScreen {
  rows: TerminalCell[][]
  cursor: TerminalCursor
  title?: string
  bracketedPaste: boolean
}

const DEFAULT_CELL: TerminalCell = { text: ' ', style: { bold: false, dim: false, underline: false, inverse: false, foreground: null, background: null } }

function createEmptyScreen(rows: number, cols: number): TerminalScreen {
  const r: TerminalCell[][] = []
  for (let i = 0; i < rows; i++) {
    const row: TerminalCell[] = []
    for (let j = 0; j < cols; j++) row.push({ ...DEFAULT_CELL })
    r.push(row)
  }
  return { rows: r, cursor: { row: 0, column: 0, visible: true }, bracketedPaste: false }
}

function setCell(screen: TerminalScreen, row: number, col: number, cell: TerminalCell): void {
  if (row >= 0 && row < screen.rows.length && col >= 0 && col < screen.rows[row].length) {
    screen.rows[row][col] = cell
  }
}

function eraseLine(screen: TerminalScreen, row: number, mode: number): void {
  if (row < 0 || row >= screen.rows.length) return
  if (mode === 0 || mode === 2) {
    // 0/2: clear from cursor to end (or entire line for mode 2)
    const start = mode === 2 ? 0 : screen.cursor.column
    for (let c = start; c < screen.rows[row].length; c++) {
      screen.rows[row][c] = { ...DEFAULT_CELL }
    }
  } else if (mode === 1) {
    // 1: clear from start to cursor
    for (let c = 0; c <= screen.cursor.column && c < screen.rows[row].length; c++) {
      screen.rows[row][c] = { ...DEFAULT_CELL }
    }
  }
}

function eraseScreen(screen: TerminalScreen, mode: number): void {
  if (mode === 0 || mode === 2) {
    // 0/2: clear from cursor to end (or entire screen for mode 2)
    const startRow = mode === 2 ? 0 : screen.cursor.row
    for (let r = startRow; r < screen.rows.length; r++) {
      const startCol = r === startRow ? screen.cursor.column : 0
      for (let c = startCol; c < screen.rows[r].length; c++) {
        screen.rows[r][c] = { ...DEFAULT_CELL }
      }
    }
  } else if (mode === 1) {
    // 1: clear from start to cursor
    for (let r = 0; r <= screen.cursor.row; r++) {
      const endCol = r === screen.cursor.row ? screen.cursor.column : screen.rows[r].length - 1
      for (let c = 0; c <= endCol && c < screen.rows[r].length; c++) {
        screen.rows[r][c] = { ...DEFAULT_CELL }
      }
    }
  }
}

function scrollUp(screen: TerminalScreen, count: number): void {
  for (let i = 0; i < count; i++) {
    screen.rows.shift()
    const row: TerminalCell[] = []
    for (let j = 0; j < (screen.rows[0]?.length ?? 80); j++) row.push({ ...DEFAULT_CELL })
    screen.rows.push(row)
  }
}

/**
 * 从 ANSI snapshot replay 终端屏幕。
 * 因为 status 返回的是尾部 snapshot（可能被 OUTPUT_CAP 截断），
 * replay 是 best-effort：cursor/erase/scroll 可能不完整。
 */
export function replayTerminalSnapshot(
  output: string,
  options: { rows?: number; cols?: number } = {},
): TerminalScreen {
  const rows = options.rows ?? 24
  const cols = options.cols ?? 80
  const screen = createEmptyScreen(rows, cols)
  let style: AnsiStyle = { bold: false, dim: false, underline: false, inverse: false, foreground: null, background: null }
  let cursorRow = 0
  let cursorCol = 0
  let cursorVisible = true
  let bracketedPaste = false
  let i = 0
  const len = output.length

  const putChar = (ch: string) => {
    if (ch === '\r') { cursorCol = 0; return }
    if (ch === '\n') { cursorRow++; if (cursorRow >= rows) { scrollUp(screen, 1); cursorRow = rows - 1 } return }
    if (ch === '\t') {
      cursorCol = Math.min(cursorCol + 8 - (cursorCol % 8), cols - 1)
      return
    }
    if (ch === '\b') { cursorCol = Math.max(0, cursorCol - 1); return }
    if (cursorCol >= 0 && cursorCol < cols && cursorRow >= 0 && cursorRow < rows) {
      setCell(screen, cursorRow, cursorCol, { text: ch, style: { ...style } })
    }
    cursorCol++
    if (cursorCol >= cols) { cursorCol = 0; cursorRow++; if (cursorRow >= rows) { scrollUp(screen, 1); cursorRow = rows - 1 } }
  }

  while (i < len) {
    const ch = output[i]
    if (ch === '\u001b') {
      if (i + 1 < len && output[i + 1] === '[') {
        // CSI sequence
        i += 2
        let params = ''
        while (i < len) {
          const c = output[i]
          if (c >= '0' && c <= '?') { params += c; i++ }
          else if (c === 'm') {
            // SGR
            const nums = params.length > 0
              ? params.split(';').map(s => { const n = parseInt(s, 10); return Number.isNaN(n) ? 0 : n })
              : [0]
            // 简化 SGR：只处理 reset(0) 和部分常用指令
            for (const n of nums) {
              if (n === 0) { style = { bold: false, dim: false, underline: false, inverse: false, foreground: null, background: null } }
              else if (n === 1) style.bold = true
              else if (n === 2) style.dim = true
              else if (n === 4) style.underline = true
              else if (n === 7) style.inverse = true
              else if (n === 22) { style.bold = false; style.dim = false }
              else if (n === 24) style.underline = false
              else if (n === 27) style.inverse = false
              else if (n >= 30 && n <= 37) style.foreground = { kind: 'ansi16', index: n - 30, r: 0, g: 0, b: 0 }
              else if (n >= 40 && n <= 47) style.background = { kind: 'ansi16', index: n - 40, r: 0, g: 0, b: 0 }
              else if (n >= 90 && n <= 97) style.foreground = { kind: 'ansi16', index: n - 90 + 8, r: 0, g: 0, b: 0 }
              else if (n >= 100 && n <= 107) style.background = { kind: 'ansi16', index: n - 100 + 8, r: 0, g: 0, b: 0 }
            }
            i++; break
          } else if (c === 'J') {
            // Erase screen
            const mode = params.length > 0 ? parseInt(params, 10) : 0
            eraseScreen(screen, Number.isNaN(mode) ? 0 : mode)
            i++; break
          } else if (c === 'K') {
            // Erase line
            const mode = params.length > 0 ? parseInt(params, 10) : 0
            eraseLine(screen, cursorRow, Number.isNaN(mode) ? 0 : mode)
            i++; break
          } else if (c === 'A') {
            // Cursor up
            const n = params.length > 0 ? parseInt(params, 10) : 1
            cursorRow = Math.max(0, cursorRow - (Number.isNaN(n) ? 1 : n))
            i++; break
          } else if (c === 'B') {
            // Cursor down
            const n = params.length > 0 ? parseInt(params, 10) : 1
            cursorRow = Math.min(rows - 1, cursorRow + (Number.isNaN(n) ? 1 : n))
            i++; break
          } else if (c === 'C') {
            // Cursor forward
            const n = params.length > 0 ? parseInt(params, 10) : 1
            cursorCol = Math.min(cols - 1, cursorCol + (Number.isNaN(n) ? 1 : n))
            i++; break
          } else if (c === 'D') {
            // Cursor back
            const n = params.length > 0 ? parseInt(params, 10) : 1
            cursorCol = Math.max(0, cursorCol - (Number.isNaN(n) ? 1 : n))
            i++; break
          } else if (c === 'H' || c === 'f') {
            // Cursor position
            const parts = params.split(';')
            const r = parts.length > 0 ? parseInt(parts[0], 10) : 1
            const col = parts.length > 1 ? parseInt(parts[1], 10) : 1
            cursorRow = Math.max(0, Math.min(rows - 1, (Number.isNaN(r) ? 1 : r) - 1))
            cursorCol = Math.max(0, Math.min(cols - 1, (Number.isNaN(col) ? 1 : col) - 1))
            i++; break
          } else if (c === '?') {
            // Private mode (e.g., ?2004h/l for bracketed paste, ?25h/l for cursor visibility)
            let modeStr = ''
            i++
            while (i < len && output[i] >= '0' && output[i] <= '9') { modeStr += output[i]; i++ }
            if (i < len && (output[i] === 'h' || output[i] === 'l')) {
              const mode = parseInt(modeStr, 10)
              if (mode === 2004) bracketedPaste = output[i] === 'h'
              else if (mode === 25) cursorVisible = output[i] === 'h'
              i++
            }
            break
          } else {
            // Unknown CSI: skip
            i++; break
          }
        }
      } else if (i + 1 < len && output[i + 1] === ']') {
        // OSC: skip until BEL or ST
        i += 2
        while (i < len) {
          if (output[i] === '\u0007') { i++; break }
          if (output[i] === '\u001b' && i + 1 < len && output[i + 1] === '\\') { i += 2; break }
          i++
        }
      } else {
        i += 2 // Skip other ESC sequences
      }
    } else if (ch === '\r') {
      cursorCol = 0
      i++
    } else if (ch === '\n') {
      cursorRow++
      if (cursorRow >= rows) { scrollUp(screen, 1); cursorRow = rows - 1 }
      i++
    } else if (ch === '\t') {
      cursorCol = Math.min(cursorCol + 8 - (cursorCol % 8), cols - 1)
      i++
    } else if (ch === '\b') {
      cursorCol = Math.max(0, cursorCol - 1)
      i++
    } else if (isControlChar(ch)) {
      i++ // Discard control chars
    } else {
      putChar(ch)
      i++
    }
  }

  screen.cursor = { row: cursorRow, column: cursorCol, visible: cursorVisible }
  screen.bracketedPaste = bracketedPaste
  return screen
}
