import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus, WaitAgentResult } from '../client/index.ts'
import { startWaitJob } from '../jobs.ts'
import { requireNonEmpty, toToolError } from './shared.ts'

const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown']

export function renderWaitResult(value: WaitAgentResult): string {
  switch (value.kind) {
    case 'completed':
      return `agent ${value.agent ?? value.pane_id ?? ''} reached ${value.status} (waited ${value.waited_ms}ms)`
    case 'timeout':
      return `timed out after ${value.waited_ms}ms; target did not reach the requested state`
    case 'not_found':
      return `target not found: ${value.target}`
  }
}

export interface AgentWaitToolOptions {
  /** 是否暴露 run_in_background 参数（allowBackground 配置闸门，§4 ADR-4）。 */
  allowBackground: boolean
}

export function registerAgentWait(ctx: Context, opts: AgentWaitToolOptions) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_wait',
    description:
      'Wait until an agent in a Herdr pane reaches one of the requested states (e.g. done). ' +
      'Use after starting an agent or command in a pane to block until it finishes.',
    // 条件参数：闸门关闭时模型看不到 run_in_background（不生成即不会误用）
    parameters: {
      target: { type: 'string', required: true, description: 'Pane id (e.g. w1:p2) or agent name' },
      until: {
        type: 'array',
        items: { type: 'string', enum: STATUSES },
        required: true,
        description: 'States to match; any match returns (default semantics: idle/done/blocked when omitted)',
      },
      timeout_ms: { type: 'number', description: 'Wait budget in ms (default: config timeoutMs)' },
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
              status: { type: 'string', enum: STATUSES, required: true },
              waited_ms: { type: 'number', required: true },
              pane_id: { type: 'string' },
              agent: { type: 'string' },
              message: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'timeout', required: true },
              waited_ms: { type: 'number', required: true },
              pane_id: { type: 'string' },
              agent: { type: 'string' },
              status: { type: 'string', enum: STATUSES },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'not_found', required: true },
              target: { type: 'string', required: true },
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
      render: (_args, value) => [{ type: 'text', text: renderWaitResult(value as WaitAgentResult) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Wait for ${args.target}`, rawInput: args.until } as const),
    async execute(args, exec) {
      try {
        requireNonEmpty(args.target, 'target')
        const until = args.until as AgentStatus[] | undefined
        if (until && until.length === 0) {
          throw new Error('until must contain at least one status')
        }
        const request = {
          target: args.target,
          until: until ?? ['done'],
          timeout_ms: args.timeout_ms,
        }
        if (args.run_in_background && opts.allowBackground) {
          const jobId = startWaitJob<WaitAgentResult>(ctx, {
            owner: exec.agent,
            label: `herdr wait ${request.target} until ${request.until.join('/')}`,
            wait: signal => ctx.herdr.waitAgent(request, signal),
            render: renderWaitResult,
          })
          return { kind: 'background' as const, jobId }
        }
        return await ctx.herdr.waitAgent(request, exec.signal)
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
