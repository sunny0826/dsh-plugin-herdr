import type { Context } from '@deepseek-ai/cordis'
import { CliHerdrClient } from './client/cli.ts'
import { SocketHerdrClient } from './client/socket.ts'
import { resolveCliPath, resolveSession, resolveSocketPath, type Config } from './config.ts'
import { ensureHerdrPreset } from './preset-install.ts'

// cordis 通过模块导出的 Config 校验插件配置并填充默认值
export { Config } from './config.ts'

export const name = 'dsh-plugin-herdr-client'

/**
 * 提供者插件：注册 ctx.herdr 服务（DESIGN.md §3.2 能力分层）。
 *
 * cordis 4 的服务解析要求：访问某服务的 fiber 必须显式 inject 该服务
 * （fiber.store 只快照 inject 声明的依赖），否则解析链走到根上下文会抛
 * "cannot get property X without inject"。因此提供者与消费者必须拆成
 * 两个插件：本模块提供服务，index.ts 作为消费者 inject ['tools', 'herdr']。
 *
 * 传输层按 config.transport 选择（M2-02 工厂）：
 * - cli（默认）：CliHerdrClient；
 * - socket（M2 起）：SocketHerdrClient（仅 POSIX，需可解析 socket 路径）。
 *
 * M5 状态面板（tracker + HTTP 端点）装配在消费者插件 index.ts——那里
 * inject ['herdr'] 保证服务已就绪，且 webServer 路由可在此注册。
 */
export function apply(ctx: Context, config: Config) {
  // herdr 模式 preset：复制到 $DSH_HOME/.agent-presets/（新建会话的模式选择器可见）
  ensureHerdrPreset()

  if (config.transport === 'socket') {
    const socketPath = resolveSocketPath(config)
    if (!socketPath) {
      throw new Error('transport "socket" requires a resolvable socket path (POSIX only; set config.socketPath)')
    }
    ctx.plugin(SocketHerdrClient, { socketPath, timeoutMs: config.timeoutMs })
  } else {
    ctx.plugin(CliHerdrClient, {
      cliPath: resolveCliPath(config),
      session: resolveSession(config),
      timeoutMs: config.timeoutMs,
    })
  }
}
