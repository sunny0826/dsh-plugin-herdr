import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

export function registerPaneClose(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_close',
    description: 'Close a Herdr pane (terminates processes running in it).',
    parameters: {
      pane_id: { type: 'string', required: true, description: 'Pane to close (e.g. w1:p1)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'closed pane' }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Close pane ' + args.pane_id, rawInput: args.pane_id } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.pane_id, 'pane_id')
        await ctx.herdr.paneClose(args.pane_id)
        return { ok: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
