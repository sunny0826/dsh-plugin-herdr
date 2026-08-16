/**
 * 输出上限工具（CA-002 / CA-014）：单条响应的固定累积上限；超过即截断并报告 truncated。
 * 与传输无关（CLI 传输已移除，socket 传输沿用同一上限语义）。
 */
export const MAX_CLI_OUTPUT_BYTES = 1024 * 1024

/**
 * CR P2：按 UTF-8 字节预算截断字符串，保证结果不超过 maxBytes。
 * 直接 Buffer.subarray+toString 在切点落在多字节字符中间时会产生 U+FFFD 替换符
 * （3 字节），可能超出预算——这里解码后回退到有效边界。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  let out = Buffer.from(text).subarray(0, maxBytes).toString('utf8')
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, -1)
  return out
}
