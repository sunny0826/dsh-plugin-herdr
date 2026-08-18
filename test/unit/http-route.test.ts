// CA-007：控制面路由级验证 —— 加载插件（src）注册 3 条路由，用伪造 req/res 验证
// 方法/来源边界（未授权不可启动进程、不可读终端输出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.ts'
import { apply as applyClient } from '../../src/client-entry.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'
import type { Config as ConfigType } from '../../src/config.ts'

const CONFIG: ConfigType = {
  timeoutMs: 30000,
  allowBackground: false,
  events: { enabled: false, maxReconnectMs: 30000 },
  reportState: false,
}

interface FakeRes {
  writeHead(code: number, headers: Record<string, string>): void
  end(body?: string): void
}

interface Route {
  kind: string
  path: string
  handler(req: unknown, res: FakeRes): unknown
}

async function invoke(handler: Route['handler'], req: unknown): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> | null }> {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res: FakeRes = {
    writeHead: (code, h) => { status = code; headers = h },
    end: (b?: string) => { body = b ?? '' },
  }
  await handler(req, res)
  return { status, headers, body: body ? (JSON.parse(body) as Record<string, unknown>) : null }
}

interface FakeHerdr {
  snapshot(): Promise<unknown>
  workspaceClose(id: string): Promise<void>
  paneClose(id: string): Promise<void>
  workspaceRename(id: string, label: string): Promise<void>
  paneRename(id: string, label: string | null): Promise<void>
  [key: string]: unknown
}

/** 无真实 herdr 服务的隔离测试用 fake：仅提供路由所需（+ tracker snapshot 轮询）。 */
function makeFakeHerdr(): FakeHerdr {
  return {
    snapshot: async () => ({
      version: '0.8.0',
      protocol: 19,
      workspaces: [
        { workspace_id: 'w1', label: 'demo', pane_count: 2 },
        { workspace_id: 'w2', label: 'other', pane_count: 1 },
      ],
      agents: [],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w1:p2', workspace_id: 'w1' },
        { pane_id: 'w2:p1', workspace_id: 'w2' },
      ],
      tabs: [],
      layouts: [],
      focused_pane_id: 'w1:p1',
      focused_tab_id: null,
      focused_workspace_id: 'w1',
    }),
    workspaceClose: async () => undefined,
    paneClose: async () => undefined,
    workspaceRename: async () => undefined,
    paneRename: async () => undefined,
    paneSendInput: async () => undefined,
    paneWaitForOutputChange: async (req: { min_revision: number }) => ({ changed: false, revision: req.min_revision }),
  }
}

