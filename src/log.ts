/**
 * CA-017：统一日志与高频错误限流。
 *
 * - 各子系统用 `ctx.logger('<name>')` 获得命名 logger（级别 + 上下文）；\n
 * - 高频错误（轮询失败、重连失败、上报失败）按 key 限流，避免日志风暴。
 */
import type { Context, Logger } from '@deepseek-ai/cordis'

export type NamedLogger = Logger

/** 按 key 限流：intervalMs 内同一 key 最多触发一次。 */
export function createRateLimiter(intervalMs: number): (key: string, fn: () => void) => void {
  const last = new Map<string, number>()
  return (key, fn) => {
    const now = Date.now()
    if (now - (last.get(key) ?? 0) < intervalMs) return
    last.set(key, now)
    fn()
  }
}

/** 稳定错误文本（logger 参数用）。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 子系统命名 logger 工厂（名称带 [dsh-plugin-herdr] 前缀便于 grep）。 */
export function createLogger(ctx: Context, subsystem: string): NamedLogger {
  return ctx.logger(`dsh-plugin-herdr/${subsystem}`)
}
