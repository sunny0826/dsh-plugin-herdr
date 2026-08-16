import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

/** 去空白后校验 label 长度上限（与 pane-rename / HTTP 路由保持一致）。 */
export function assertLabelLength(label: string): void {
  if (label.trim().length > 64) {
    throw new Error('label must be at most 64 characters')
  }
}

export function registerWorkspaceRename(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_workspace_rename',
    description: 'Rename a Herdr workspace label.',
    parameters: {
      workspace_id: { type: 'string', required: true, description: 'Workspace id to rename (e.g. w1)' },
      label: { type: 'string', required: true, description: 'New label (non-empty, at most 64 characters)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'workspace renamed' }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Rename workspace ' + args.workspace_id + ' to ' + args.label, rawInput: args.workspace_id } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.workspace_id, 'workspace_id')
        requireNonEmpty(args.label, 'label')
        assertLabelLength(args.label)
        await ctx.herdr.workspaceRename(args.workspace_id, args.label)
        return { ok: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