async function loadPlugin(opts: { fakeHerdr?: FakeHerdr } = {}): Promise<{ routes: Route[]; dispose(): Promise<void> }> {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('webServer', { register: (r: Route) => { routes.push(r); return () => {} } })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('jobs', { start: () => 'herdr-1' })
  let clientFiber: { dispose(): Promise<void> } | null = null
  if (opts.fakeHerdr) {
    // 注入 fake herdr，isolated 测试路由逻辑；跳过真实 client-entry（避免 spawn CLI）
    ctx.provide('herdr', opts.fakeHerdr)
  } else {
    clientFiber = await ctx.plugin({ name: 'dsh-plugin-herdr-client', apply: applyClient, inject: [] }, CONFIG)
  }
  const fiber = await ctx.plugin({ name: 'dsh-plugin-herdr', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)
  return {
    routes,
    dispose: async () => { await fiber.dispose(); if (clientFiber) await clientFiber.dispose() },
  }
}

const LOCAL = { host: 'localhost:1234' }

test('CA-007: /herdr-status is GET-only and rejects non-local/cross-site requests', async () => {
  const { routes, dispose } = await loadPlugin()
  try {
    const route = routes.find(r => r.path === '/herdr-status')
    assert.ok(route, '/herdr-status registered')
    // 错误方法 → 405 + Allow
    const m = await invoke(route!.handler, { method: 'POST', headers: LOCAL })
    assert.equal(m.status, 405)
    assert.equal(m.headers.allow, 'GET')
    // 非本地 Host → 403
    const h = await invoke(route!.handler, { method: 'GET', headers: { host: 'evil.example' } })
    assert.equal(h.status, 403)
    // 跨站 Origin → 403（浏览器 CSRF 读终端）
    const o = await invoke(route!.handler, { method: 'GET', headers: { host: 'localhost:1234', origin: 'http://evil.example' } })
    assert.equal(o.status, 403)
    // 可信本地请求 → 200 JSON
    const ok = await invoke(route!.handler, { method: 'GET', headers: LOCAL })
    assert.equal(ok.status, 200)
    assert.ok(ok.body && typeof ok.body === 'object')
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-session-pane is GET-only and guarded', async () => {
  const { routes, dispose } = await loadPlugin()
  try {
    const route = routes.find(r => r.path === '/herdr-session-pane')
    assert.ok(route)
    const m = await invoke(route!.handler, { method: 'DELETE', headers: LOCAL })
    assert.equal(m.status, 405)
    assert.equal(m.headers.allow, 'GET')
    const o = await invoke(route!.handler, { method: 'GET', headers: { host: 'localhost:1234', 'sec-fetch-site': 'cross-site' } })
    assert.equal(o.status, 403)
    const ok = await invoke(route!.handler, { method: 'GET', url: '/herdr-session-pane?agent=abc', headers: LOCAL })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { pane_id: null })
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-pane-session resolves pane → session (registry + tokens fallback)', async () => {
  const reg = getBindingRegistry()
  reg.set('session-a', { pane_id: 'w1:p1', created: false })
  const fake = makeFakeHerdr()
  fake.snapshot = async () => ({
    version: '0.8.0',
    protocol: 19,
    workspaces: [],
    agents: [],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tokens: { dsh_session: 'session-b' } },
    ],
    tabs: [],
    layouts: [],
    focused_pane_id: null,
    focused_tab_id: null,
    focused_workspace_id: null,
  })
  const { routes, dispose } = await loadPlugin({ fakeHerdr: fake })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-session')
    assert.ok(route, '/herdr-pane-session registered')
    // GET-only + local guard
    const m = await invoke(route!.handler, { method: 'DELETE', headers: LOCAL })
    assert.equal(m.status, 405)
    assert.equal(m.headers.allow, 'GET')
    const o = await invoke(route!.handler, { method: 'GET', headers: { host: 'localhost:1234', 'sec-fetch-site': 'cross-site' } })
    assert.equal(o.status, 403)
    // 无 pane 参数 → null
    const none = await invoke(route!.handler, { method: 'GET', url: '/herdr-pane-session', headers: LOCAL })
    assert.deepEqual(none.body, { session_id: null })
    // 绑定 registry 反查命中
    const self = await invoke(route!.handler, { method: 'GET', url: '/herdr-pane-session?pane=w1:p1', headers: LOCAL })
    assert.deepEqual(self.body, { session_id: 'session-a' })
    // registry 未命中 → herdr pane tokens 兜底
    const fallback = await invoke(route!.handler, { method: 'GET', url: '/herdr-pane-session?pane=w1:p2', headers: LOCAL })
    assert.deepEqual(fallback.body, { session_id: 'session-b' })
    // 完全无归属 → null
    const unbound = await invoke(route!.handler, { method: 'GET', url: '/herdr-pane-session?pane=w1:p9', headers: LOCAL })
    assert.deepEqual(unbound.body, { session_id: null })
  } finally {
    await dispose()
    reg.delete('session-a')
  }
})

