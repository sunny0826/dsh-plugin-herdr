import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfPaneStore } from '../../src/web/self-pane-store.ts'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('selfPaneStore: hit stops scheduling and resets backoff', async () => {
  let calls = 0
  const fetcher = async (sid: string) => {
    calls++
    return `pane-${sid}`
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-a', baseDelayMs: 10, sessionPollMs: 20 })
  let notified = 0
  const unsub = store.subscribe('sess-a', () => { notified++ })
  assert.equal(store.get('sess-a'), undefined)
  await sleep(30)
  assert.equal(calls, 1)
  assert.equal(store.get('sess-a'), 'pane-sess-a')
  assert.equal(store.getBackoff('sess-a'), 10)
  assert.equal(store.getMisses('sess-a'), 0)
  const n1 = notified
  await sleep(40)
  assert.equal(calls, 1, 'no reschedule after hit')
  assert.equal(notified, n1, 'no extra notify after hit')
  unsub()
  store.stop()
})

test('selfPaneStore: miss exponential backoff 1s→2s→4s→8s→30s cap', async () => {
  const calls: number[] = []
  const fetcher = async () => {
    calls.push(Date.now())
    return null
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-b', baseDelayMs: 10, sessionPollMs: 50 })
  // use baseDelay 10, so sequence 10->20->40->80->160->320 but cap is 30000; we test doubling
  const unsub = store.subscribe('sess-b', () => {})
  await sleep(15)
  assert.equal(calls.length, 1, 'first fetch at ~10ms')
  assert.equal(store.get('sess-b'), null)
  assert.equal(store.getMisses('sess-b'), 1)
  assert.equal(store.getBackoff('sess-b'), 20)
  await sleep(25)
  assert.equal(calls.length, 2, 'second fetch at 20ms')
  assert.equal(store.getMisses('sess-b'), 2)
  assert.equal(store.getBackoff('sess-b'), 40)
  await sleep(45)
  assert.equal(calls.length, 3, 'third fetch at 40ms')
  assert.equal(store.getBackoff('sess-b'), 80)
  assert.equal(store.getMisses('sess-b'), 3)
  // paneMisses>=3 threshold corresponds to backoff >=40 (with base 10) — in prod base 1000 => 4000
  // ensure miss count visible for pane-list empty logic
  assert.ok(store.getMisses('sess-b') >= 3)
  unsub()
  store.stop()
  // test cap: rapid misses double until cap
  // simulate many misses with direct fetch that keeps returning null and check cap via successive sleeps
  const fastStore = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-cap', baseDelayMs: 8000, sessionPollMs: 50 })
  // base 8000 -> next 16000 -> next 30000 cap
  const unsub2 = fastStore.subscribe('sess-cap', () => {})
  await sleep(10)
  assert.equal(fastStore.getBackoff('sess-cap'), 8000, 'initial backoff')
  await sleep(8500)
  assert.equal(fastStore.getBackoff('sess-cap'), 16000)
  await sleep(16500)
  assert.equal(fastStore.getBackoff('sess-cap'), 30000, 'cap at 30s')
  await sleep(31000)
  assert.equal(fastStore.getBackoff('sess-cap'), 30000, 'stays capped')
  unsub2()
  fastStore.stop()
})

test('selfPaneStore: dedup single-flight even with multiple subscribers', async () => {
  let calls = 0
  let resolveFetch: ((v: string | null) => void) | null = null
  const fetcher = async () => {
    calls++
    return new Promise<string | null>(res => { resolveFetch = res })
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-c', baseDelayMs: 5, sessionPollMs: 50 })
  const unsub1 = store.subscribe('sess-c', () => {})
  const unsub2 = store.subscribe('sess-c', () => {})
  await sleep(10)
  assert.equal(calls, 1, 'single fetch despite two subscribers')
  // fetch still inflight, second scheduleFetch should be skipped
  resolveFetch!('pane-1')
  await sleep(10)
  assert.equal(store.get('sess-c'), 'pane-1')
  assert.equal(calls, 1)
  unsub1()
  unsub2()
  store.stop()
})

test('selfPaneStore: session switch triggers fetch for new session', async () => {
  let current = 'sess-old'
  const getSid = () => current
  const fetched: string[] = []
  const fetcher = async (sid: string) => {
    fetched.push(sid)
    return `pane-${sid}`
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: getSid, baseDelayMs: 5, sessionPollMs: 10 })
  const unsub = store.subscribe('sess-old', () => {})
  await sleep(15)
  assert.equal(store.get('sess-old'), 'pane-sess-old')
  assert.ok(fetched.includes('sess-old'))
  // need a global session listener to detect switch; store's session polling requires at least one sessionListener or pane listener
  let sessionNotified = 0
  const unsubSession = store.subscribeSession(() => { sessionNotified++ })
  current = 'sess-new'
  await sleep(25)
  assert.ok(sessionNotified >= 1, 'session change notified')
  // new session fetch is scheduled automatically via session polling, but we also need subscribe to new session to observe
  const unsubNew = store.subscribe('sess-new', () => {})
  await sleep(15)
  assert.equal(store.get('sess-new'), 'pane-sess-new')
  assert.ok(fetched.includes('sess-new'))
  unsub()
  unsubSession()
  unsubNew()
  store.stop()
})

test('selfPaneStore: refresh forces refetch and invalidate clears', async () => {
  let calls = 0
  const fetcher = async (sid: string) => {
    calls++
    if (calls === 1) return 'pane-1'
    return 'pane-2'
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-d', baseDelayMs: 5, sessionPollMs: 50 })
  const unsub = store.subscribe('sess-d', () => {})
  await sleep(15)
  assert.equal(store.get('sess-d'), 'pane-1')
  assert.equal(calls, 1)
  store.refresh('sess-d')
  assert.equal(store.get('sess-d'), undefined, 'refresh clears value')
  await sleep(15)
  assert.equal(store.get('sess-d'), 'pane-2')
  assert.equal(calls, 2)
  store.invalidate('sess-d')
  assert.equal(store.get('sess-d'), undefined)
  // after invalidate, fetching restarts because it's current session
  await sleep(15)
  assert.ok(store.get('sess-d') !== undefined)
  unsub()
  store.stop()
})

test('selfPaneStore: hit after misses resets miss count and backoff', async () => {
  let attempt = 0
  const fetcher = async () => {
    attempt++
    if (attempt <= 2) return null
    return 'pane-hit'
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-e', baseDelayMs: 5, sessionPollMs: 50 })
  const unsub = store.subscribe('sess-e', () => {})
  await sleep(10)
  assert.equal(store.getMisses('sess-e'), 1)
  await sleep(10)
  assert.equal(store.getMisses('sess-e'), 2)
  await sleep(25)
  assert.equal(store.get('sess-e'), 'pane-hit')
  assert.equal(store.getMisses('sess-e'), 0)
  assert.equal(store.getBackoff('sess-e'), 5)
  unsub()
  store.stop()
})

test('selfPaneStore: stop clears timers, _reset clears state', async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    return null
  }
  const store = createSelfPaneStore({ fetchFn: fetcher, getSessionIdFn: () => 'sess-f', baseDelayMs: 10, sessionPollMs: 50 })
  const unsub = store.subscribe('sess-f', () => {})
  await sleep(15)
  assert.equal(calls, 1)
  store.stop()
  const before = calls
  await sleep(30)
  assert.equal(calls, before, 'no fetch after stop')
  store._reset()
  assert.equal(store.get('sess-f'), undefined)
  assert.equal(store.getMisses('sess-f'), 0)
  unsub()
})
