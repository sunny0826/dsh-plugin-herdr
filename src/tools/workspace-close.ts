import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { toToolError } from './shared.ts'

export function registerWorkspaceClose(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_workspace_close',
    description: 'Close a Herdr workspace and all its panes (destructive).',
    parameters: {
      workspace_id: { type: 'string', required: true, description: 'Workspace id to close (e.g. w1)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          closed_panes: { type: 'number', required: true, description: 'Panes that were in the workspace before closing' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'closed workspace (' + ((value as { closed_panes: number }).closed_panes) + ' panes)' }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Close workspace ' + args.workspace_id + ' (destructive)',
      rawInput: args.workspace_id,
    } as const),
    async execute(args) {
      try {
        // 关闭前统计该 workspace 的 pane 数（展示用）；快照失败不阻塞关闭
        let closedPanes = 0
        try {
          const snap = await ctx.herdr.snapshot()
          closedPanes = snap.panes.filter(p => p.workspace_id === args.workspace_id).length
        } catch {
          // 拿不到快照则关闭仍继续（closed_panes 置 0）
        }
        await ctx.herdr.workspaceClose(args.workspace_id)
        return { ok: true, closed_panes: closedPanes }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
