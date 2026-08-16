// CA-009：集成测试前置条件检查（herdr/lib/server）。
// 所有 test/integration/*.mjs 在开头调用；条件不满足时打印明确 SKIP 原因并退出 0，
// 使 CI 的 optional integration job 在无 herdr 环境也能干净跳过而非误报失败。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 返回不满足的前置条件列表；空数组 = 全部满足。 */
export function checkPreflight(opts = {}) {
  const { requireServer = true } = opts
  const reasons = []
  if (!existsSync(join(root, 'lib', 'index.mjs'))) {
    reasons.push('lib/ not built (run: pnpm build)')
  }
  try {
    execFileSync('herdr', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  } catch {
    reasons.push('herdr CLI not on PATH')
  }
  if (requireServer) {
    try {
      const out = execFileSync('herdr', ['status', 'server', '--json'], { encoding: 'utf8', stdio: 'pipe' })
      const info = JSON.parse(out)
      if (!info.running) reasons.push('herdr server not running (run: herdr server)')
    } catch {
      reasons.push('herdr server status check failed (herdr status server --json)')
    }
  }
  return reasons
}

/** 前置条件不满足时打印 SKIPPED 原因并退出 0；满足则静默返回。 */
export function assertPreflight(opts) {
  const reasons = checkPreflight(opts)
  if (reasons.length === 0) return
  console.error('SKIPPED: integration test preconditions missing -> ' + reasons.join('; '))
  process.exit(0)
}

/**
 * 确保至少一个 workspace 存在：全新 herdr server（如 CI runner 上刚启动的）
 * 没有任何 workspace/pane，snapshot 断言和 pane split 会失败。
 * 必要时创建一个并返回清理函数（调用方在 finally 中执行）。
 */
export async function ensureWorkspace(herdr) {
  const snap = await herdr.snapshot()
  if (snap.workspaces.length > 0) return () => {}
  const w = await herdr.workspaceCreate({ label: 'dsh-integration', cwd: process.env.HOME ?? '/' })
  console.log(`  (created workspace ${w.workspace_id} for integration tests)`)
  return () => {
    try { execFileSync('herdr', ['workspace', 'close', w.workspace_id], { encoding: 'utf8' }) } catch { /* ignore */ }
  }
}
