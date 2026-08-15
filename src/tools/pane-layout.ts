import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { toToolError } from './shared.ts'

export function registerPaneLayout(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_layout',
    description: 'Show the Herdr tab layout snapshot (pane rects, split ratios, focus).',
    parameters: {
      pane_id: { type: 'string', description: 'Pane whose tab layout to show; default: focused' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Pane layout ${args.pane_id ?? '(focused)'}` } as const),
    async execute(args) {
      try {
        return await ctx.herdr.paneLayout({ pane_id: args.pane_id }) as never
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
