import type { Context } from '@deepseek-ai/cordis'
import { SocketHerdrClient } from './client/socket.ts'
import { resolveSession, resolveSocketPath, type Config } from './config.ts'
import { ensureHerdrPreset } from './preset-install.ts'
import { createLogger } from './log.ts'

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
 * 全量迁移后传输固定为 socket（CLI 传输已移除）：SocketHerdrClient 仅支持
 * POSIX Unix domain socket；Windows（named pipe）不支持，socket 路径不可解析
 * 时加载报错（D3）。
 *
 * M5 状态面板（tracker + HTTP 端点）装配在消费者插件 index.ts——那里
 * inject ['herdr'] 保证服务已就绪，且 webServer 路由可在此注册。
 */
export function apply(ctx: Context, config: Config) {
  // herdr 模式 preset：复制到 $DSH_HOME/.agent-presets/（新建会话的模式选择器可见）
  ensureHerdrPreset(undefined, createLogger(ctx, 'preset'))

  const socketPath = resolveSocketPath(config)
  if (!socketPath) {
    throw new Error('dsh-plugin-herdr requires a resolvable socket path (POSIX only; Windows named pipe is not supported — set config.socketPath or HERDR_SOCKET_PATH)')
  }
  ctx.plugin(SocketHerdrClient, { socketPath, timeoutMs: config.timeoutMs })
}
