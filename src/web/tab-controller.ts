// herdr Tab 打标（design: herdr-mode-gating §4.2/§4.3）。
// conversation.view 槽位注册是全局静态的、tab DOM 无稳定标识（无 data-* 属性），
// 因此由 MutationObserver 给「Herdr」tab 幂等打上 herdr-tab class：
// - 显隐门控：html:not([data-herdr-mode='1']) .herdr-tab { display: none }（styles.ts）；
// - logo 锚点：.herdr-tab::before 以 CSS mask 渲染 logo（styles.ts）。
// React 重渲染（tabActive className 切换等）会重写 className 抹掉标记 →
// attribute 观察重新打标（rAF 防抖，闪窗 ~1 帧可接受）。

const TAB_LABEL = 'Herdr'
const TAB_CLASS = 'herdr-tab'

function patchTabs(): void {
  for (const el of Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'))) {
    if (!(el instanceof HTMLElement)) continue
    if ((el.textContent ?? '').trim() !== TAB_LABEL) continue
    el.classList.add(TAB_CLASS)
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', TAB_LABEL)
  }
}

/** 启动 tab 打标（app.tsx apply 调用）；返回停止函数。 */
export function startTabController(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  patchTabs()
  let raf = 0
  const observer = new MutationObserver(() => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      patchTabs()
    })
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-selected'],
  })
  return () => {
    observer.disconnect()
    if (raf) cancelAnimationFrame(raf)
  }
}
