import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { HerdrAgentInfo } from '../client/index.ts'
import { renderTable, toToolError } from './shared.ts'

const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown']

export function renderAgentTable(agents: HerdrAgentInfo[]): string {
  if (agents.length === 0) return '(no agents detected)'
  const rows = agents.map(a => [
    a.pane_id ?? '',
    a.agent ?? '',
    a.status ?? 'unknown',
    a.message ?? '',
    a.workspace_id ?? '',
  ])
  return renderTable(['pane', 'agent', 'status', 'message', 'workspace'], rows)
}

export function registerAgentList(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_list',
    description:
      'List agents detected by Herdr with their semantic state (idle/working/blocked/done/unknown). ' +
      'Optionally filter by workspace or status.',
    parameters: {
      workspace_id: { type: 'string', description: 'Filter by workspace id (e.g. w1)' },
      status: { type: 'string', enum: STATUSES, description: 'Filter by agent status' },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            pane_id: { type: 'string' },
            workspace_id: { type: 'string' },
            agent: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
            message: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAgentTable(value as HerdrAgentInfo[]) }],
    },
    presentCall: () => ({ card: 'generic', title: 'List Herdr agents', kind: 'search' } as const),
    async execute(args) {
      try {
        return await ctx.herdr.listAgents({
          workspace_id: args.workspace_id,
          status: args.status as never,
        }) as never
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
