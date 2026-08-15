import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { toToolError } from './shared.ts'

export function registerLayoutApply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_layout_apply',
    description:
      'Apply a declarative tab layout in Herdr (restores labels, cwd, env and optional commands). ' +
      'Requires the socket transport (no CLI equivalent).',
    parameters: {
      root: { type: 'json', required: true, description: 'Layout tree: {type:"pane"|"split", ...}' },
      workspace_id: { type: 'string', description: 'Target workspace' },
      tab_label: { type: 'string', description: 'Label for the new tab' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: 'layout applied: ' + JSON.stringify(value).slice(0, 200) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Apply layout' } as const),
    async execute(args) {
      try {
        return (await ctx.herdr.layoutApply({ root: args.root, workspace_id: args.workspace_id, tab_label: args.tab_label })) as JsonValue
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
