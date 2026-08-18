// pane-terminal-contract.test.ts：xterm.js 终端组件渲染安全契约（纯 Node，无 jsdom）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(root, 'src', 'web', 'pane-terminal.tsx'), 'utf8')

test('pane-terminal.tsx: no dangerouslySetInnerHTML', () => {
  assert.doesNotMatch(source, /=\s*\{[^}]*dangerouslySetInnerHTML/, 'must not use dangerouslySetInnerHTML')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML:\s*\{/, 'must not use dangerouslySetInnerHTML as object key')
})

test('pane-terminal.tsx: no innerHTML assignment', () => {
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'must not assign innerHTML')
})

test('pane-terminal.tsx: has role=log for accessibility', () => {
  assert.match(source, /role="log"/, 'log container must have role=log')
})

test('pane-terminal.tsx: uses xterm.js Terminal', () => {
  assert.match(source, /import.*Terminal.*from.*@xterm\/xterm/, 'must import Terminal from @xterm/xterm')
  assert.match(source, /new Terminal/, 'must create Terminal instance')
})

test('pane-terminal.tsx: uses FitAddon', () => {
  assert.match(source, /import.*FitAddon.*from.*@xterm\/addon-fit/, 'must import FitAddon')
  assert.match(source, /new FitAddon/, 'must create FitAddon instance')
  assert.match(source, /fitAddon\.fit/, 'must call fit()')
})

test('pane-terminal.tsx: has maximize aria-label', () => {
  assert.match(source, /maximized/, 'must support maximized prop')
})

test('pane-terminal.tsx: does not steal Escape from the terminal', () => {
  assert.doesNotMatch(source, /window\.addEventListener\(['"]keydown['"]/, 'must not install a global keydown handler')
  assert.doesNotMatch(source, /onExitMaximize/, 'maximize exit belongs to the explicit toolbar button')
})

test('pane-terminal.tsx: uses xterm onData for input', () => {
  assert.match(source, /terminal\.onData/, 'must use terminal.onData for input')
  assert.match(source, /sendPaneInput/, 'must call sendPaneInput from onData')
})

test('pane-terminal.tsx: targets a stable pane id and surfaces input failures', () => {
  assert.match(source, /paneId:\s*string/, 'must accept pane id independently from agent detection')
  assert.match(source, /setInputError/, 'must surface pane input failures')
  assert.doesNotMatch(source, /agent\?\.pane_id/, 'input must not depend on optional agent state')
})

test('pane-terminal.tsx: waits for output revisions instead of interval polling', () => {
  assert.match(source, /waitForTerminalChange/, 'must use the event-driven terminal wait endpoint')
  assert.doesNotMatch(source, /setInterval/, 'must not poll terminal output on a fixed interval')
})

test('pane-terminal.tsx: handles resize with FitAddon', () => {
  assert.match(source, /ResizeObserver/, 'must observe container resize')
})

test('pane-terminal.tsx: cleans up terminal on unmount', () => {
  assert.match(source, /terminal\.dispose/, 'must dispose terminal on cleanup')
})
