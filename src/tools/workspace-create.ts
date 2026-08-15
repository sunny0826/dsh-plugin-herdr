import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { toToolError } from './shared.ts'

export function registerWorkspaceCreate(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_workspace_create',
    description: 'Create a new Herdr workspace (project-level container with a root pane).',
    parameters: {
      cwd: { type: 'string', description: 'Working directory for the workspace (default: current)' },
      label: { type: 'string', description: 'Workspace label shown in the sidebar' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `created workspace ${(value as { workspace_id: string }).workspace_id}` }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Create workspace ${args.label ?? ''}`.trim() } as const),
    async execute(args) {
      try {
        return await ctx.herdr.workspaceCreate({ cwd: args.cwd, label: args.label })
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
