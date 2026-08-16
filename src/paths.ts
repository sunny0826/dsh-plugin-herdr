// 项目目录过滤的路径匹配纯函数（design-v2 §7.2）。
// isPathWithin 是可注入的纯核心（单测覆盖 win32 分支用）；isPathWithinProject 是默认包装。
import path from 'node:path'
import fs from 'node:fs'

/** realpath 归一：失败（路径不存在/权限）回退原值，避免符号链接误判。 */
function realpathOrSelf(x: string): string {
  try {
    return fs.realpathSync(x)
  } catch {
    return x
  }
}

/** isPathWithin 的可注入选项。 */
export interface PathWithinOptions {
  /** 路径分隔符（默认 path.sep；win32 分支单测注入 '\\\\'）。 */
  sep?: string
  /** 是否大小写不敏感比较（win32 默认 true，比较前统一小写）。 */
  caseInsensitive?: boolean
  /** realpath 实现（默认 realpathOrSelf；测试可注入恒等函数跳过文件系统）。 */
  realpath?: (x: string) => string
}

const DEFAULTS: Required<PathWithinOptions> = {
  sep: path.sep,
  caseInsensitive: process.platform === 'win32',
  realpath: realpathOrSelf,
}

/** 前缀边界比较核心：p === root 或 p 以 root + sep 开头（/a/b 不算 /a/bc 的祖先）。 */
function withinCore(root: string, p: string, sep: string): boolean {
  if (root === '') return p === ''
  if (p === root) return true
  return p.startsWith(root + sep)
}

/**
 * 判断 p 是否位于 root 项目根内（纯函数，可注入）。
 * - p 为 null / undefined / 空串 → false；
 * - 相对路径按原值比较（不拼 cwd）→ 与绝对 root 比较近恒为 false（要求绝对路径）；
 * - 先 realpath 归一（失败回退原值），再做前缀边界比较，避免符号链接误判。
 */
export function isPathWithin(
  root: string,
  p: string | null | undefined,
  opts?: PathWithinOptions,
): boolean {
  if (p === null || p === undefined) return false
  if (p === '') return false
  const { sep, caseInsensitive, realpath } = { ...DEFAULTS, ...opts }
  const a = realpath(root)
  const b = realpath(p)
  const rootN = caseInsensitive ? a.toLowerCase() : a
  const pathN = caseInsensitive ? b.toLowerCase() : b
  return withinCore(rootN, pathN, sep)
}

/**
 * 默认包装：使用 path.sep、win32 大小写不敏感、真实 realpath 归一。
 * 供 status.ts 轮询判断 pane cwd / worktree checkout_path 是否在本项目目录内。
 */
export function isPathWithinProject(
  projectRoot: string,
  p: string | null | undefined,
): boolean {
  return isPathWithin(projectRoot, p)
}
