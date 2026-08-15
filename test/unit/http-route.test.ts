// CA-007：控制面路由级验证 —— 加载插件（src）注册 3 条路由，用伪造 req/res 验证
// 方法/来源边界（未授权不可启动进程、不可读终端输出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index.ts'
import { apply as applyClient } from '../../src/client-entry.ts'
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

async function loadPlugin(): Promise<{ routes: Route[]; dispose(): Promise<void> }> {
  const ctx = new Context()
  const routes: Route[] = []
  ctx.provide('webServer', { register: (r: Route) => { routes.push(r); return () => {} } })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('jobs', { start: () => 'herdr-1' })
  const clientFiber = await ctx.plugin({ name: 'dsh-plugin-herdr-client', apply: applyClient, inject: [] }, CONFIG)
  const fiber = await ctx.plugin({ name: 'dsh-plugin-herdr', apply, inject: ['tools', 'herdr', 'jobs'] }, CONFIG)
  return {
    routes,
    dispose: async () => { await fiber.dispose(); await clientFiber.dispose() },
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
