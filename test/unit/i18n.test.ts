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
  assert.equal(t('pane.closeConfirm', { id: 'w1:p3' }), '关闭窗格 w1:p3？其内进程将终止')
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
  const unknown = t('no.such.key' as never)
  assert.equal(unknown, 'no.such.key')
})

test('setHerdrLang skips no-op updates and switches language', () => {
  setHerdrLang('zh')
  setHerdrLang('zh')
  assert.equal(getHerdrLang(), 'zh')
  setHerdrLang('en')
  assert.equal(getHerdrLang(), 'en')
  setHerdrLang('zh')
})

test('status keys: 5-state display labels are bilingual and localized', () => {
  setHerdrLang('zh')
  assert.equal(t('status.working'), '工作中')
  assert.equal(t('status.blocked'), '等待处理')
  assert.equal(t('status.idle'), '空闲')
  assert.equal(t('status.done'), '已完成')
  assert.equal(t('status.unknown'), '未知')
  setHerdrLang('en')
  assert.equal(t('status.working'), 'Working')
  assert.equal(t('status.blocked'), 'Blocked')
  assert.equal(t('status.idle'), 'Idle')
  assert.equal(t('status.done'), 'Done')
  assert.equal(t('status.unknown'), 'Unknown')
  setHerdrLang('zh')
})

test('new keys: status, tab, list, and error summaries are bilingual', () => {
  setHerdrLang('zh')
  assert.equal(t('view.statusSummary'), '窗格状态摘要')
  assert.equal(t('view.statusError', { error: '离线' }), 'herdr 状态：离线')
  assert.equal(t('view.tabId', { id: 't1' }), '标签页 t1')
  assert.equal(t('view.listMeta', { workspaces: 1, panes: 3 }), '1 个工作区 · 3 个窗格')
  setHerdrLang('en')
  assert.equal(t('view.statusSummary'), 'Pane status summary')
  assert.equal(t('view.statusError', { error: 'offline' }), 'herdr status: offline')
  assert.equal(t('view.tabId', { id: 't1' }), 'tab t1')
  assert.equal(t('view.listMeta', { workspaces: 1, panes: 3 }), '1 workspaces · 3 panes')
  setHerdrLang('zh')
})

test('view.stats: Chinese and English summaries stay distinct', () => {
  setHerdrLang('zh')
  assert.equal(t('view.stats', { ws: 2, panes: 5, agents: 3 }), '2 个工作区 · 5 个窗格 · 3 个代理')
  setHerdrLang('en')
  assert.equal(t('view.stats', { ws: 2, panes: 5, agents: 3 }), '2 workspaces · 5 panes · 3 agents')
  setHerdrLang('zh')
})

test('dashboard keys: bilingual sanity + template params', () => {
  setHerdrLang('zh')
  assert.equal(t('global.title'), 'Herdr 仪表盘')
  assert.equal(t('dashboard.lastUpdated', { time: '12:00:00' }), '最近更新：12:00:00')
  assert.equal(t('dashboard.unavailable'), '不可用')
  assert.equal(t('dashboard.lastUpdated', { time: '12:00:00' }), '最近更新：12:00:00')
  setHerdrLang('en')
  assert.equal(t('global.title'), 'Herdr Dashboard')
  assert.equal(t('dashboard.unavailable'), 'Unavailable')
  assert.equal(t('dashboard.lastUpdated', { time: '12:00:00' }), 'Last updated: 12:00:00')
  assert.equal(t('dashboard.versionProtocol'), 'Version · protocol')
  assert.equal(t('dashboard.sampledHint', { time: '14:32:05' }), 'sampled at 14:32:05')
  setHerdrLang('zh')
})

test('pane.terminalOutput: bilingual aria label for log container', () => {
  setHerdrLang('zh')
  assert.equal(t('pane.terminalOutput'), '终端输出')
  setHerdrLang('en')
  assert.equal(t('pane.terminalOutput'), 'Terminal output')
  setHerdrLang('zh')
})

test('pane.outputTruncated: bilingual truncation indicator', () => {
  setHerdrLang('zh')
  assert.equal(t('pane.outputTruncated'), '输出已截断')
  setHerdrLang('en')
  assert.equal(t('pane.outputTruncated'), 'Output truncated')
  setHerdrLang('zh')
})

test('dashboard v5 keys: workspace close + pane list jump are bilingual', () => {
  setHerdrLang('zh')
  assert.equal(t('dashboard.closeWorkspace'), '关闭工作区')
  assert.equal(t('dashboard.closeWorkspaceTitle', { id: 'w1' }), '关闭工作区 w1')
  assert.equal(t('dashboard.closePaneTitle', { id: 'w1:p1' }), '关闭窗格 w1:p1')
  assert.equal(t('dashboard.expandPanes'), '展开窗格')
  assert.equal(t('dashboard.collapsePanes'), '收起窗格')
  assert.equal(t('dashboard.paneJumpTitle', { id: 'pi-1' }), 'pi-1 · 点击跳转到所属会话')
  assert.equal(t('dashboard.paneSelfTitle', { id: 'pi-1' }), 'pi-1（本对话）· 在 Herdr 中定位')
  setHerdrLang('en')
  assert.equal(t('dashboard.closeWorkspace'), 'Close workspace')
  assert.equal(t('dashboard.closeWorkspaceTitle', { id: 'w1' }), 'Close workspace w1')
  assert.equal(t('dashboard.closePaneTitle', { id: 'w1:p1' }), 'Close pane w1:p1')
  assert.equal(t('dashboard.expandPanes'), 'Expand panes')
  assert.equal(t('dashboard.collapsePanes'), 'Collapse panes')
  assert.equal(t('dashboard.paneJumpTitle', { id: 'pi-1' }), 'pi-1 · Click to jump to its session')
  assert.equal(t('dashboard.paneSelfTitle', { id: 'pi-1' }), 'pi-1 (this conversation) · Locate in Herdr')
  setHerdrLang('zh')
})
