import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PRESET_ID = 'herdr'

/**
 * 把插件自带的 herdr preset 同步到 $DSH_HOME/.agent-presets/herdr/。
 *
 * - 未安装：完整复制（herdr 模式开关出现在新建会话的模式选择器）；
 * - 已安装且内容与源一致：跳过（幂等）；
 * - 已安装但内容与源不同（插件升级带来新组合）：先把旧文件备份为
 *   `<file>.herdr-bak-<ts>` 再覆盖，避免用户自定义配置被静默丢弃。
 * 返回 preset 目录；无法定位源时返回 null。
 */
export interface PresetInstallLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

/** 无 ctx 的模块级安装助手；可传入 logger（CA-017），缺省回退 console。 */
export function ensureHerdrPreset(dshHome?: string, logger?: PresetInstallLogger): string | null {
  const log = logger ?? { info: console.log.bind(console), warn: console.warn.bind(console) }
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = join(home, '.agent-presets', PRESET_ID)

  // 源：lib/../presets/herdr（构建产物）或 src/../presets/herdr（源码直跑）
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(selfDir, '..', 'presets', PRESET_ID),
    join(selfDir, '..', '..', 'presets', PRESET_ID),
  ]
  const src = candidates.find(p => existsSync(join(p, 'agent.cordis.yml')))
  if (!src) return null

  try {
    mkdirSync(target, { recursive: true })
    let installed = false
    for (const f of readdirSync(src)) {
      const from = join(src, f)
      const to = join(target, f)
      if (existsSync(to)) {
        const same = readFileSync(from, 'utf8') === readFileSync(to, 'utf8')
        if (same) continue
        // 用户可能改过旧文件：备份后再覆盖，配置不静默丢失
        renameSync(to, `${to}.herdr-bak-${Date.now()}`)
        log.info('preset "%s": backed up outdated %s and updated', PRESET_ID, f)
      }
      copyFileSync(from, to)
      installed = true
    }
    if (installed) log.info('preset "%s" installed at %s (herdr 模式开关已可用)', PRESET_ID, target)
    return target
  } catch (err) {
    log.warn('preset install failed: %s', err instanceof Error ? err.message : String(err))
    return null
  }
}