test('CA-007: /herdr-start is POST-only; GET/cross-origin never reach the process spawn', async () => {
  const { routes, dispose } = await loadPlugin()
  try {
    const route = routes.find(r => r.path === '/herdr-start')
    assert.ok(route)
    // GET（错误方法）→ 405，不启动任何进程
    const g = await invoke(route!.handler, { method: 'GET', headers: LOCAL })
    assert.equal(g.status, 405)
    // 跨站 Origin → 403，不启动任何进程
    const o = await invoke(route!.handler, { method: 'POST', headers: { host: 'localhost:1234', origin: 'http://evil.example' } })
    assert.equal(o.status, 403)
    assert.match(String(o.body?.error), /cross-origin/)
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-close closes a workspace via fake herdr', async () => {
  const fake = makeFakeHerdr()
  const closed: string[] = []
  fake.workspaceClose = async (id: string) => { closed.push(id) }
  const { routes, dispose } = await loadPlugin({ fakeHerdr: fake })
  try {
    const route = routes.find(r => r.path === '/herdr-close')
    assert.ok(route, '/herdr-close registered')
    const m = await invoke(route!.handler, { method: 'GET', headers: LOCAL })
    assert.equal(m.status, 405) // 方法守卫
    assert.equal(m.headers.allow, 'POST')
    const ok = await invoke(route!.handler, { method: 'POST', headers: LOCAL, body: { kind: 'workspace', id: 'w1' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true })
    assert.deepEqual(closed, ['w1'])
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-close rejects closing the pane hosting this session', async () => {
  const reg = getBindingRegistry()
  reg.set('agent-1', { pane_id: 'w1:p1', created: false })
  try {
    const fake = makeFakeHerdr()
    const closed: string[] = []
    fake.paneClose = async (id: string) => { closed.push(id) }
    const { routes, dispose } = await loadPlugin({ fakeHerdr: fake })
    try {
      const route = routes.find(r => r.path === '/herdr-close')!
      // 直接关闭绑定 pane → 400 拒绝，不调用 herdr
      const self = await invoke(route.handler, { method: 'POST', headers: LOCAL, body: { kind: 'pane', id: 'w1:p1' } })
      assert.equal(self.status, 400)
      assert.match(String(self.body?.error), /cannot close the pane hosting this session/)
      assert.deepEqual(closed, [])
      // 关闭含绑定 pane 的 workspace → 同样拒绝
      const ws = await invoke(route.handler, { method: 'POST', headers: LOCAL, body: { kind: 'workspace', id: 'w1' } })
      assert.equal(ws.status, 400)
      assert.match(String(ws.body?.error), /cannot close the workspace hosting this session/)
      assert.deepEqual(closed, [])
      // 关闭无关 pane → 放行
      const ok = await invoke(route.handler, { method: 'POST', headers: LOCAL, body: { kind: 'pane', id: 'w1:p2' } })
      assert.equal(ok.status, 200)
      assert.deepEqual(closed, ['w1:p2'])
    } finally {
      await dispose()
    }
  } finally {
    reg.delete('agent-1')
  }
})

test('CA-007: /herdr-close surfaces missing/not-found id errors as { ok:false }', async () => {
  const fake = makeFakeHerdr()
  fake.paneClose = async () => { throw new Error('pane_not_found: pane w1:zz not found') }
  const { routes, dispose } = await loadPlugin({ fakeHerdr: fake })
  try {
    const route = routes.find(r => r.path === '/herdr-close')!
    const bad = await invoke(route.handler, { method: 'POST', headers: LOCAL, body: { kind: 'bogus', id: 'w1' } })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body?.error), /kind/)
    const missing = await invoke(route.handler, { method: 'POST', headers: LOCAL, body: { kind: 'pane', id: 'w1:zz' } })
    assert.equal(missing.status, 200)
    assert.equal(missing.body?.ok, false)
    assert.match(String(missing.body?.error), /pane_not_found/)
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-rename validates label and renames via fake herdr', async () => {
  const fake = makeFakeHerdr()
  const ops: Array<[string, string | null]> = []
  fake.paneRename = async (_id: string, label: string | null) => { ops.push(['pane', label]) }
  fake.workspaceRename = async (_id: string, label: string) => { ops.push(['ws', label]) }
  const { routes, dispose } = await loadPlugin({ fakeHerdr: fake })
  try {
    const route = routes.find(r => r.path === '/herdr-rename')
    assert.ok(route, '/herdr-rename registered')
    const m = await invoke(route!.handler, { method: 'DELETE', headers: LOCAL })
    assert.equal(m.status, 405) // 方法守卫
    assert.equal(m.headers.allow, 'POST')
    // pane 改名（label 可空 = 清除）
    const p = await invoke(route!.handler, { method: 'POST', headers: LOCAL, body: { kind: 'pane', id: 'w1:p1', label: 'demo pane' } })
    assert.equal(p.status, 200)
    assert.deepEqual(p.body, { ok: true })
    assert.deepEqual(ops, [['pane', 'demo pane']])
    // workspace 空 label → 400
    const wsEmpty = await invoke(route!.handler, { method: 'POST', headers: LOCAL, body: { kind: 'workspace', id: 'w1', label: '  ' } })
    assert.equal(wsEmpty.status, 400)
    assert.match(String(wsEmpty.body?.error), /label/)
    // label 超长 → 400
    const tooLong = await invoke(route!.handler, { method: 'POST', headers: LOCAL, body: { kind: 'pane', id: 'w1:p1', label: 'x'.repeat(65) } })
    assert.equal(tooLong.status, 400)
    assert.match(String(tooLong.body?.error), /at most 64/)
    // 正常 workspace 改名
    const w = await invoke(route!.handler, { method: 'POST', headers: LOCAL, body: { kind: 'workspace', id: 'w1', label: 'renamed' } })
    assert.equal(w.status, 200)
    assert.deepEqual(ops, [['pane', 'demo pane'], ['ws', 'renamed']])
  } finally {
    await dispose()
  }
})

test('CA-007: /herdr-dashboard is GET-only, guarded, and returns the read-only DTO', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-dashboard')
    assert.ok(route, '/herdr-dashboard registered')
    // 错误方法 → 405 + Allow
    const m = await invoke(route!.handler, { method: 'POST', headers: LOCAL })
    assert.equal(m.status, 405)
    assert.equal(m.headers.allow, 'GET')
    // 非本地 Host → 403
    const h = await invoke(route!.handler, { method: 'GET', headers: { host: 'evil.example' } })
    assert.equal(h.status, 403)
    // 跨站 Origin → 403
    const o = await invoke(route!.handler, { method: 'GET', headers: { host: 'localhost:1234', origin: 'http://evil.example' } })
    assert.equal(o.status, 403)
    // 可信本地 GET → 200 + 完整 DTO 结构（host 恒可用；process 为 best-effort）
    const ok = await invoke(route!.handler, { method: 'GET', headers: LOCAL })
    assert.equal(ok.status, 200)
    const snap = ok.body as Record<string, unknown>
    for (const key of ['updated_at', 'stale', 'last_error', 'server', 'connection', 'host', 'process', 'summary', 'workspaces']) {
      assert.ok(key in snap, `dashboard DTO missing key ${key}`)
    }
    const host = snap.host as Record<string, unknown>
    assert.equal(typeof host.hostname, 'string')
    assert.equal(typeof host.arch, 'string')
    const proc = snap.process as Record<string, unknown>
    assert.equal(typeof proc.available, 'boolean')
    assert.equal(typeof proc.sampled_at, 'number')
    const server = snap.server as Record<string, unknown>
    assert.equal(typeof server.status, 'string')
  } finally {
    await dispose()
  }
})

