import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'
import { assertLabelLength } from './workspace-rename.ts'

export function registerPaneRename(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_rename',
    description: 'Rename a Herdr pane label (null or empty clears the name).',
    parameters: {
      pane_id: { type: 'string', required: true, description: 'Pane to rename (e.g. w1:p1)' },
      // label 可空：null + 空串都清除名称（arg 校验走 oneOf 输出 string | null）
      label: { oneOf: [{ type: 'string', description: 'New label (at most 64 characters)' }, { type: 'null' }], description: 'New label; null/empty clears the name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'pane renamed' }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Rename pane ' + args.pane_id, rawInput: args.pane_id } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.pane_id, 'pane_id')
        // label 可空：null/空白 → null 清除名称（传输层 --clear）；非空时同样 ≤64 校验
        const label = args.label == null || args.label.trim() === '' ? null : args.label
        if (label != null) assertLabelLength(label)
        await ctx.herdr.paneRename(args.pane_id, label)
        return { ok: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
