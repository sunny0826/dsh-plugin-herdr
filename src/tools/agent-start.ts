import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentInfo, AgentStartRequest } from '../client/index.ts'
import { getBindingRegistry } from '../binding-registry.ts'
import { HerdrError } from '../client/error.ts'
import { requireNonEmpty, toToolError } from './shared.ts'

/**
 * 启动一个编码 agent（pi / codex / claude 等）并等待其就绪。
 * 缺省 pane_id 时在本会话专属 workspace 中（绑定 pane 旁 split）启动，
 * 新 pane 继承项目目录 cwd——开启的 agent 落在本会话 workspace 内。
 * 启动后应使用 herdr_agent_prompt 提交任务、herdr_agent_wait 等待完成。
 * 拒绝一次性执行模式（pi --print / codex exec 等）——那只是跑命令且立即退出，
 * 不是可跟踪的 Herdr agent，面板也无法显示其状态。
 */

/** 一次性执行模式标志（agent 跑完即退出，herdr 无法持续跟踪）。 */
const ONESHOT_ARGS = new Set(['--print', '-p', 'exec', '--execute', '--eval', '-e'])
export function registerAgentStart(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'herdr_agent_start',
    description:
      'Start a coding agent (e.g. pi, codex, claude) in a Herdr pane and wait until Herdr ' +
      'recognizes it and considers it ready, returning the agent identity and status. ' +
      'By default starts in a new pane inside this session dedicated workspace (off the ' +
      'bound pane, project cwd). This is the proper way to open an agent for a task: start it ' +
      'here, then submit work with herdr_agent_prompt and wait with herdr_agent_wait. Do NOT ' +
      'fake an agent with a one-shot command like pi --print — that just runs a command; it ' +
      'is not a Herdr agent and herdr_agent_wait cannot track it.',
    parameters: {
      kind: { type: 'string', required: true, description: 'Agent kind to start (e.g. pi, codex, claude); check your install' },
      name: { type: 'string', description: 'Agent name, follow <kind>-<purpose> (e.g. pi-disk-check); default auto-generates <kind>-<n> with a unique suffix' },
      pane_id: { type: 'string', description: 'Existing pane to start the agent in; default creates a new split pane in this session workspace' },
      args: { type: 'array', items: { type: 'string' }, description: 'Native arguments passed to the agent after --. CONFIGURATION FLAGS ONLY (e.g. --model); never pass task text or one-shot mode flags (--print, -p, exec, --execute, --eval) — those run a command and exit, which is not a tracked Herdr agent. Submit the task with herdr_agent_prompt instead.' },
      timeout_ms: { type: 'number', description: 'Startup timeout in ms (> 3000 and <= 300000; default 30000)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pane_id: { type: 'string' },
          workspace_id: { type: 'string' },
          agent: { type: 'string' },
          display_agent: { type: 'string' },
          status: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
        },
      },
      render: (args, value) => {
        const v = value as Partial<Record<string, unknown>>
        const lines = [
          'agent started: ' + String((v as any).agent ?? (v as any).display_agent ?? (v as any).name ?? (args as any).kind),
          'pane ' + String((v as any).pane_id ?? '') + ' status ' + String((v as any).status ?? 'unknown'),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    presentCall: (args) => ({ card: 'generic', title: 'Agent start ' + (args as any).kind, rawInput: (args as any).kind } as const),
    async execute(args, exec) {
      try {
        requireNonEmpty(args.kind, 'kind')
        // 拒绝一次性执行模式：agent 跑完即退出，herdr 无法持续跟踪，面板无状态可显示
        const oneShot = (args.args ?? []).find(a => ONESHOT_ARGS.has(a))
        if (oneShot) {
          throw new Error(
            'one-shot mode flag ' + oneShot + ' is not allowed in args: it runs a command and ' +
            'exits — not a tracked Herdr agent. Start the agent interactively (configuration ' +
            'flags only, no task text) and submit the task with herdr_agent_prompt instead.',
          )
        }
        let paneId = args.pane_id
        if (!paneId) {
          const bound = exec.agent ? getBindingRegistry().get(exec.agent.id) : undefined
          if (!bound) {
            throw new Error('no pane_id given and this session has no bound herdr pane; pass pane_id explicitly')
          }
          // 以绑定 pane 为 target split：新 pane 落在本会话专属 workspace，cwd 继承项目目录
          const { pane_id } = await ctx.herdr.paneSplit({ pane_id: bound.pane_id, direction: 'right' })
          paneId = pane_id
        }
        if (args.timeout_ms != null && (args.timeout_ms <= 3000 || args.timeout_ms > 300000)) {
          throw new Error('timeout_ms must be > 3000 and <= 300000')
        }
        // name 缺省：自动生成 <kind>-<n>（统计已有同名 agent 数保证唯一）
        let name = args.name
        if (!name) {
          const snap = await ctx.herdr.snapshot()
          const live = (snap.agents ?? [])
            .map(a => a.agent)
            .filter((x): x is string => typeof x === 'string' && x !== '')
          const n = live.filter(a => a === args.kind || a.startsWith(args.kind + '-')).length
          name = args.kind + '-' + String(n + 1)
        }
        const req: AgentStartRequest = {
          name,
          kind: args.kind,
          pane_id: paneId,
          args: args.args,
          timeout_ms: args.timeout_ms,
        }
        // 新 split 的 pane shell 可能尚未就绪（agent_pane_busy）：退避重试直到
        // 就绪或超时（agent.start 自身也有启动超时；此处覆盖 pane 初始化窗口）
        const started = async (): Promise<AgentInfo> => {
          const deadline = Date.now() + (req.timeout_ms ?? 30000)
          for (;;) {
            try {
              return await ctx.herdr.agentStart(req)
            } catch (err) {
              if (err instanceof HerdrError && err.serverCode === 'agent_pane_busy' && Date.now() < deadline) {
                await new Promise(res => setTimeout(res, 500))
                continue
              }
              throw err
            }
          }
        }
        const info: AgentInfo = await started()
        // agent 启动初期可能尚未注册就绪（agent_start 返回 status unknown），
        // 立即 prompt 会撞 agent_not_ready——等 agent.wait 观察到首个稳定状态
        // 再返回；等待失败（超时/未找到）不阻塞，模型可再显式 herdr_agent_wait
        if (info.interactive_ready !== true) {
          await ctx.herdr.waitAgent({
            target: req.name,
            until: ['idle', 'working', 'blocked', 'done'],
            timeout_ms: Math.min(req.timeout_ms ?? 30000, 30000),
          }, exec.signal).catch(() => {})
        }
        return {
          kind: args.kind,
          ...(info.pane_id ? { pane_id: info.pane_id } : {}),
          ...(info.workspace_id ? { workspace_id: info.workspace_id } : {}),
          ...(info.agent != null ? { agent: info.agent } : {}),
          ...(info.display_agent != null ? { display_agent: info.display_agent } : {}),
          ...(info.agent_status ? { status: info.agent_status } : {}),
          ...(info.name != null ? { name: info.name } : {}),
        }
      } catch (err) {
        toToolError(err)
      }
    },
  }))
}