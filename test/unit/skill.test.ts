import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { registerHerdrSkill, skillDescription } from '../../src/skill.ts'
import { HERDR_SKILL_MD } from '../../src/herdr-skill.ts'

test('skillDescription parses frontmatter description', () => {
  const desc = skillDescription(HERDR_SKILL_MD)
  assert.ok(desc.includes('Herdr'), desc)
  assert.ok(desc.length > 40, 'description should be the full frontmatter text')
})

test('registerHerdrSkill registers herdr skill with embedded content', async () => {
  const ctx = new Context()
  const registered: Array<{ name: string; description: string; content: string; source?: string }> = []
  ctx.provide('skills', {
    register: (s: { name: string; description: string; content: string; source?: string }) => {
      registered.push(s)
      return () => {}
    },
  })
  const cleanup = registerHerdrSkill(ctx)
  // ctx.inject 是异步等待：等 skills 服务注入回调执行
  await new Promise(res => setTimeout(res, 100))
  assert.equal(registered.length, 1, 'skill should be registered')
  assert.equal(registered[0].name, 'herdr')
  assert.equal(registered[0].source, 'runtime', 'source is required by SkillRegistration')
  assert.ok(registered[0].content.startsWith('---'), 'content should be the SKILL.md body')
  assert.ok(registered[0].content.includes('## Learn the current CLI'))
  assert.ok(registered[0].description.includes('Herdr'))
  cleanup()
  // 清理后再注册一次应无残留（off 幂等）
  await new Promise(res => setTimeout(res, 30))
  assert.equal(registered.length, 1, 'cleanup should not re-register')
})

test('skill content matches the official v0.8.0 file', () => {
  assert.ok(HERDR_SKILL_MD.includes('HERDR_ENV'), 'skill should mention HERDR_ENV guard')
  assert.ok(HERDR_SKILL_MD.includes('herdr --help'), 'skill should teach CLI discovery')
  assert.ok(HERDR_SKILL_MD.includes('## What Herdr is') === false, 'v0.8.0 skill differs from agent guide')
})
