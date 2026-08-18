// TerminalSession 协议层纯逻辑（design: pane-terminal-session-state-machine §11.1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NDJSONParser, parseFrame, isClosedEvent } from '../../src/terminal-session/protocol.ts'
import { TerminalSessionError } from '../../src/terminal-session/errors.ts'

const LIMITS = { maxDecodedFrameBytes: 1_048_576 }

function frame(over: Record<string, unknown> = {}) {
  return {
    type: 'terminal.frame',
    seq: 1,
    width: 80,
    height: 24,
    full: true,
    bytes: Buffer.from('hello').toString('base64'),
    ...over,
  }
}

// ---------- NDJSONParser ----------

test('NDJSONParser: splits newline-terminated lines', () => {
  const p = new NDJSONParser(100)
  const lines = p.push(Buffer.from('{"a":1}\n{"b":2}\n'))
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
})

test('NDJSONParser: handles arbitrary chunk boundaries (sticky/partial)', () => {
  const p = new NDJSONParser(100)
  const all = '{"seq":1}\n{"seq":2}\n{"seq":3}\n'
  const chunks: string[] = []
  for (let i = 0; i < all.length; i += 3) chunks.push(all.slice(i, i + 3))
  const out: string[] = []
  for (const c of chunks) out.push(...p.push(Buffer.from(c)))
  assert.deepEqual(out, ['{"seq":1}', '{"seq":2}', '{"seq":3}'])
})

test('NDJSONParser: skips empty/blank lines', () => {
  const p = new NDJSONParser(100)
  const lines = p.push(Buffer.from('\n\n{"a":1}\n \n'))
  assert.deepEqual(lines, ['{"a":1}'])
})

test('NDJSONParser: overlong line sets overflow and is skipped', () => {
  const p = new NDJSONParser(8)
  const lines = p.push(Buffer.from(Buffer.alloc(20, 0x61).toString() + '\n{"ok":1}\n'))
  assert.deepEqual(lines, ['{"ok":1}'])
  assert.equal(p.exceeded(), true)
})

test('NDJSONParser: no overflow for legal line', () => {
  const p = new NDJSONParser(100)
  p.push(Buffer.from('{"x":1}\n'))
  assert.equal(p.exceeded(), false)
})

// ---------- parseFrame ----------

test('parseFrame: accepts a valid full frame', () => {
  const f = parseFrame(frame(), LIMITS)
  assert.equal(f.seq, 1)
  assert.equal(f.width, 80)
  assert.equal(f.height, 24)
  assert.equal(f.full, true)
  assert.equal(f.bytes.toString(), 'hello')
})

test('parseFrame: rejects non-object / arrays', () => {
  assert.throws(() => parseFrame('x', LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame([1], LIMITS), TerminalSessionError)
})

test('parseFrame: rejects wrong event type', () => {
  assert.throws(() => parseFrame(frame({ type: 'terminal.input' }), LIMITS), /意外的事件类型/)
})

test('parseFrame: rejects invalid seq/width/height/full', () => {
  assert.throws(() => parseFrame(frame({ seq: 1.5 }), LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame(frame({ seq: -1 }), LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame(frame({ width: 0 }), LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame(frame({ height: -3 }), LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame(frame({ full: 'yes' }), LIMITS), TerminalSessionError)
})

test('parseFrame: rejects missing / non-canonical / oversized base64 bytes', () => {
  assert.throws(() => parseFrame(frame({ bytes: '' }), LIMITS), TerminalSessionError)
  assert.throws(() => parseFrame(frame({ bytes: '!!!not-base64!!!' }), LIMITS), TerminalSessionError)
  // oversized decoded
  const big = Buffer.alloc(2_000_000).toString('base64')
  assert.throws(() => parseFrame(frame({ bytes: big }), { maxDecodedFrameBytes: 1_000 }), /frame 超限/)
})

test('parseFrame: base64 decode is byte-exact', () => {
  const raw = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff])
  const b64 = raw.toString('base64')
  const f = parseFrame(frame({ bytes: b64 }), LIMITS)
  assert.deepEqual(f.bytes, raw)
})

// ---------- isClosedEvent ----------

test('isClosedEvent: recognizes terminal.closed only', () => {
  assert.equal(isClosedEvent({ type: 'terminal.closed', reason: 'detached' }), true)
  assert.equal(isClosedEvent({ type: 'terminal.frame' }), false)
  assert.equal(isClosedEvent(null), false)
  assert.equal(isClosedEvent('x'), false)
})

test('NDJSONParser: unterminated line beyond cap sets overflow (no newline) (#6)', () => {
  const p = new NDJSONParser(8)
  p.push(Buffer.alloc(5, 0x61)) // no newline, under cap
  assert.equal(p.exceeded(), false)
  p.push(Buffer.alloc(10, 0x62)) // retained partial now > 8, still no newline
  assert.equal(p.exceeded(), true, 'overflow must trip even without a newline')
})
