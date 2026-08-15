import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireRatio, toToolError } from './shared.ts'

export function registerPaneSplit(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_split',
    description: 'Split a Herdr pane right or down, returning the new pane id.',
    parameters: {
      pane_id: { type: 'string', description: 'Pane to split (e.g. w1:p1); default: focused pane' },
      direction: { type: 'string', enum: ['right', 'down'], required: true, description: 'Split direction' },
      ratio: { type: 'number', description: 'Split ratio (0.1–0.9)' },
      cwd: { type: 'string', description: 'Working directory for the new pane' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pane_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `new pane ${(value as { pane_id: string }).pane_id}` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Split pane ${args.direction}`, rawInput: args.pane_id ?? 'focused' } as const),
    async execute(args) {
      try {
        if (args.ratio != null) requireRatio(args.ratio, 'ratio')
        return await ctx.herdr.paneSplit({ pane_id: args.pane_id, direction: args.direction, ratio: args.ratio, cwd: args.cwd })
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
