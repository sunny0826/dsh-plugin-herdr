// hero 标题打标（design: herdr-hero-branding §4.3）。
// HeroShell 的 headline 无稳定 data-* 属性（CSS module hash class 无法被插件 CSS 选中），
// 由 MutationObserver 幂等打上 herdr-hero-* class（仿 tab-controller 的「DOM 打标 + CSS」方案）：
// - herdr-hero-fish：fish 座位 span（内含 FishLogo svg）——::before 以 mask 渲染 herdr logo；
// - herdr-hero-text：标题文本 span——::before/::after 分段输出新文案；
// - herdr-hero-headline：标题容器——设置 aria-label（a11y）。
// 定位锚点：svg[viewBox="0 0 23.16 17.04"]（FishLogo 的固定 viewBox，跨主题不变）。
// React 重渲染会重写 className 抹掉标记 → attribute 观察重新打标（rAF 防抖，闪窗 ~1 帧可接受）。

/** 品牌化全文（headline 容器 aria-label；与 styles.ts 的 CSS content 同源，勿直接改文案）。 */
export const HERDR_HERO_TEXT = 'Herdr 助你探索未至之境'
/** 品牌特效段（styles.ts ::before content 引用）。 */
export const HERDR_HERO_TEXT_BRAND = 'Herdr 助你'
/** 原样式段（styles.ts ::after content 引用）。 */
export const HERDR_HERO_TEXT_PLAIN = '探索未至之境'

/** 英文文案（styles.ts ::before/::after content 引用；对应「Herdr 助你探索未知之境」）。 */
export const HERDR_HERO_TEXT_EN = 'Herdr helps you explore the unknown'
/** 英文品牌特效段。 */
export const HERDR_HERO_TEXT_BRAND_EN = 'Herdr helps you'
/** 英文原样式段（前缀空格：两段由独立伪元素渲染，拼接需显式空格；中文无此问题）。 */
export const HERDR_HERO_TEXT_PLAIN_EN = ' explore the unknown'

/** herdr preset 显示名（preset.yml 的 name 是单字符串、DSH 无自定义 preset i18n；
 *  hero 页 preset 芯片在英文界面由本模块 DOM 替换为英文，其余 surface 保持原样）。 */
export const HERDR_PRESET_NAME_ZH = 'Herdr 模式'
export const HERDR_PRESET_NAME_EN = 'Herdr mode'

/** herdr preset 介绍（description；同 name 的单字符串限制，全局文本替换补偿，
 *  覆盖 hero 页 preset 菜单与设置页的 description 展示）。 */
export const HERDR_PRESET_DESC_ZH =
  '会话绑定 Herdr——本对话视为运行在 Herdr 中的 Agent，状态实时显示在 Herdr 侧边栏，优先使用 herdr 工具操作 workspace / pane / agent。'
export const HERDR_PRESET_DESC_EN =
  'Binds the session to Herdr: the conversation runs as an Agent inside Herdr, its status shows live in the Herdr sidebar, and herdr tools operate workspace / pane / agent.'

/** 品牌紫 token（styles.ts CSS 变量引用；取值 = herdr.dev 官网 site.css 的 --spot 实测，design §4.1）。 */
export const HERDR_BRAND_LIGHT = '#8839ef' // herdr.dev paper 模式
export const HERDR_BRAND_DARK = '#cba6f7' // herdr.dev ink 模式
export const HERDR_BRAND_GLOW_LIGHT = 'rgba(136, 57, 239, 0.28)'
export const HERDR_BRAND_GLOW_DARK = 'rgba(203, 166, 247, 0.25)'

const FISH_VIEWBOX = '0 0 23.16 17.04'
const FISH_CLASS = 'herdr-hero-fish'
const TEXT_CLASS = 'herdr-hero-text'
const HEADLINE_CLASS = 'herdr-hero-headline'
const LANG_ATTR = 'data-herdr-lang'

