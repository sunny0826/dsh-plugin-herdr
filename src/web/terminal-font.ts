/**
 * xterm 的 canvas 渲染器把 fontFamily 直接写入 CanvasRenderingContext2D.font。
 * CSS 自定义变量在该 API 中不会展开，必须先借 DOM 解析成具体的字体族列表。
 */
const NERD_FONT_FALLBACKS =
  '"JetBrainsMono Nerd Font", "FiraCode Nerd Font", "MesloLGM Nerd Font", ' +
  '"Hack Nerd Font", "CaskaydiaCove Nerd Font", "Source Code Pro Nerd Font", monospace'

const UNRESOLVED_CSS_FUNCTION = /\b(?:var|env)\s*\(/i

/** 组合一个 Canvas 可接受的字体栈；未解析的 CSS 函数一律丢弃。 */
export function composeTerminalFontFamily(resolvedCodeFont: string | null | undefined): string {
  const primary = resolvedCodeFont?.trim()
  if (!primary || UNRESOLVED_CSS_FUNCTION.test(primary)) return NERD_FONT_FALLBACKS
  return `${primary}, ${NERD_FONT_FALLBACKS}`
}

/** 从 DSH CSS token 取得浏览器已解析的字体栈，供 xterm canvas 使用。 */
export function resolveTerminalFontFamily(host: HTMLElement): string {
  const probe = host.ownerDocument.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font-family:var(--ds-font-family-code, monospace)'
  host.appendChild(probe)
  const resolved = host.ownerDocument.defaultView?.getComputedStyle(probe).fontFamily
  probe.remove()
  return composeTerminalFontFamily(resolved)
}