// ------------------------------------------------------------------
// POST /herdr-pane-input 路由（design: pane-interactive-terminal §3.4）
// ------------------------------------------------------------------

test('/herdr-pane-input: rejects non-POST methods', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const { status } = await invoke(route.handler, { method: 'GET', headers: LOCAL, url: '/herdr-pane-input' })
    assert.equal(status, 405)
  } finally { await dispose() }
})

test('/herdr-pane-input: rejects invalid JSON body', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from('not json')
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 400)
    assert.equal(body?.ok, false)
  } finally { await dispose() }
})

test('/herdr-pane-input: rejects missing pane_id', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ kind: 'text', text: 'hi' }))
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 400)
    assert.ok(String(body?.error ?? '').includes('pane_id'), 'error must mention pane_id')
  } finally { await dispose() }
})

test('/herdr-pane-input: rejects invalid kind', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p1', kind: 'invalid' }))
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 400)
    assert.ok(String(body?.error ?? '').includes('kind'), 'error must mention kind')
  } finally { await dispose() }
})

test('/herdr-pane-input: text kind requires text field', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p1', kind: 'text' }))
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 400)
    assert.ok(String(body?.error ?? '').includes('text'), 'error must mention text')
  } finally { await dispose() }
})

test('/herdr-pane-input: keys kind requires keys array', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p1', kind: 'keys' }))
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 400)
    assert.ok(String(body?.error ?? '').includes('keys'), 'error must mention keys')
  } finally { await dispose() }
})

