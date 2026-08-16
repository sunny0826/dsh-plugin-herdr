import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { RunCommandResult } from '../client/index.ts'
import { startWaitJob } from '../jobs.ts'
import { requireNonEmpty, requireRatio, toToolError } from './shared.ts'

export function renderRunResult(args: { command: string }, value: RunCommandResult): string {
  if (value.kind === 'background') return `started background job ${value.jobId}`
  const status = value.timed_out ? ' (timed out)' : ''
  const exit = value.exit_code == null ? 'exit: n/a' : `exit: ${value.exit_code}`
  const out = value.output.trim()
  return [`[${value.pane_id}] ${exit}${status}`, out ? out : '(no output)'].join('\n')
}

export interface PaneRunToolOptions {
  /** 是否暴露 run_in_background 参数（allowBackground 配置闸门，§4 ADR-4）。 */
  allowBackground: boolean
}

export function registerPaneRun(ctx: Context, opts: PaneRunToolOptions) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_run',
    description:
      'Run a shell command in a Herdr pane (persistent terminal). Creates a new split pane ' +
      'unless pane_id is given; waits up to wait_ms for output to settle. Returns the pane output.',
    // 条件参数：闸门关闭时模型看不到 run_in_background（不生成即不会误用）
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run (executed via sh -c)' },
      pane_id: { type: 'string', description: 'Reuse an existing pane (e.g. w1:p2); default creates a new split' },
      workspace_id: { type: 'string', description: 'Workspace for the new pane (e.g. w1)' },
      direction: { type: 'string', enum: ['right', 'down'], description: 'Split direction for a new pane' },
      ratio: { type: 'number', description: 'Split ratio for a new pane (0.1–0.9)' },
      cwd: { type: 'string', description: 'Working directory for a new pane' },
      env: { type: 'object', additionalProperties: true, description: 'Environment for a new pane (string values)' },
      wait_ms: { type: 'number', description: 'Output wait budget in ms (default: config timeoutMs)' },
      ...(opts.allowBackground
        ? { run_in_background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately (results via job tools)' } }
        : {}),
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'completed', required: true },
              pane_id: { type: 'string', required: true },
              exit_code: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              output: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              timed_out: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'background', required: true },
              jobId: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (args, value) => [{ type: 'text', text: renderRunResult(args as { command: string }, value as RunCommandResult) }],
    },
    // UI 呈现（DESIGN.md §13）：terminal 卡片
    presentCall(args) {
      return {
        card: 'terminal',
        title: args.command,
        description: args.pane_id ? `reusing pane ${args.pane_id}` : 'new split pane',
        cwd: args.cwd,
      }
    },
    presentResult(args, result) {
      const text = result.content
        .map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
        .join('')
      // 无 presentationMeta 时 exitCode 不可得（结果期事实需持久化 meta），仅呈现输出
      return { card: 'terminal', output: text } as const
    },
    async execute(args, exec) {
      try {
        requireNonEmpty(args.command, 'command')
        if (args.ratio != null) requireRatio(args.ratio, 'ratio')
        const request = {
          command: args.command,
          pane_id: args.pane_id,
          workspace_id: args.workspace_id,
          direction: args.direction,
          ratio: args.ratio,
          cwd: args.cwd,
          env: args.env as Record<string, string> | undefined,
          wait_ms: args.wait_ms,
        }
        if (args.run_in_background && opts.allowBackground) {
          const jobId = startWaitJob<RunCommandResult>(ctx, {
            owner: exec.agent,
            label: `herdr run: ${args.command}`,
            wait: signal => ctx.herdr.runCommand(request, signal),
            render: result => renderRunResult(args as { command: string }, result),
          })
          return { kind: 'background' as const, jobId }
        }
        return await ctx.herdr.runCommand(request, exec.signal)
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
