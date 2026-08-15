import type { Context } from '@deepseek-ai/cordis'
import type { JobKindMap, JobOutcome, JobStart } from '@deepseek-ai/dsh-jobs'

// 声明我们的 producer kind（id 前缀 herdr-1, herdr-2 ...）
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    herdr: 'herdr'
  }
}
export type HerdrJobKind = JobKindMap['herdr']

/**
 * 等待类工具的后台 producer（DESIGN.md §9）。
 *
 * 前台与后台共用同一个等待实现：前台传 exec.signal，后台传 task-owned
 * AbortSignal；cancel 链路：job_kill → producer.cancel → abort → 等待实现。
 */
export interface WaitJobSpec<T> {
  /** 拥有该任务的 agent（会话围栏 + 所有者清理）。 */
  owner?: JobStart['owner']
  /** 一行模型可见标签。 */
  label: string
  /** 真实等待逻辑（观察/转发 signal）。 */
  wait: (signal: AbortSignal) => Promise<T>
  /** 结果 → 模型可读最终文本（JobOutcome.output）。 */
  render: (result: T) => string
}

/** 启动后台任务，返回 registry 签发的 jobId（如 herdr-1）。 */
export function startWaitJob<T>(ctx: Context, spec: WaitJobSpec<T>): string {
  return ctx.jobs.start({
    kind: 'herdr',
    label: spec.label,
    owner: spec.owner,
    run: () => {
      const controller = new AbortController()
      let lastOutput = ''
      const done = spec
        .wait(controller.signal)
        .then<JobOutcome>(result => {
          lastOutput = spec.render(result)
          return { status: 'completed', output: lastOutput }
        })
        .catch((err: unknown): JobOutcome => {
          const detail = err instanceof Error ? err.message : String(err)
          lastOutput = detail
          return { status: 'failed', detail, output: detail }
        })
      return {
        cancel: reason => controller.abort(reason),
        done,
        readOutput: () => lastOutput,
      }
    },
  })
}
