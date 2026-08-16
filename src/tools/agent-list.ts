import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus, HerdrAgentInfo } from '../client/index.ts'
import { renderTable, toToolError } from './shared.ts'

const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown']

export function renderAgentTable(agents: HerdrAgentInfo[]): string {
  if (agents.length === 0) return '(no agents detected)'
  // agent 列显示自定义名（name；agent 字段是 kind 派生的显示名）——它是后续
  // herdr_agent_prompt / herdr_agent_wait 的 target；kind 列给出底层类型
  const rows = agents.map(a => [
    String(a.pane_id ?? ''),
    String(a.name ?? a.agent ?? ''),
    String((a as { kind?: unknown }).kind ?? ''),
    String(a.status ?? 'unknown'),
    String(a.message ?? ''),
    String(a.workspace_id ?? ''),
  ])
  return renderTable(['pane', 'agent', 'kind', 'status', 'message', 'workspace'], rows)
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
        // CA-003：HerdrAgentInfo 含 unknown 索引签名，无法直接满足 schema 推导的
        // Record<string, JsonValue>；用与声明 schema 一致的显式类型强转（替换语义错误的 as never）
        return (await ctx.herdr.listAgents({
          workspace_id: args.workspace_id,
          status: args.status as AgentStatus | undefined,
        })) as unknown as Array<
          { pane_id?: string; workspace_id?: string; agent?: string; status?: string; message?: string } & Record<string, JsonValue>
        >
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