// 语言状态单一事实源在 i18n.ts（locale 服务 active）；本模块读取并镜像到打标元素。
import { getHerdrLang, setHerdrLang as setI18nLang } from './i18n.ts'

/** 当前语言的完整文案（aria-label 用）。 */
function heroTextForLang(): string {
  return getHerdrLang() === 'en' ? HERDR_HERO_TEXT_EN : HERDR_HERO_TEXT
}

/** 同步界面语言（app.tsx 订阅 locale 服务调用）；已标记元素立即刷新。 */
export function setHerdrLang(lang: string): void {
  setI18nLang(lang)
  if (typeof document === 'undefined') return
  const active = getHerdrLang()
  for (const el of Array.from(document.querySelectorAll('.' + TEXT_CLASS))) {
    el.setAttribute(LANG_ATTR, active)
  }
  for (const el of Array.from(document.querySelectorAll('.' + HEADLINE_CLASS))) {
    el.setAttribute('aria-label', heroTextForLang())
  }
  patchPresetChip()
  patchPresetIcon()
  patchPresetDesc()
}

/** hero 页 preset 芯片英文适配：仅当芯片显示 herdr preset 名时替换文本节点
 *  （内置 preset 由 shell locale 自动翻译，不匹配不处理）；文本替换可逆，
 *  React 重渲染重建后由 observer 重新应用。 */
function patchPresetChip(): void {
  for (const root of Array.from(document.querySelectorAll('[data-phase="hero"]'))) {
    for (const btn of Array.from(root.querySelectorAll('button'))) {
      const text = (btn.textContent ?? '').trim()
      for (const node of Array.from(btn.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE || node.textContent === null) continue
        if (getHerdrLang() === 'en' && node.textContent.includes(HERDR_PRESET_NAME_ZH)) {
          node.textContent = node.textContent.replace(HERDR_PRESET_NAME_ZH, HERDR_PRESET_NAME_EN)
        } else if (getHerdrLang() !== 'en' && node.textContent.includes(HERDR_PRESET_NAME_EN)) {
          node.textContent = node.textContent.replace(HERDR_PRESET_NAME_EN, HERDR_PRESET_NAME_ZH)
        }
      }
    }
  }
}

/** 新建会话「选择模式」中 Herdr 模式芯片前的图标替换为 Herdr logo（design: preset-icon）。 */
const PRESET_ICON_CLASS = 'herdr-preset-logo'
function patchPresetIcon(): void {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'))
  for (const btn of candidates) {
    if (!(btn instanceof HTMLElement)) continue
    const text = (btn.textContent ?? '').trim()
    const isHerdrBtn = text.includes(HERDR_PRESET_NAME_ZH) || text.includes(HERDR_PRESET_NAME_EN)
    if (!isHerdrBtn) continue
    if (btn.querySelector('.' + PRESET_ICON_CLASS)) continue
    let icon: Element | null = btn.querySelector('svg')
    if (!icon) icon = btn.querySelector('[class*="icon" i], [class*="Icon"]')
    if (!icon) icon = btn.querySelector('img')
    if (!icon) {
      const first = btn.firstElementChild
      if (first) icon = first
    }
    if (!icon) continue
    let target: Element = icon
    const parent = icon.parentElement
    if (parent && parent !== btn && /icon/i.test(parent.className ?? '')) {
      target = parent
    }
    // 避免把文本容器误判为图标（文本容器无 svg 后代但含文本；图标通常为 svg 或空 span）
    if (target instanceof HTMLElement && target.textContent?.trim() === text) continue
    target.classList.add(PRESET_ICON_CLASS)
    target.setAttribute('data-herdr-preset-icon', '')
  }
}

/** preset 文案（name + description）英文适配：全局文本节点替换（TreeWalker），
 *  覆盖 hero 页 preset 菜单（portal 渲染、不在 hero 根内）与设置页的展示；
 *  替换可逆，React 重建后由 observer 补标。 */
