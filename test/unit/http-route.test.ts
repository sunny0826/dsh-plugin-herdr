// CA-007：控制面路由级验证 —— 加载插件（src）注册 3 条路由，用伪造 req/res 验证
// 方法/来源边界（未授权不可启动进程、不可读终端输出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.ts'
import { apply as applyClient } from '../../src/client-entry.ts'
import { getBindingRegistry } from '../../src/binding-registry.ts'
import type { Config as ConfigType } from '../../src/config.ts'

const CONFIG: ConfigType = {
  cliPath: 'herdr',
  transport: 'cli',
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
      workspaces: [{ workspace_id: 'w1', label: 'demo', pane_count: 2 }],
      agents: [],
      panes: [
        { pane_id: 'w1:p1', workspace_id: 'w1' },
        { pane_id: 'w1:p2', workspace_id: 'w1' },
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