test('/herdr-pane-input: forwards combined text and keys atomically', async () => {
  const fakeHerdr = makeFakeHerdr()
  let captured: Record<string, unknown> | null = null
  fakeHerdr.paneSendInput = async (input: Record<string, unknown>) => { captured = input }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p1', text: 'deploy', keys: ['enter'] }))
    const { status, body } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 200)
    assert.equal(body?.ok, true)
    assert.deepEqual(captured, { pane_id: 'w1:p1', text: 'deploy', keys: ['enter'] })
  } finally { await dispose() }
})

test('/herdr-pane-input: ownership check uses workspace-level validation (source verification)', () => {
  // Source code verification: ownership check uses workspace-level validation
  const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts'), 'utf8')
  assert.ok(indexSource.includes('getBoundWorkspaceIds'), 'must use workspace-level ownership check')
  assert.ok(indexSource.includes('targetWs'), 'must resolve target pane workspace_id')
  assert.ok(indexSource.includes('boundWsIds.has(targetWs)'), 'must check workspace membership')
})

test('/herdr-pane-input: ownership check allows pane in same workspace', async () => {
  const fakeHerdr = makeFakeHerdr()
  let sendInputCalled = false
  fakeHerdr.paneSendInput = async () => { sendInputCalled = true }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const reg = getBindingRegistry()
    reg.set('test-agent', { pane_id: 'w1:p1', created: true, workspace_id: 'w1' })
    try {
      const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p2', kind: 'text', text: 'hi' }))
      const { status } = await invoke(route.handler, {
        method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
        on: (ev: string, cb: (chunk?: Buffer) => void) => {
          if (ev === 'data') setTimeout(() => cb(data), 0)
          if (ev === 'end') setTimeout(() => cb(), 1)
        },
        once: () => {}, removeListener: () => {},
      })
      assert.equal(status, 200)
      assert.ok(sendInputCalled, 'paneSendInput must be called for same-workspace pane')
    } finally {
      reg.delete('test-agent')
    }
  } finally { await dispose() }
})

test('/herdr-pane-input: no binding allows all panes (pre-binding state)', async () => {
  const fakeHerdr = makeFakeHerdr()
  let sendInputCalled = false
  fakeHerdr.paneSendInput = async () => { sendInputCalled = true }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-input')!
    const data = Buffer.from(JSON.stringify({ pane_id: 'w1:p1', kind: 'text', text: 'hi' }))
    const { status } = await invoke(route.handler, {
      method: 'POST', headers: LOCAL, url: '/herdr-pane-input',
      on: (ev: string, cb: (chunk?: Buffer) => void) => {
        if (ev === 'data') setTimeout(() => cb(data), 0)
        if (ev === 'end') setTimeout(() => cb(), 1)
      },
      once: () => {}, removeListener: () => {},
    })
    assert.equal(status, 200)
    assert.ok(sendInputCalled, 'paneSendInput must be called when no bindings exist')
  } finally { await dispose() }
})

// ------------------------------------------------------------------
// GET /herdr-pane-terminal-bootstrap 路由（design: pane-xterm-terminal-design §5）
// ------------------------------------------------------------------

