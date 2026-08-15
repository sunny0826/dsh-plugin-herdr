import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { HerdrSnapshot } from '../client/index.ts'
import { toToolError } from './shared.ts'

/** 摘要渲染（纯函数；规范值本身是完整 snapshot JSON）。 */
export function renderSnapshotSummary(snapshot: HerdrSnapshot): string {
  const ws = snapshot.workspaces as Array<{ workspace_id?: string; label?: string; pane_count?: number }>
  const agents = snapshot.agents as Array<{ status?: string; agent?: string; pane_id?: string }>
  const statusCounts = new Map<string, number>()
  for (const a of agents) {
    const s = a.status ?? 'unknown'
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1)
  }
  const lines = [
    `herdr ${snapshot.version} (protocol ${snapshot.protocol})`,
    `workspaces: ${ws.length}`,
    `agents: ${agents.length}${statusCounts.size ? ' (' + [...statusCounts].map(([k, v]) => `${k}=${v}`).join(', ') + ')' : ''}`,
  ]
  const focus = snapshot.focused_pane_id
  if (focus) lines.push(`focused pane: ${focus}`)
  for (const w of ws.slice(0, 10)) {
    lines.push(`  - ${w.workspace_id} ${w.label ?? ''} (${w.pane_count ?? 0} panes)`)
  }
  return lines.join('\n')
}

export function registerSnapshot(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_snapshot',
    description: 'Get a Herdr session snapshot: workspaces, tabs, panes, agents, focus and protocol version.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderSnapshotSummary(value as unknown as HerdrSnapshot) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Herdr snapshot', kind: 'other' } as const),
    async execute() {
      try {
        // CA-003：明确声明意图的 JSON 强转（替换语义错误的 as never）
        return (await ctx.herdr.snapshot()) as unknown as JsonValue
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
