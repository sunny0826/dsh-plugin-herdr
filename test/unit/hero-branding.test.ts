// CA-016：herdr 新会话品牌化常量一致性（design: herdr-hero-branding §7）。
// 视觉层（DOM 打标 / CSS 渲染）依赖真实 shell DOM 结构，node:test 无 DOM → 人工验收；
// 逻辑层以常量漂移哨兵覆盖：文案常量与需求原文、分段拼接与全文、品牌紫 token 取值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HERDR_BRAND_DARK,
  HERDR_BRAND_GLOW_DARK,
  HERDR_BRAND_GLOW_LIGHT,
  HERDR_BRAND_LIGHT,
  HERDR_HERO_TEXT,
  HERDR_HERO_TEXT_BRAND,
  HERDR_HERO_TEXT_PLAIN,
} from '../../src/web/hero-branding.ts'

test('hero branding: 文案常量与需求原文一致（漂移哨兵）', () => {
  assert.equal(HERDR_HERO_TEXT, 'Herdr 助你探索未知之境')
  assert.equal(HERDR_HERO_TEXT_BRAND, 'Herdr 助你')
  assert.equal(HERDR_HERO_TEXT_PLAIN, '探索未知之境')
})

test('hero branding: 分段拼接 == 全文（aria-label 与视觉文案不漂移）', () => {
  assert.equal(HERDR_HERO_TEXT_BRAND + HERDR_HERO_TEXT_PLAIN, HERDR_HERO_TEXT)
})

test('hero branding: 品牌紫 token 随主题（design §4.1，herdr.dev 官网 --spot 实测）', () => {
  assert.equal(HERDR_BRAND_LIGHT, '#8839ef') // paper 模式
  assert.equal(HERDR_BRAND_DARK, '#cba6f7') // ink 模式
  // 深色主题用浅紫保证对比度：两值必须不同且均为合法 hex
  assert.notEqual(HERDR_BRAND_LIGHT, HERDR_BRAND_DARK)
  for (const v of [HERDR_BRAND_LIGHT, HERDR_BRAND_DARK]) {
    assert.match(v, /^#[0-9a-f]{6}$/)
  }
  // 辉光随主题（rgba 形式）
  assert.match(HERDR_BRAND_GLOW_LIGHT, /^rgba\(136, 57, 239, 0\.28\)$/)
  assert.match(HERDR_BRAND_GLOW_DARK, /^rgba\(203, 166, 247, 0\.25\)$/)
})