test('/herdr-pane-terminal-bootstrap: rejects non-GET methods', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    const { status } = await invoke(route.handler, { method: 'POST', headers: LOCAL, url: '/herdr-pane-terminal-bootstrap' })
    assert.equal(status, 405)
  } finally { await dispose() }
})

test('/herdr-pane-terminal-bootstrap: rejects missing pane_id', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    const { status, body } = await invoke(route.handler, { method: 'GET', headers: LOCAL, url: '/herdr-pane-terminal-bootstrap' })
    assert.equal(status, 400)
    assert.ok(String(body?.error ?? '').includes('pane_id'), 'error must mention pane_id')
  } finally { await dispose() }
})

test('/herdr-pane-terminal-bootstrap: returns snapshot with revision', async () => {
  const fakeHerdr = makeFakeHerdr()
  let readRequest: Record<string, unknown> | null = null
  fakeHerdr.paneRead = async (req: Record<string, unknown>) => {
    readRequest = req
    return { text: '\u001b[31mhello\u001b[0m', truncated: false, revision: 42 }
  }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    const { status, body } = await invoke(route.handler, {
      method: 'GET', headers: LOCAL,
      url: '/herdr-pane-terminal-bootstrap?pane_id=w1:p1',
    })
    assert.equal(status, 200)
    assert.equal(body?.ok, true)
    assert.equal(body?.revision, 42)
    assert.equal(body?.truncated, false)
    assert.ok(typeof body?.text === 'string')
    assert.equal((readRequest as Record<string, unknown> | null)?.source, 'visible')
    assert.equal((readRequest as Record<string, unknown> | null)?.format, 'ansi')
  } finally { await dispose() }
})

// ------------------------------------------------------------------
// GET /herdr-pane-terminal-wait（events.wait + revision）
// ------------------------------------------------------------------

test('/herdr-pane-terminal-wait: validates after_revision', async () => {
  const { routes, dispose } = await loadPlugin({ fakeHerdr: makeFakeHerdr() })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-wait')!
    const missing = await invoke(route.handler, {
      method: 'GET', headers: LOCAL, url: '/herdr-pane-terminal-wait?pane_id=w1:p1',
    })
    assert.equal(missing.status, 400)
    const negative = await invoke(route.handler, {
      method: 'GET', headers: LOCAL, url: '/herdr-pane-terminal-wait?pane_id=w1:p1&after_revision=-1',
    })
    assert.equal(negative.status, 400)
  } finally { await dispose() }
})

test('/herdr-pane-terminal-wait: returns the changed revision', async () => {
  const fakeHerdr = makeFakeHerdr()
  let captured: Record<string, unknown> | null = null
  fakeHerdr.paneWaitForOutputChange = async (req: Record<string, unknown>) => {
    captured = req
    return { changed: true, revision: 43 }
  }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-wait')!
    const { status, body } = await invoke(route.handler, {
      method: 'GET', headers: LOCAL,
      url: '/herdr-pane-terminal-wait?pane_id=w1:p1&after_revision=42',
    })
    assert.equal(status, 200)
    assert.equal(body?.changed, true)
    assert.equal(body?.revision, 43)
    assert.deepEqual(captured, { pane_id: 'w1:p1', min_revision: 42, timeout_ms: 25_000 })
  } finally { await dispose() }
})

test('/herdr-pane-terminal-bootstrap: ownership check rejects foreign workspace', async () => {
  const fakeHerdr = makeFakeHerdr()
  fakeHerdr.paneRead = async () => ({ text: '', truncated: false, revision: 1 })
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    const reg = getBindingRegistry()
    reg.set('test-agent', { pane_id: 'w1:p1', created: true, workspace_id: 'w1' })
    try {
      const { status } = await invoke(route.handler, {
        method: 'GET', headers: LOCAL,
        url: '/herdr-pane-terminal-bootstrap?pane_id=w2:p1',
      })
      assert.equal(status, 403)
    } finally { reg.delete('test-agent') }
  } finally { await dispose() }
})

