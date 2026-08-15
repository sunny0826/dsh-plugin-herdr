import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

export function registerPaneRead(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_read',
    description: 'Read terminal output of a Herdr pane (visible or recent scrollback).',
    parameters: {
      pane_id: { type: 'string', required: true, description: 'Target pane (e.g. w1:p1)' },
      source: {
        type: 'string', enum: ['visible', 'recent', 'recent_unwrapped', 'detection'],
        description: 'Terminal snapshot source (CLI default: recent)',
      },
      lines: { type: 'number', description: 'Restrict to the last N lines' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pane_id: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { pane_id: string; text: string }
        return [{ type: 'text', text: [`[${v.pane_id}]`, v.text || '(no output)'].join('\n') }]
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `Read pane ${args.pane_id}`, kind: 'read' } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.pane_id, 'pane_id')
        const { text } = await ctx.herdr.paneRead({ pane_id: args.pane_id, source: args.source, lines: args.lines })
        return { pane_id: args.pane_id, text }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
