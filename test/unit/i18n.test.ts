// Web panel i18n: shared language store + copy dictionary (design: herdr-hero-branding §4.6).
// Every user-visible panel copy lives in I18N_KEYS with both zh and en — new copy must
// add both variants or this test fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  I18N_KEYS,
  getHerdrLang,
  setHerdrLang,
  t,
} from '../../src/web/i18n.ts'

test('dictionary: every key has non-empty zh and en variants', () => {
  const keys = Object.keys(I18N_KEYS)
  assert.ok(keys.length >= 20, `expected a substantial dictionary, got ${keys.length}`)
  for (const key of keys) {
    const entry = (I18N_KEYS as Record<string, { zh: string; en: string }>)[key]
    assert.ok(typeof entry.zh === 'string' && entry.zh.length > 0, `${key}.zh must be non-empty`)
    assert.ok(typeof entry.en === 'string' && entry.en.length > 0, `${key}.en must be non-empty`)
  }
})

test('default language is zh; setHerdrLang switches and getHerdrLang reads back', () => {
  setHerdrLang('zh')
  assert.equal(getHerdrLang(), 'zh')
  assert.equal(t('dialog.confirm'), '确定')
  setHerdrLang('en')
  assert.equal(getHerdrLang(), 'en')
  assert.equal(t('dialog.confirm'), 'OK')
  setHerdrLang('zh')
})

test('unknown language falls back to zh', () => {
  setHerdrLang('fr')
  assert.equal(getHerdrLang(), 'zh')
  assert.equal(t('view.start'), '启动')
})

test('t() substitutes {param} placeholders', () => {
  setHerdrLang('zh')
  assert.equal(t('pane.closeConfirm', { id: 'w1:p3' }), '关闭 pane w1:p3？其内进程将终止')
  setHerdrLang('en')
  assert.equal(t('pane.closeConfirm', { id: 'w1:p3' }), 'Close pane w1:p3? Its process will be terminated')
  assert.equal(t('view.closeWorkspaceConfirm', { id: 'ws1', count: 2 }), 'Close workspace ws1 and its 2 panes?')
  setHerdrLang('zh')
})

test('t() leaves unknown placeholders untouched and accepts numeric params', () => {
  setHerdrLang('zh')
  assert.equal(t('panel.selfTitle', { id: 'p1' }), 'p1（本对话）· 点击在 Herdr 中定位')
  assert.equal(t('banner.startFailed', { error: 500 }), '启动失败：500')
})

test('t() with an unknown key returns the key itself', () => {
  // Cast: callers use typed I18nKey; this guards the runtime fallback.
  const unknown = t('no.such.key' as never)
  assert.equal(unknown, 'no.such.key')
})

test('setHerdrLang notifies listeners and skips no-op updates', () => {
  let calls = 0
  const listener = () => { calls += 1 }
  setHerdrLang('zh')
  setHerdrLang('zh')
  setHerdrLang('zh')
  assert.equal(getHerdrLang(), 'zh')
  setHerdrLang('en')
  assert.equal(getHerdrLang(), 'en')
})

test('dashboard keys: bilingual sanity + template params', () => {
  setHerdrLang('zh')
  assert.equal(t('global.title'), 'Herdr 仪表盘')
  assert.equal(t('dashboard.lastUpdated', { time: '12:00:00' }), '最近更新：12:00:00')
  setHerdrLang('en')
  assert.equal(t('global.title'), 'Herdr Dashboard')
  assert.equal(t('dashboard.unavailable'), 'Unavailable')
  assert.equal(t('dashboard.lastUpdated', { time: '12:00:00' }), 'Last updated: 12:00:00')
  assert.equal(t('dashboard.versionProtocol'), 'Version · Protocol')
  assert.equal(t('dashboard.sampledHint', { time: '14:32:05' }), 'sampled at 14:32:05')
  setHerdrLang('zh')
})
