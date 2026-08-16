import { HerdrError } from '../client/error.ts'

export const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

/** 手检：非空字符串（DSL 不表达非空约束）。 */
export function requireNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** 手检：正数。 */
export function requirePositiveNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
}

/** 手检：0.1–0.9 区间的 ratio。 */
export function requireRatio(value: unknown, name: string): asserts value is number {
  requirePositiveNumber(value, name)
  if (value < 0.1 || value > 0.9) {
    throw new Error(`${name} must be between 0.1 and 0.9`)
  }
}

/** 连接/环境/协议错误 → 抛错（工具进入 isError）；业务错误原样返回。 */
export function toToolError(err: unknown): never {
  if (err instanceof HerdrError) {
    throw new Error(`${err.code}: ${err.message}`)
  }
  throw err instanceof Error ? err : new Error(String(err))
}

/** 等宽表格渲染（render 用；纯函数）。 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join('  ')
  const sep = widths.map(w => '-'.repeat(w)).join('  ')
  return [line(headers), sep, ...rows.map(line)].join('\n')
}

/** 从错误对象提取稳定消息。 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
