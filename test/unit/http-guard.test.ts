// CA-007：HTTP 控制面守卫单测（可信本地上下文 + 严格方法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardLocalRequest, hostnameOfHost, requireMethod } from '../../src/http-guard.ts'

const localReq = (headers: Record<string, string | undefined>) => ({ method: 'GET', headers })

test('hostnameOfHost strips ports and IPv6 brackets', () => {
  assert.equal(hostnameOfHost('localhost:1234'), 'localhost')
  assert.equal(hostnameOfHost('127.0.0.1:8080'), '127.0.0.1')
  assert.equal(hostnameOfHost('[::1]:3000'), '::1')
  assert.equal(hostnameOfHost('::1'), '::1')
  assert.equal(hostnameOfHost(undefined), undefined)
})

test('guard: missing Host -> 400', () => {
  const g = guardLocalRequest(localReq({}))
  assert.equal(g.ok, false)
  assert.equal(g.status, 400)
})

test('guard: non-local Host -> 403 (DNS rebinding defense)', () => {
  const g = guardLocalRequest(localReq({ host: 'evil.example.com' }))
  assert.equal(g.ok, false)
  assert.equal(g.status, 403)
})

test('guard: cross-origin Origin -> 403 (CSRF defense)', () => {
  const g = guardLocalRequest(localReq({ host: 'localhost:1234', origin: 'http://evil.example.com' }))
  assert.equal(g.ok, false)
  assert.equal(g.status, 403)
})

test('guard: malformed Origin -> 400', () => {
  const g = guardLocalRequest(localReq({ host: 'localhost:1234', origin: 'not a url' }))
  assert.equal(g.ok, false)
  assert.equal(g.status, 400)
})

test('guard: Sec-Fetch-Site cross-site -> 403 (covers no-Origin <img> GET)', () => {
  const g = guardLocalRequest(localReq({ host: 'localhost:1234', 'sec-fetch-site': 'cross-site' }))
  assert.equal(g.ok, false)
  assert.equal(g.status, 403)
})

test('guard: local Host with matching Origin -> ok', () => {
  const g = guardLocalRequest(localReq({ host: 'localhost:1234', origin: 'http://localhost:1234' }))
  assert.equal(g.ok, true)
})

test('guard: local Host without Origin (curl / same-origin GET) -> ok', () => {
  for (const host of ['localhost:1234', '127.0.0.1', '[::1]:3000']) {
    const g = guardLocalRequest(localReq({ host }))
    assert.equal(g.ok, true, `host ${host} should be trusted`)
  }
})

test('requireMethod: mismatch -> 405 with message', () => {
  const g = requireMethod({ method: 'POST' }, 'GET')
  assert.equal(g.ok, false)
  assert.equal(g.status, 405)
  assert.match(g.message, /POST not allowed/)
})

test('requireMethod: match passes; missing method defaults to GET', () => {
  assert.equal(requireMethod({ method: 'GET' }, 'GET').ok, true)
  assert.equal(requireMethod({ method: 'post' }, 'POST').ok, true, 'case-insensitive')
  assert.equal(requireMethod({}, 'GET').ok, true, 'no method defaults GET')
})
