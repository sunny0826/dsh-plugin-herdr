import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus, AgentPromptResult } from '../client/index.ts'
import { requireNonEmpty, toToolError } from './shared.ts'

const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown']

function renderPrompt(value: AgentPromptResult): string {
  if (value.status) return `submitted; observed state: ${value.status}${value.waited_ms != null ? ` (waited ${value.waited_ms}ms)` : ''}`
  return 'submitted'
}

export function registerAgentPrompt(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_prompt',
    description:
      'Submit a prompt to an agent in a Herdr pane. Optionally wait for the first matching state ' +
      'after submission (with a stall guard when the agent is idle). Target an agent started ' +
      'with herdr_agent_start; if no agent is running yet, start one first instead of prompting ' +
      'a bare pane.',
    parameters: {
      target: { type: 'string', required: true, description: 'Pane id (e.g. w1:p2) or agent name' },
      text: { type: 'string', required: true, description: 'Prompt text to submit' },
      wait: { type: 'boolean', description: 'Wait for the first observed state after submission' },
      until: { type: 'array', items: { type: 'string', enum: STATUSES }, description: 'States to match when waiting' },
      timeout_ms: { type: 'number', description: 'Wait budget in ms' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          submitted: { type: 'boolean', required: true },
          status: { type: 'string' },
          message: { type: 'string' },
          waited_ms: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPrompt(value as AgentPromptResult) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Prompt ${args.target}`, rawInput: args.text } as const),
    async execute(args, exec) {
      try {
        requireNonEmpty(args.target, 'target')
        requireNonEmpty(args.text, 'text')
        return await ctx.herdr.agentPrompt({
          target: args.target,
          text: args.text,
          wait: args.wait,
          until: args.until as AgentStatus[] | undefined,
          timeout_ms: args.timeout_ms,
        }, exec.signal)
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