test('/herdr-pane-terminal-bootstrap: allows pane in same workspace', async () => {
  const fakeHerdr = makeFakeHerdr()
  fakeHerdr.paneRead = async () => ({ text: 'output', truncated: false, revision: 1 })
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    const reg = getBindingRegistry()
    reg.set('test-agent', { pane_id: 'w1:p1', created: true, workspace_id: 'w1' })
    try {
      const { status } = await invoke(route.handler, {
        method: 'GET', headers: LOCAL,
        url: '/herdr-pane-terminal-bootstrap?pane_id=w1:p2',
      })
      assert.equal(status, 200)
    } finally { reg.delete('test-agent') }
  } finally { await dispose() }
})

test('/herdr-pane-terminal-bootstrap: lines parameter is clamped', async () => {
  const fakeHerdr = makeFakeHerdr()
  let capturedLines: number | undefined
  fakeHerdr.paneRead = async (req: Record<string, unknown>) => { capturedLines = req.lines as number; return { text: '', truncated: false } }
  const { routes, dispose } = await loadPlugin({ fakeHerdr })
  try {
    const route = routes.find(r => r.path === '/herdr-pane-terminal-bootstrap')!
    // lines=50 → should be clamped to min 100
    await invoke(route.handler, { method: 'GET', headers: LOCAL, url: '/herdr-pane-terminal-bootstrap?pane_id=w1:p1&lines=50' })
    assert.equal(capturedLines, 100, 'lines=50 should be clamped to min 100')
    // lines=100000 → should be clamped to max 50000
    await invoke(route.handler, { method: 'GET', headers: LOCAL, url: '/herdr-pane-terminal-bootstrap?pane_id=w1:p1&lines=100000' })
    assert.equal(capturedLines, 50000, 'lines=100000 should be clamped to max 50000')
  } finally { await dispose() }
})

// 回归：`webServer.register` 是依赖 `this` 的实例方法。若插件以未绑定引用传入
// registerTerminalSessionRoutes，调用时 this 为 undefined → 抛错 → 下方核心路由（/herdr-status 等）
// 全不注册 → SPA fallback 对所有 herdr 端点返回 HTML（用户报告 "Unexpected token '<'"）。
// 用真实方法语义的 fake 复现并锁定修复：核心路由与 terminal 路由都必须注册。
test('regression: terminal routes must not break core routes with this-dependent webServer.register', async () => {
  const ctx = new Context()
  const registered: string[] = []
  class FakeWebServer {
    private exact = new Set<string>()
    register(r: { kind: string; path: string }) {
      // 与真实 WebServer.register 相同的 this 依赖；裸传会抛 "duplicate"/this 未定义
      if (this.exact.has(r.path)) throw new Error(`duplicate route "${r.path}"`)
      this.exact.add(r.path)
      return () => { this.exact.delete(r.path) }
    }
  }
  const fakeWs = new FakeWebServer()
  ctx.provide('webServer', fakeWs)
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('jobs', { start: () => 'herdr-1' })
  const clientFiber = await ctx.plugin({ name: 'dsh-plugin-herdr-client', apply: applyClient, inject: [] }, CONFIG)
  const fiber = await ctx.plugin({ name: 'dsh-plugin-herdr', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)
  try {
    // 从 fake 内部收集到已注册 path：不直接读取私有，改为统计 FakeWebServer.register 调用
    const snapshot = fakeWs['exact'] // 注：真实用例中只要不抛错即通过；此处兜底
    assert.ok(snapshot instanceof Set && snapshot.size >= 6, `expected many routes, got ${snapshot.size}`)
    const paths = [...snapshot]
    assert.ok(paths.includes('/herdr-status'), 'core /herdr-status must register')
    assert.ok(paths.some(p => p.startsWith('/herdr-terminal-session/')), 'terminal routes must register')
    assert.ok(paths.includes('/herdr-dashboard'), '/herdr-dashboard must register')
  } finally { await fiber.dispose(); await clientFiber.dispose() }
})
