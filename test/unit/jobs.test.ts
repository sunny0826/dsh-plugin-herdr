import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { startWaitJob, type WaitJobSpec } from '../../src/jobs.ts'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'

interface JobStartLike {
  kind: string
  label: string
  run: () => JobHooks
}

function makeCtx(): { ctx: Context; holder: { value: JobStartLike | null } } {
  const holder: { value: JobStartLike | null } = { value: null }
  const ctx = new Context()
  ctx.provide('jobs', {
    start: (spec: JobStartLike) => {
      holder.value = spec
      return 'herdr-1'
    },
  })
  return { ctx, holder }
}

test('startWaitJob: cancel aborts the wait signal and done settles', async () => {
  const { ctx, holder } = makeCtx()
  let sawAbort = false
  const id = startWaitJob(ctx, {
    label: 'wait y',
    wait: async signal => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('aborted'))
        })
      })
      return 'never'
    },
    render: r => r,
  })
  assert.equal(id, 'herdr-1')
  assert.ok(holder.value, 'producer should have been captured')
  const hooks = holder.value!.run()
  hooks.cancel('user said stop')
  const outcome = await hooks.done
  assert.equal(sawAbort, true)
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /aborted/)
})

test('startWaitJob: completed path carries rendered output', async () => {
  const { ctx, holder } = makeCtx()
  startWaitJob(ctx, {
    label: 'wait z',
    wait: async () => ({ kind: 'completed' as const, status: 'done' as const, waited_ms: 5 }),
    render: r => JSON.stringify(r),
  })
  const hooks = holder.value!.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.output, '{"kind":"completed","status":"done","waited_ms":5}')
  assert.equal(hooks.readOutput?.(), outcome.output)
})

test('startWaitJob: wait rejection becomes failed outcome', async () => {
  const { ctx, holder } = makeCtx()
  startWaitJob(ctx, {
    label: 'wait q',
    wait: async () => {
      throw new Error('boom')
    },
    render: r => r,
  })
  assert.ok(holder.value, 'producer should have been captured')
  const hooks = holder.value!.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /boom/)
})

test('startWaitJob: render function is pure (typed spec)', () => {
  const spec: WaitJobSpec<number> = {
    label: 'x',
    wait: async () => 42,
    render: n => `n=${n}`,
  }
  assert.equal(spec.render(42), 'n=42')
})
