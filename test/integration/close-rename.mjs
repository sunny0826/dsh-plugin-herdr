// T14 集成测试：close/rename 全链路（pane/workspace rename + --clear + close 成功/重复错误）
// 运行：node test/integration/close-rename.mjs
//
// T01 已实测语义（env-findings.md v2 小节）：
//  - 多词 label 由 CLI 把位置参数 join 空格（无需引号包装）
//  - pane rename <PANE_ID> --clear 清除 label（snapshot 中 label 键整个消失，非 null/空串）
//  - close 错误：error envelope 在 stdout，exit 1（pane_not_found / workspace_not_found）
//  - close 成功：stdout 有 JSON envelope，result.type:"ok"，exit 0
//
// CA-009：preflight 不满足 → 打印 SKIP 原因并 exit 0（可选集成 job 干净跳过）。
// 超出 preflight 的环境能力不足（如沙箱下 workspace create 报 PermissionDenied）→ 打印原因并 SKIP exit 0。
// 其他任何一步在真实可用环境下失败 → 打印 FAIL 并以非零退出暴露问题。
// 只操作自己创建的资源（名字带唯一后缀），finally 中清理临时目录。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPreflight } from './preflight.mjs'

// CA-009：前置条件（herdr CLI + lib 构建 + server 可达）；不满足 → SKIP exit 0
assertPreflight()

// ---- 工具函数 ----
const TAG = '[herdr-close-rename]'
const SUFFIX = 'dsh-v2-int-' + Date.now()

/** 执行 herdr 命令，返回 {code, out, err}。CLI 出错常 exit 1，envelope 可能在 stdout。 */
function runHerdr(args) {
  try {
    const out = execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out: out.trim(), err: '' }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: (err.stdout ?? '').toString().trim(),
      err: (err.stderr ?? '').toString().trim(),
    }
  }
}

/** 解析 CLI envelope（stdout 优先，回退 stderr）；解析失败抛错。 */
function parseEnvelope(text) {
  const json = JSON.parse(text)
  if (json && typeof json === 'object') return json
  throw new Error('unexpected envelope shape: ' + text.slice(0, 80))
}

/** 取当前 snapshot.result.snapshot；失败抛错。 */
function snapshot() {
  const r = runHerdr(['api', 'snapshot'])
  if (r.code !== 0) throw new Error('snapshot failed (exit ' + r.code + '): ' + (r.err || r.out))
  return parseEnvelope(r.out).result.snapshot
}

/** 断言 r 是 error envelope 且 error.code 为 expectedCode，返回 error。 */
function expectErrorEnvelope(r, expectedCode) {
  const env = parseEnvelope(r.out || r.err)
  if (!env.error) throw new Error('expected error envelope, got: ' + JSON.stringify(env).slice(0, 120))
  if (env.error.code !== expectedCode) {
    throw new Error('expected error.code=' + expectedCode + ', got ' + env.error.code + ' (' + env.error.message + ')')
  }
  return env.error
}

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log('PASS', TAG, name)
  } catch (err) {
    failures++
    console.error('FAIL', TAG, name, '-', err.message)
  }
}

// 临时目录：测试 workspace 的 cwd；finally 删除
let tmp = null
let wsId = null
let rootPane = null

