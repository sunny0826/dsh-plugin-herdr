/**
 * pane 输出等待的共享轮询逻辑（CLI 与 socket 传输共用，DESIGN.md §8.2.3）。
 * 策略：周期性读取 visible 快照，连续两次内容相同且静默超过 quietMs 判定命令完成；
 * 达到 waitMs 上限返回 timed_out（领域结果，不抛错）。
 *
 * baseline（可选）：命令执行前的 pane 快照。完成后若最终输出以 baseline 为前缀，
 * 裁剪掉该前缀（终端历史噪音）——只把本次命令产生的输出交给调用方。
 */
export interface PollResult {
  output: string
  timedOut: boolean
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

export async function pollPaneUntilStable(
  readPane: (paneId: string) => Promise<string>,
  paneId: string,
  waitMs: number,
  signal: AbortSignal,
  opts: { intervalMs?: number; quietMs?: number; baseline?: string } = {},
): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 500
  const quietMs = opts.quietMs ?? 1500
  const deadline = Date.now() + waitMs
  let prev = ''
  let stableSince = 0
  let lastRead = ''
  while (Date.now() < deadline) {
    if (signal.aborted) {
      return { output: trimBaseline(lastRead, opts.baseline), timedOut: true }
    }
    await sleep(intervalMs)
    lastRead = await readPane(paneId)
    if (lastRead === prev) {
      if (stableSince === 0) stableSince = Date.now()
      else if (Date.now() - stableSince >= quietMs) break
    } else {
      stableSince = 0
      prev = lastRead
    }
  }
  const timedOut = Date.now() >= deadline
  let output = trimBaseline(lastRead, opts.baseline)
  // 剥离尾部 shell 提示符行（快照含提示符）与基线剥离留下的前导空行
  output = output
    .replace(/\s*[❯$#]\s*$/, '')
    .replace(/\s*~\s*$/, '')
    .replace(/^\n+/, '')
  return { output, timedOut }
}

/**
 * 若输出以基线（命令执行前的快照）为前缀，仅保留新增部分；否则原样返回。
 *
 * 基线尾部是"提示符+光标"（如 `❯\n`）：命令执行后同一位置变为命令回显
 * （`❯ sh -c ...`），直接 startsWith 会失败。因此先剥掉基线尾部的提示符
 * 再匹配——提示符本身属于本次回显，保留无妨。
 */
function trimBaseline(output: string, baseline: string | undefined): string {
  if (!baseline) return output
  const base = baseline.replace(/\s*[❯$#]\s*$/, '')
  if (base && output.startsWith(base)) return output.slice(base.length)
  return output
}