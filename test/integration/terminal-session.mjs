// Real Herdr terminal session（observe/control）集成测试（design §11.3）
// 直接驱动官方 `herdr terminal session` CLI，验证 observer 首帧 full、持续输出、
// control resize 改变 PTY 尺寸、release 干净退出。无 herdr/server 时按 CA-009 SKIP。
// 运行：node test/integration/terminal-session.mjs
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { assertPreflight } from './preflight.mjs'

assertPreflight()

// 额外前置：terminal session 子命令存在（0.8.0+）
try {
  const help = execFileSync('herdr', ['terminal', 'session', '--help'], { encoding: 'utf8' })
  if (!/\bobserve\b|\bcontrol\b/.test(help)) {
    console.error('SKIPPED: herdr terminal session absence/trimmed build')
    process.exit(0)
  }
} catch {
  console.error('SKIPPED: herdr terminal session command missing')
  process.exit(0)
}

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('✔', name) }
  catch (err) { failures++; console.error('✖', name, '-', err.message) }
}

/** 起一个 observe/control 子进程，收集 stdout 事件，返回控制句柄。 */
function streamSession(mode, paneId, cols, rows, takeOver) {
  const args = ['terminal', 'session', mode, paneId, '--cols', String(cols), '--rows', String(rows)]
  if (mode === 'control' && takeOver) args.push('--takeover')
  const child = spawn('herdr', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const frames = []
  const closed = []
  const errors = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let o
      try { o = JSON.parse(line.trim()) } catch { continue }
      if (o.type === 'terminal.frame') frames.push(o)
      else if (o.type === 'terminal.closed') closed.push(o)
    }
  })
  child.stderr.resume()
  child.stderr.on('data', (c) => errors.push(String(c)))
  const waitFrames = (n, ms) => new Promise((resolve) => { // resolve when >=n frames seen
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (frames.length >= n || Date.now() - t0 > ms) { clearInterval(iv); resolve() }
    }, 50)
  })
  return {
    child, frames, closed, errors,
    send(o) { child.stdin.write(JSON.stringify(o) + '\n') },
    waitFrames,
    kill() { child.kill() },
  }
}

// 一次性 workspace
let wsId
try {
  const created = JSON.parse(execFileSync('herdr', ['workspace', 'create', '--label', 'ts-integration', '--cwd', '/tmp'], { encoding: 'utf8' }))
  wsId = created.result.workspace.workspace_id
  const paneId = created.result.root_pane.pane_id

  await check('observe: first frame is full with requested viewport size', async () => {
    const s = streamSession('observe', paneId, 60, 20)
    await s.waitFrames(1, 6000)
    assert.ok(s.frames.length >= 1, 'observe got a frame')
    const f = s.frames[0]
    assert.equal(f.type, 'terminal.frame')
    assert.equal(f.full, true, 'first frame full')
    assert.equal(f.width, 60)
    assert.equal(f.height, 20)
    s.kill()
  })

  await check('observe: ongoing output produces diff frames', async () => {
    const s = streamSession('observe', paneId, 60, 20)
    await s.waitFrames(1, 6000)
    // 在 pane 内产生输出
    execFileSync('herdr', ['pane', 'send-text', paneId, 'echo TS_ONGOING; sleep 0.3'], { encoding: 'utf8' })
    execFileSync('herdr', ['pane', 'send-keys', paneId, 'Enter'], { encoding: 'utf8' })
    await new Promise((r) => setTimeout(r, 800))
    assert.ok(s.frames.length >= 2, `expected ongoing frames, got ${s.frames.length}`)
    s.kill()
  })

  await check('control: resize sets new PTY viewport dimension + full redraw', async () => {
    const s = streamSession('control', paneId, 60, 20)
    await s.waitFrames(1, 6000)
    s.send({ type: 'terminal.resize', cols: 100, rows: 30 })
    await s.waitFrames(3, 4000)
    const last = s.frames[s.frames.length - 1]
    assert.ok(last.width === 100 && last.height === 30, `expected 100x30, got ${last.width}x${last.height}`)
    s.kill()
  })

  await check('control: release emits terminal.closed and child exits 0', async () => {
    const s = streamSession('control', paneId, 60, 20)
    await s.waitFrames(1, 6000)
    s.send({ type: 'terminal.release' })
    await new Promise((r) => setTimeout(r, 800))
    assert.ok(s.closed.length >= 1, 'terminal.closed emitted')
    assert.equal(s.child.exitCode, 0, `child exited 0, got ${s.child.exitCode}`)
  })

  await check('control: takeover replaces the existing controller', async () => {
    const a = streamSession('control', paneId, 60, 20)
    await a.waitFrames(1, 6000)
    const b = streamSession('control', paneId, 60, 20, true) // --takeover
    await b.waitFrames(1, 6000)
    try {
      assert.ok(b.frames.length >= 1, 'takeover session got a frame')
      await new Promise((r) => setTimeout(r, 900))
      const aDetached = a.closed.length >= 1 || a.child.exitCode !== null
      assert.ok(aDetached, `old controller should be detached after takeover (closed=${a.closed.length}, exit=${a.child.exitCode})`)
    } finally {
      b.send({ type: 'terminal.release' })
      await new Promise((r) => setTimeout(r, 400))
      a.kill(); b.kill()
    }
  })

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  if (wsId) {
    try { execFileSync('herdr', ['workspace', 'close', wsId], { encoding: 'utf8' }) } catch { /* ignore */ }
  }
}
