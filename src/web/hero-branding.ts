// hero 标题打标（design: herdr-hero-branding §4.3）。
// HeroShell 的 headline 无稳定 data-* 属性（CSS module hash class 无法被插件 CSS 选中），
// 由 MutationObserver 幂等打上 herdr-hero-* class（仿 tab-controller 的「DOM 打标 + CSS」方案）：
// - herdr-hero-fish：fish 座位 span（内含 FishLogo svg）——::before 以 mask 渲染 herdr logo；
// - herdr-hero-text：标题文本 span——::before/::after 分段输出新文案；
// - herdr-hero-headline：标题容器——设置 aria-label（a11y）。
// 定位锚点：svg[viewBox="0 0 23.16 17.04"]（FishLogo 的固定 viewBox，跨主题不变）。
// React 重渲染会重写 className 抹掉标记 → attribute 观察重新打标（rAF 防抖，闪窗 ~1 帧可接受）。

/** 品牌化全文（headline 容器 aria-label；与 styles.ts 的 CSS content 同源，勿直接改文案）。 */
export const HERDR_HERO_TEXT = 'Herdr 助你探索未知之境'
/** 品牌特效段（styles.ts ::before content 引用）。 */
export const HERDR_HERO_TEXT_BRAND = 'Herdr 助你'
/** 原样式段（styles.ts ::after content 引用）。 */
export const HERDR_HERO_TEXT_PLAIN = '探索未知之境'

/** 品牌紫 token（styles.ts CSS 变量引用；取值 = herdr.dev 官网 site.css 的 --spot 实测，design §4.1）。 */
export const HERDR_BRAND_LIGHT = '#8839ef' // herdr.dev paper 模式
export const HERDR_BRAND_DARK = '#cba6f7' // herdr.dev ink 模式
export const HERDR_BRAND_GLOW_LIGHT = 'rgba(136, 57, 239, 0.28)'
export const HERDR_BRAND_GLOW_DARK = 'rgba(203, 166, 247, 0.25)'

const FISH_VIEWBOX = '0 0 23.16 17.04'
const FISH_CLASS = 'herdr-hero-fish'
const TEXT_CLASS = 'herdr-hero-text'
const HEADLINE_CLASS = 'herdr-hero-headline'

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
    if (!headline.getAttribute('aria-label')) headline.setAttribute('aria-label', HERDR_HERO_TEXT)
    // 标题文本 span：fish 座位的下一个兄弟（DOM 顺序固定：fish 座位、标题文本、预览徽章）；
    // 回退：共同父容器内第一个「含直接文本节点且无 svg 后代」的元素
    let textEl = fishSeat.nextElementSibling
    if (!(textEl instanceof HTMLElement) || !isTextSpan(textEl)) {
      textEl = Array.from(headline.children).find(el => el instanceof HTMLElement && isTextSpan(el)) ?? null
    }
    if (textEl instanceof HTMLElement) textEl.classList.add(TEXT_CLASS)
  }
}

/** 启动 hero 打标（app.tsx apply 调用）；返回停止函数。 */
export function startHeroBranding(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  patchHero()
  let raf = 0
  const observer = new MutationObserver(() => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      patchHero()
    })
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => {
    observer.disconnect()
    if (raf) cancelAnimationFrame(raf)
  }
}
