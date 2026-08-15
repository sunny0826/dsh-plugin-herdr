import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

export function registerAgentSendKeys(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_send_keys',
    description: 'Send key presses to the agent controlling a Herdr pane (e.g. ctrl+c to interrupt).',
    parameters: {
      target: { type: 'string', required: true, description: 'Pane id (e.g. w1:p2) or agent name' },
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Key presses to send, in order' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: (value as { sent: boolean }).sent ? 'keys sent' : 'failed' }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Send keys to ${args.target}`, rawInput: args.keys } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.target, 'target')
        if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('keys must be a non-empty array')
        await ctx.herdr.agentSendKeys({ target: args.target, keys: args.keys })
        return { sent: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
