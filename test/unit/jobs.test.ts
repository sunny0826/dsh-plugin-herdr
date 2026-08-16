import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { startWaitJob, type WaitJobSpec } from '../../src/jobs.ts'
import { HerdrCliError } from '../../src/client/cli.ts'
import { registerPaneRun } from '../../src/tools/pane-run.ts'
import { registerAgentWait } from '../../src/tools/agent-wait.ts'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

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

test('startWaitJob: cancel aborts the wait signal and done settles with killed outcome', async () => {
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
  // CA-015：取消是框架认可的 killed 语义，不再是 failed
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'user said stop', 'cancel reason forwarded verbatim')
  assert.match(String(outcome.output), /aborted/)
})

test('CA-015: cancel is idempotent and done settles exactly once', async () => {
  const { ctx, holder } = makeCtx()
  let aborts = 0
  startWaitJob(ctx, {
    label: 'wait idem',
    wait: signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborts++; reject(new Error('aborted')) })
    }),
    render: () => '',
  })
  const hooks = holder.value!.run()
  hooks.cancel('first')
  hooks.cancel('second') // 幂等：二次 cancel 不重复触发
  hooks.cancel('third')
  const outcome = await hooks.done
  assert.equal(aborts, 1, 'abort listener fired once despite three cancels')
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'first', 'first reason wins')
})

test('CA-015: readOutput behavior is defined (empty until settle, then terminal, idempotent)', async () => {
  const { ctx, holder } = makeCtx()
  startWaitJob(ctx, {
    label: 'wait ro',
    wait: async () => ({ kind: 'completed' as const, status: 'done' as const, waited_ms: 5 }),
    render: r => JSON.stringify(r),
  })
  const hooks = holder.value!.run()
  assert.equal(hooks.readOutput?.(), '', 'empty before settle')
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.output, '{"kind":"completed","status":"done","waited_ms":5}')
  // 幂等：重复读取返回同一终端输出，不被消费
  assert.equal(hooks.readOutput?.(), outcome.output)
  assert.equal(hooks.readOutput?.(), outcome.output)
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

test('startWaitJob: wait rejection becomes failed outcome (not killed)', async () => {
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

// ---------------------------------------------------------------------------
// CA-015：两类后台工具（pane_run / agent_wait）集成——cancel → killed
// ---------------------------------------------------------------------------

function makeToolHarness(herdr: Record<string, unknown>) {
  const defs: ToolDefinition[] = []
  const holder: { value: JobStartLike | null } = { value: null }
  const ctx = new Context()
  ctx.provide('tools', { register: (def: ToolDefinition) => { defs.push(def); return () => {} } })
  ctx.provide('jobs', { start: (spec: JobStartLike) => { holder.value = spec; return 'herdr-1' } })
  ctx.provide('herdr', herdr)
  return { ctx, defs, holder }
}

const toolExec = { signal: new AbortController().signal, agent: 'tester' } as unknown as ToolRunContext

test('CA-015: pane_run background job — cancel settles killed (integration)', async () => {
  let sawAbort = false
  const { ctx, defs, holder } = makeToolHarness({
    runCommand: async (_req: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new HerdrCliError('HERDR_ABORTED', 'runCommand aborted'))
        })
      })
      return { kind: 'completed' as const, pane_id: 'w1:p1', exit_code: 0, output: '', truncated: false }
    },
  })
  registerPaneRun(ctx, { allowBackground: true })
  const run = defs.find(d => d.name === 'herdr_pane_run')!
  const res = await run.execute({ command: 'sleep 5', run_in_background: true }, toolExec)
  assert.deepEqual(res, { kind: 'background', jobId: 'herdr-1' })
  const hooks = holder.value!.run()
  hooks.cancel('killed by user')
  const outcome = await hooks.done
  assert.equal(sawAbort, true, 'tool wait observed the job signal')
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'killed by user')
})

test('CA-015: agent_wait background job — cancel settles killed (integration)', async () => {
  let sawAbort = false
  const { ctx, defs, holder } = makeToolHarness({
    waitAgent: async (_req: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new HerdrCliError('HERDR_ABORTED', 'waitAgent aborted'))
        })
      })
      return { kind: 'completed' as const, status: 'done' as const, waited_ms: 5 }
    },
  })
  registerAgentWait(ctx, { allowBackground: true })
  const wait = defs.find(d => d.name === 'herdr_agent_wait')!
  const res = await wait.execute({ target: 'w1:p1', until: ['done'], run_in_background: true }, toolExec)
  assert.deepEqual(res, { kind: 'background', jobId: 'herdr-1' })
  const hooks = holder.value!.run()
  hooks.cancel('teardown')
  const outcome = await hooks.done
  assert.equal(sawAbort, true)
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'teardown')
})
