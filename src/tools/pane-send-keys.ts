import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

export function registerPaneSendKeys(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_pane_send_keys',
    description:
      'Send key presses to a Herdr pane. Keys: plain text, special keys (enter, esc, tab), ' +
      'modifier chords (ctrl+c, alt+x, shift+tab), function keys (f1).',
    parameters: {
      pane_id: { type: 'string', required: true, description: 'Target pane (e.g. w1:p1)' },
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Key presses to send, in order' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: (value as { sent: boolean }).sent ? 'keys sent' : 'failed' }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Send keys to ${args.pane_id}`, rawInput: args.keys } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.pane_id, 'pane_id')
        if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('keys must be a non-empty array')
        await ctx.herdr.paneSendKeys({ pane_id: args.pane_id, keys: args.keys })
        return { sent: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
