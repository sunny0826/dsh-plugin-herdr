import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { getBindingRegistry } from '../binding-registry.ts'
import { toToolError } from './shared.ts'

export function registerWorkspaceCreate(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_workspace_create',
    description:
      'Create a new Herdr workspace. In herdr mode this session already owns a dedicated ' +
      'workspace (created in the project directory at session start) and every pane it creates ' +
      'lives there — creating another workspace is refused so all panes stay in the session ' +
      'workspace. Outside herdr mode (no bound pane) this works normally.',
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
          // CA-003：workspaceCreate 实际返回 root_pane.pane_id（CLI 实测），schema 此前遗漏导致漂移
          pane_id: { type: 'string', description: 'Root pane created with the workspace' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'created workspace ' + (value as { workspace_id: string }).workspace_id }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create workspace ' + ((args as any).label ?? '') } as const),
    async execute(args, exec) {
      try {
        // herdr 模式：拒绝创建新 workspace（一个会话一个专属 workspace 的约束）
        const bound = exec.agent ? getBindingRegistry().get(exec.agent.id) : undefined
        if (bound) {
          throw new Error(
            'this session already owns a dedicated workspace (pane ' + bound.pane_id +
            '); do not create another — split panes or start agents inside the session workspace instead',
          )
        }
        return await ctx.herdr.workspaceCreate({ cwd: args.cwd, label: args.label })
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}
