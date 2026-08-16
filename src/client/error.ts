/**
 * Herdr 调用失败（连接/环境/协议类错误，工具层应抛错；业务性失败由规范值表达）。
 *
 * 传输无关错误契约（D4：由 HerdrCliError 更名——插件已全量迁移至 socket 传输，
 * CLI 传输不复存在，错误类型不再绑定 CLI 语义）。
 */
export class HerdrError extends Error {
  readonly code: 'HERDR_UNAVAILABLE' | 'HERDR_PROTOCOL' | 'HERDR_ERROR' | 'HERDR_TIMEOUT' | 'HERDR_ABORTED'

  /** 服务器 error envelope 的 code（如 agent_not_found / timeout / pane_not_found）；客户端侧错误为 undefined。 */
  readonly serverCode?: string

  constructor(
    code: 'HERDR_UNAVAILABLE' | 'HERDR_PROTOCOL' | 'HERDR_ERROR' | 'HERDR_TIMEOUT' | 'HERDR_ABORTED',
    message: string,
    serverCode?: string,
  ) {
    super(message)
    this.name = 'HerdrError'
    this.code = code
    if (serverCode !== undefined) this.serverCode = serverCode
  }
}