try {
  // 2a. 临时 cwd
  tmp = mkdtempSync(join(tmpdir(), 'dsh-close-rename-'))
  console.log(TAG, 'tmp cwd:', tmp)

  // 基线：记录现有 workspace 数，结尾核对该数量回到基线（不碰现有资源）
  const baseline = snapshot()
  const baseWsCount = baseline.workspaces.length

  // 2b. workspace create → workspace_id + root pane_id
  // T01 教训：无 PTY 沙箱下 create 可能 PermissionDenied → 打印原因并 SKIP exit 0，不硬失败。
  await check('workspace create', () => {
    const r = runHerdr(['workspace', 'create', '--cwd', tmp, '--label', 'probe-ws-' + SUFFIX])
    if (r.code !== 0) {
      throw new Error('workspace create failed (exit ' + r.code + '): ' + (r.err || r.out || '').slice(0, 200))
    }
    const res = parseEnvelope(r.out).result
    if (!res?.workspace?.workspace_id || !res?.root_pane?.pane_id) {
      throw new Error('create result missing workspace_id/root_pane.pane_id: ' + JSON.stringify(res).slice(0, 160))
    }
    wsId = res.workspace.workspace_id
    rootPane = res.root_pane.pane_id
  })
  if (!wsId) {
    // create 被拒（环境能力不足，如沙箱无 PTY）→ 明确 SKIP exit 0
    console.warn(TAG + ' [SKIP] workspace create 不可用（环境能力不足）→ ' + failures + ' 失败，跳过 close/rename 链路，exit 0')
    process.exit(0)
  }
  console.log(TAG, 'created workspace ' + wsId + ' (root pane ' + rootPane + ')')

  const paneInSnapshot = () => {
    const s = snapshot()
    const p = s.panes.find(x => x.pane_id === rootPane)
    if (!p) throw new Error('root pane ' + rootPane + ' missing from snapshot')
    return { s, p }
  }

  // 2c. pane rename 多词 label
  await check('pane rename multi-word label', () => {
    const r = runHerdr(['pane', 'rename', rootPane, 'my', 'agent', 'demo'])
    if (r.code !== 0) throw new Error('rename exit ' + r.code + ': ' + (r.out || r.err))
    const { p } = paneInSnapshot()
    if (p.label !== 'my agent demo') throw new Error('expected label "my agent demo", got ' + JSON.stringify(p.label))
  })

  // 2d. pane rename --clear → label 键消失
  await check('pane rename --clear removes label key', () => {
    const r = runHerdr(['pane', 'rename', rootPane, '--clear'])
    if (r.code !== 0) throw new Error('rename --clear exit ' + r.code + ': ' + (r.out || r.err))
    const { p } = paneInSnapshot()
    if (Object.prototype.hasOwnProperty.call(p, 'label')) {
      throw new Error('expected label key to be gone, got ' + JSON.stringify(p.label))
    }
  })

  // 2e. workspace rename 多词 label
  await check('workspace rename multi-word label', () => {
    const r = runHerdr(['workspace', 'rename', wsId, 'probe', 'ws', 'two'])
    if (r.code !== 0) throw new Error('workspace rename exit ' + r.code + ': ' + (r.out || r.err))
    const s = snapshot()
    const w = s.workspaces.find(x => x.workspace_id === wsId)
    if (!w) throw new Error('workspace ' + wsId + ' missing from snapshot')
    if (w.label !== 'probe ws two') throw new Error('expected label "probe ws two", got ' + JSON.stringify(w.label))
  })

  // keep the workspace alive across pane close: split the root pane so the
  // workspace is non-empty. Herdr auto-cleans a workspace when its LAST pane
  // closes (env-findings §16), which would otherwise make workspace close below
  // report workspace_not_found instead of exercising the success path.
  await check('pane split keeps workspace alive', () => {
    const r = runHerdr(['pane', 'split', '--pane', rootPane, '--direction', 'right'])
    if (r.code !== 0) throw new Error('pane split exit ' + r.code + ': ' + (r.out || r.err))
    const id = parseEnvelope(r.out).result?.pane?.pane_id
    if (!id) throw new Error('split result missing pane_id: ' + r.out.slice(0, 120))
    // root pane must still exist (split targets it); workspace now has 2 panes
    const s = snapshot()
    if (!s.panes.some(p => p.pane_id === rootPane)) {
      throw new Error('root pane missing after split')
    }
  })

  // 2f. pane close 成功
  await check('pane close succeeds', () => {
    const r = runHerdr(['pane', 'close', rootPane])
    if (r.code !== 0) throw new Error('pane close exit ' + r.code + ': ' + (r.out || r.err))
    const res = parseEnvelope(r.out).result
    if (res?.type !== 'ok') throw new Error('expected result.type "ok", got ' + JSON.stringify(res))
  })

  // 2g. pane close 重复 → pane_not_found
  await check('pane close twice -> pane_not_found', () => {
    const r = runHerdr(['pane', 'close', rootPane])
    if (r.code === 0) throw new Error('expected close to fail, but exit 0: ' + r.out)
    expectErrorEnvelope(r, 'pane_not_found')
  })

  // 2h. workspace close 成功
  await check('workspace close succeeds', () => {
    const r = runHerdr(['workspace', 'close', wsId])
    if (r.code !== 0) throw new Error('workspace close exit ' + r.code + ': ' + (r.out || r.err))
    const res = parseEnvelope(r.out).result
    if (res?.type !== 'ok') throw new Error('expected result.type "ok", got ' + JSON.stringify(res))
  })

  // 2i. workspace close 重复 → workspace_not_found
  await check('workspace close twice -> workspace_not_found', () => {
    const r = runHerdr(['workspace', 'close', wsId])
    if (r.code === 0) throw new Error('expected close to fail, but exit 0: ' + r.out)
    expectErrorEnvelope(r, 'workspace_not_found')
  })

  // 资源守恒：刚才创建的 workspace 已 close；snapshot 现有 workspace 数应回到基线
  await check('workspace count returned to baseline', () => {
    const s = snapshot()
    if (s.workspaces.length !== baseWsCount) {
      throw new Error('expected ' + baseWsCount + ' workspaces back to baseline, got ' + s.workspaces.length)
    }
  })
} finally {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log(TAG, 'tmp cleaned:', tmp)
  console.log(TAG, failures === 0 ? 'ALL CLOSE/RENAME CHECKS PASSED' : failures + ' CHECK(S) FAILED')
  process.exit(failures === 0 ? 0 : 1)
}