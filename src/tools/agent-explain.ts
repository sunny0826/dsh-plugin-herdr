import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { toToolError } from './shared.ts'

export function registerAgentExplain(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_explain',
    description: 'Explain why Herdr classified a pane/agent the way it did (detection diagnostics).',
    parameters: {
      target: { type: 'string', required: true, description: 'Pane id or agent name to explain' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Explain ${args.target}`, kind: 'search' } as const),
    async execute(args) {
      try {
        return (await ctx.herdr.agentExplain({ target: args.target })) as JsonValue
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
