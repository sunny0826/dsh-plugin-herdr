import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { requireNonEmpty, toToolError } from './shared.ts'

export function registerNotification(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_notification',
    description: 'Show a desktop-style notification through the Herdr server (visible to the user).',
    parameters: {
      title: { type: 'string', required: true, description: 'Notification title' },
      body: { type: 'string', description: 'Notification body text' },
      position: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'Toast position' },
      sound: { type: 'string', enum: ['none', 'done', 'request'], description: 'Notification sound' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { shown: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: (value as { shown: boolean }).shown ? 'notification shown' : 'failed' }],
    },
    presentCall: (args) => ({ card: 'generic', title: `Notify: ${args.title}` } as const),
    async execute(args) {
      try {
        requireNonEmpty(args.title, 'title')
        await ctx.herdr.showNotification({ title: args.title, body: args.body, position: args.position, sound: args.sound })
        return { shown: true }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
