import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePaneId, probeCli, probeServer, startHerdrServer, type ExecFileFn, type HerdrServerInfo, type ServerProbeFn, type SpawnFn } from '../../src/status.ts'

test('comparePaneId: natural order (p2 < p10)', () => {
  const ids = ['w8:p10', 'w8:p2', 'w8:p1', 'w9:p1', 'w8:p11']
  ids.sort(comparePaneId)
  assert.deepEqual(ids, ['w8:p1', 'w8:p2', 'w8:p10', 'w8:p11', 'w9:p1'])
})

test('comparePaneId: same pane equals', () => {
  assert.equal(comparePaneId('w8:p1', 'w8:p1'), 0)
})

test('probeCli: installed binary reports available with version', async () => {
  const info = await probeCli('herdr')
  assert.equal(info.available, true)
  assert.match(info.version ?? '', /\d+\.\d+\.\d+/, 'version should contain 0.8.0')
})

test('probeCli: missing binary reports unavailable', async () => {
  const info = await probeCli('/nonexistent/herdr-bin-xyz')
  assert.equal(info.available, false)
  assert.equal(info.path, '/nonexistent/herdr-bin-xyz')
})

// ---------------------------------------------------------------------------
// probeServer / startHerdrServer（M7 启动看板）
// ---------------------------------------------------------------------------

const RUNNING_JSON = JSON.stringify({
  status: 'running', running: true, version: '0.8.0', protocol: 19,
  socket: '/x/herdr.sock', session: 'work', restart_needed: false,
})
const STOPPED_JSON = JSON.stringify({
  status: 'not_running', running: false, version: null, protocol: null,
  socket: '/x/herdr.sock', session: null, restart_needed: false,
})

function fakeExec(out: string): ExecFileFn {
  return (_cmd, _args, _opts, cb) => cb(null, out)
}

test('probeServer: parses running JSON', async () => {
  const info = await probeServer('herdr', fakeExec(RUNNING_JSON))
  assert.equal(info.running, true)
  assert.equal(info.status, 'running')
  assert.equal(info.version, '0.8.0')
  assert.equal(info.session, 'work')
})

test('probeServer: parses not_running JSON', async () => {
  const info = await probeServer('herdr', fakeExec(STOPPED_JSON))
  assert.equal(info.running, false)
  assert.equal(info.status, 'not_running')
})

test('probeServer: exec failure degrades to unknown', async () => {
  const info = await probeServer('herdr', (_c, _a, _o, cb) => cb(new Error('ENOENT'), ''))
  assert.equal(info.running, false)
  assert.equal(info.status, 'unknown')
})

test('probeServer: garbage stdout degrades to unknown', async () => {
  const info = await probeServer('herdr', fakeExec('not json at all'))
  assert.equal(info.running, false)
  assert.equal(info.status, 'unknown')
})

test('startHerdrServer: already running returns immediately without spawn', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'running', running: true, version: '0.8.0', protocol: 19, socket: null, session: null, checked_at: 0 })
  let spawned = false
  const spawn: SpawnFn = () => {
    spawned = true
    return { unref() {}, on() { return undefined } }
  }
  const info = await startHerdrServer('herdr', { timeoutMs: 200, spawnFn: spawn, probe })
  assert.equal(info.running, true)
  assert.equal(spawned, false, 'no spawn when already running')
})

test('startHerdrServer: spawns and polls until running', async () => {
  const events = [
    { t: 1, running: false, status: 'not_running' },
    { t: 2, running: false, status: 'not_running' },
    { t: 3, running: true, status: 'running' },
  ]
  let spawned = 0
  const probe: ServerProbeFn = async () => {
    if (events.length === 0) return { status: 'running', running: true, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
    const ev = events.shift()!
    return { status: ev.status, running: ev.running, version: null, protocol: null, socket: null, session: null, checked_at: 0 }
  }
  const spawn: SpawnFn = () => {
    spawned += 1
    return { unref() {}, on() { return undefined } }
  }
  const info = await startHerdrServer('herdr', { timeoutMs: 5000, spawnFn: spawn, probe })
  assert.equal(info.running, true)
  assert.equal(spawned, 1, 'spawned exactly once')
})

test('startHerdrServer: spawn error rejects', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'not_running', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 })
  const spawn: SpawnFn = () => {
    return {
      unref() {},
      on(_event, listener) {
        const l = listener as (err: Error) => void
        setImmediate(() => l(new Error('ENOENT')))
        return undefined
      },
    }
  }
  await assert.rejects(
    startHerdrServer('herdr', { timeoutMs: 5000, spawnFn: spawn, probe }),
    /spawn failed/,
  )
})

test('startHerdrServer: timeout returns last probe (not running)', async () => {
  const probe: ServerProbeFn = async () => ({ status: 'not_running', running: false, version: null, protocol: null, socket: null, session: null, checked_at: 0 })
  const spawn: SpawnFn = () => ({ unref() {}, on() { return undefined } })
  const started = Date.now()
  const info = await startHerdrServer('herdr', { timeoutMs: 60, spawnFn: spawn, probe })
  assert.equal(info.running, false)
  assert.ok(Date.now() - started >= 490, 'at least one poll interval elapsed (clock-jitter tolerant)')
})