function patchPresetDesc(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.textContent ?? ''
    const en = getHerdrLang() === 'en'
    if (en
      ? text.includes(HERDR_PRESET_DESC_ZH) || text.includes(HERDR_PRESET_NAME_ZH)
      : text.includes(HERDR_PRESET_DESC_EN) || text.includes(HERDR_PRESET_NAME_EN)) {
      targets.push(node)
    }
  }
  for (const node of targets) {
    let text = node.textContent ?? ''
    if (getHerdrLang() === 'en') {
      text = text.replace(HERDR_PRESET_DESC_ZH, HERDR_PRESET_DESC_EN)
        .replace(HERDR_PRESET_NAME_ZH, HERDR_PRESET_NAME_EN)
    } else {
      text = text.replace(HERDR_PRESET_DESC_EN, HERDR_PRESET_DESC_ZH)
        .replace(HERDR_PRESET_NAME_EN, HERDR_PRESET_NAME_ZH)
    }
    node.textContent = text
  }
}

/** 是否为「含直接文本节点、且无 svg 后代」的 span（标题文本识别规则，含回退）。 */
function isTextSpan(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') {
      return el.querySelector('svg') === null
    }
  }
  return false
}

function patchHero(): void {
  for (const root of Array.from(document.querySelectorAll('[data-phase="hero"]'))) {
    const fishSvg = root.querySelector('svg[viewBox="' + FISH_VIEWBOX + '"]')
    if (!(fishSvg instanceof SVGElement)) continue
    const fishSeat = fishSvg.parentElement
    const headline = fishSeat?.parentElement
    if (!(fishSeat instanceof HTMLElement) || !(headline instanceof HTMLElement)) continue
    fishSeat.classList.add(FISH_CLASS)
    headline.classList.add(HEADLINE_CLASS)
    headline.setAttribute(LANG_ATTR, getHerdrLang())
    if (!headline.getAttribute('aria-label')) headline.setAttribute('aria-label', heroTextForLang())
    // 标题文本 span：fish 座位的下一个兄弟（DOM 顺序固定：fish 座位、标题文本、预览徽章）；
    // 回退：共同父容器内第一个「含直接文本节点且无 svg 后代」的元素
    let textEl = fishSeat.nextElementSibling
    if (!(textEl instanceof HTMLElement) || !isTextSpan(textEl)) {
      textEl = Array.from(headline.children).find(el => el instanceof HTMLElement && isTextSpan(el)) ?? null
    }
    if (textEl instanceof HTMLElement) {
      textEl.classList.add(TEXT_CLASS)
      textEl.setAttribute(LANG_ATTR, getHerdrLang())
    }
  }
  updateHeroSelectedMode()
}

const HERO_ATTR = 'data-herdr-hero'

function updateHeroSelectedMode(): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  // hero 阶段的预设芯片是否选中 Herdr（座位按钮在 hero 内，菜单 portal 在 hero 外可区分）
  const isHerdrSelected = Array.from(document.querySelectorAll('[data-phase="hero"] button')).some(btn => {
    const text = (btn.textContent ?? '').trim()
    return text.includes(HERDR_PRESET_NAME_ZH) || text.includes(HERDR_PRESET_NAME_EN)
  })
  if (isHerdrSelected) html.setAttribute(HERO_ATTR, '1')
  else html.removeAttribute(HERO_ATTR)
}

/** 启动 hero 打标（app.tsx apply 调用）；返回停止函数。 */
export function startHeroBranding(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  patchHero()
  patchPresetChip()
  patchPresetIcon()
  patchPresetDesc()
  let raf = 0
  const observer = new MutationObserver(() => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      patchHero()
      patchPresetChip()
      patchPresetIcon()
      patchPresetDesc()
    })
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
    characterData: true, // 芯片文本替换属于 characterData 变更；React 重建走 childList
  })
  return () => {
    observer.disconnect()
    if (raf) cancelAnimationFrame(raf)
  }
}
