import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureHerdrPreset } from '../../src/preset-install.ts'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'herdr-preset-'))
}

test('ensureHerdrPreset: installs preset into $DSH_HOME/.agent-presets/herdr', () => {
  const home = tmpHome()
  try {
    const target = ensureHerdrPreset(home)
    assert.ok(target, 'returns target path')
    assert.ok(target!.endsWith('.agent-presets/herdr'), target!)
    const comp = join(target!, 'agent.cordis.yml')
    const meta = join(target!, 'preset.yml')
    assert.ok(existsSync(comp), 'composition copied')
    assert.ok(existsSync(meta), 'metadata copied')
    const compText = readFileSync(comp, 'utf8')
    assert.ok(compText.includes('dsh-plugin-herdr/session-mode'), 'session-mode row present')
    const metaText = readFileSync(meta, 'utf8')
    assert.ok(metaText.includes('Herdr 模式'), 'display name present')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureHerdrPreset: identical content is not rewritten (idempotent)', () => {
  const home = tmpHome()
  try {
    const first = ensureHerdrPreset(home)
    assert.ok(first)
    const comp = join(first!, 'agent.cordis.yml')
    const before = readFileSync(comp, 'utf8')
    const second = ensureHerdrPreset(home)
    assert.equal(second, first)
    assert.equal(readFileSync(comp, 'utf8'), before, 'identical content untouched')
    // 无备份文件产生
    assert.ok(!readdirSync(first!).some(f => f.includes('.herdr-bak-')), 'no backup for unchanged content')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureHerdrPreset: outdated content is backed up then updated', () => {
  const home = tmpHome()
  try {
    const first = ensureHerdrPreset(home)
    assert.ok(first)
    const comp = join(first!, 'agent.cordis.yml')
    // 模拟旧版本/用户改动：内容与源不同
    writeFileSync(comp, '# stale user composition\n')
    const second = ensureHerdrPreset(home)
    assert.equal(second, first)
    const updated = readFileSync(comp, 'utf8')
    assert.ok(updated.includes('dsh-plugin-herdr/session-mode'), 'updated to plugin content')
    const baks = readdirSync(first!).filter(f => f.includes('.herdr-bak-'))
    assert.equal(baks.length, 1, 'one backup kept')
    assert.ok(readFileSync(join(first!, baks[0]), 'utf8').includes('stale user composition'), 'backup holds the old content')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureHerdrPreset: honors explicit DSH_HOME env default shape', () => {
  const home = tmpHome()
  try {
    const target = ensureHerdrPreset(home)
    assert.ok(target!.startsWith(home), 'installs under given home')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})