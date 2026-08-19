import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeTerminalFontFamily } from '../../src/web/terminal-font.ts'

test('composeTerminalFontFamily: keeps a resolved CSS font stack for xterm canvas', () => {
  assert.equal(
    composeTerminalFontFamily('ui-monospace, SFMono-Regular'),
    'ui-monospace, SFMono-Regular, "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "MesloLGM Nerd Font", "Hack Nerd Font", "CaskaydiaCove Nerd Font", "Source Code Pro Nerd Font", monospace',
  )
})

test('composeTerminalFontFamily: drops unresolved CSS variables because CanvasRenderingContext2D cannot expand them', () => {
  const font = composeTerminalFontFamily('var(--ds-font-family-code, monospace)')
  assert.ok(!font.includes('var('))
  assert.ok(font.endsWith('monospace'))
})
