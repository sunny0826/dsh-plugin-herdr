import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { HERDR_SKILL_MD } from './herdr-skill.ts'

/** 从 SKILL.md frontmatter 提取描述（runtime skill 注册需要）。 */
export function skillDescription(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return 'Control Herdr, a terminal multiplexer for coding agents.'
  const desc = m[1].match(/^description:\s*["']?([^"\n']+)["']?/m)
  return (desc?.[1] ?? 'Control Herdr, a terminal multiplexer for coding agents.').trim()
}

/**
 * 注册 Herdr skill 到会话 skill 目录（DESIGN.md §19）。
 * 启用插件即给当前及后续会话加载官方 SKILL.md（v0.8.0 内嵌快照）。
 * 通过 ctx.inject(['skills']) 等待 registry；headless 无 skills 服务时跳过。
 */
export function registerHerdrSkill(ctx: Context): () => void {
  let off: (() => void) | null = null
  ctx.inject(['skills'], injected => {
    const skills = (injected as unknown as { skills: { register(s: SkillRegistration): () => void } }).skills
    off = skills.register({
      name: 'herdr',
      description: skillDescription(HERDR_SKILL_MD),
      content: HERDR_SKILL_MD,
      // SkillRegistration 必填：来源桶（prompt 可见元数据）与提供者
      source: 'runtime',
      provider: 'runtime',
    })
    console.log('[dsh-plugin-herdr] skill "herdr" registered (v0.8.0 SKILL.md embedded)')
  })
  return () => {
    off?.()
  }
}
