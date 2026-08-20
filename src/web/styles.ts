// 样式注入（布局样式全部使用 DSH 真实 token；组件样式由 web shell 提供）。
// 顺序、内容与拆分前的 client.tsx 完全一致：模块加载时执行一次注入，
// 通过 STYLE_ID 检查避免重复（原样保留）。

import { herdrLogoMaskUrl } from './logo-path.ts'
import {
  HERDR_BRAND_DARK,
  HERDR_BRAND_GLOW_DARK,
  HERDR_BRAND_GLOW_LIGHT,
  HERDR_BRAND_LIGHT,
  HERDR_HERO_TEXT_BRAND,
  HERDR_HERO_TEXT_BRAND_EN,
  HERDR_HERO_TEXT_PLAIN,
  HERDR_HERO_TEXT_PLAIN_EN,
} from './hero-branding.ts'

const STYLE_ID = 'dsh-plugin-herdr-styles'

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.herdr-root {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px 24px; min-height: 100%; box-sizing: border-box;
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.herdr-head {
  position: sticky; top: 0; z-index: 4;
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0 10px;
  background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.herdr-head-title { font-size: 15px; font-weight: 600; }
/* 运行态折叠进 header：连接点 + 版本（mono tertiary） */
.herdr-head-server {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.herdr-head-version {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-header-stats { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.herdr-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* 扁平 pane 网格（v3：单一会话 workspace，无组头；沿用原 ws-body 双列布局） */
.herdr-pane-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
  padding: 2px 0 6px 4px;
}
/* 响应式断点：720px 以下单列（P2-9） */
@media (max-width: 720px) {
  .herdr-pane-grid { grid-template-columns: minmax(0, 1fr); }
}
/* 480px 以下隐藏次要 meta（pane id、时间），保留 pane 名、状态和主操作 */
@media (max-width: 480px) {
  .herdr-header-stats { display: none; }
  .herdr-pcard-time { display: none; }
}
/* ── Herdr Tab 布局切换（window / list 双模式） ─────────────────────── */
.herdr-layout-switch {
  display: inline-flex; align-items: center; gap: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 2px;
  background: var(--dsw-alias-bg-module-platform);
}
.herdr-layout-switch button {
  border: none; background: transparent; padding: 3px 10px;
  font-size: 11.5px; line-height: 16px; font-weight: 500;
  color: var(--dsw-alias-label-tertiary); border-radius: 999px; cursor: pointer;
  white-space: nowrap; transition: background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-layout-switch button:hover { color: var(--dsw-alias-label-secondary); }
.herdr-layout-switch button.active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv1);
}
.herdr-layout-switch button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: 1px;
}
/* ── 列表模式：Master-Detail ─────────────────────────────────────── */
.herdr-list-layout {
  display: flex; gap: 12px; min-height: 520px; align-items: stretch;
}
.herdr-list-nav {
  flex: none; display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px; padding: 6px;
  overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.herdr-list-nav::-webkit-scrollbar { width: 6px; }
.herdr-list-nav::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.herdr-list-row {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 8px; border-radius: 8px;
  cursor: pointer; min-height: 28px; box-sizing: border-box;
  border: 1px solid transparent;
  transition: background .12s var(--ds-ease-in-out), border-color .12s var(--ds-ease-in-out);
}
.herdr-list-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-list-row[data-active] {
  background: var(--dsw-alias-state-business-tertiary);
  border-color: var(--dsw-alias-state-business-secondary);
}
.herdr-list-row:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: -1px;
}
.herdr-list-row-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 500; line-height: 18px;
}
.herdr-list-row .herdr-list-row-agent { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 96px; }
.herdr-list-resizer {
  flex: none; width: 6px; align-self: stretch;
  border-radius: 999px; cursor: col-resize;
  background: transparent;
  position: relative;
  transition: background .12s var(--ds-ease-in-out);
}
.herdr-list-resizer::after {
  content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 2px;
  border-radius: 999px; background: transparent; transition: background .12s var(--ds-ease-in-out);
}
.herdr-list-resizer:hover::after, .herdr-list-resizer[data-dragging]::after {
  background: var(--dsw-alias-state-business-primary);
}
.herdr-list-detail {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px;
}
.herdr-list-detail-head {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  padding: 6px 2px 0;
}
.herdr-list-detail-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.herdr-list-detail-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); flex: none; }
@media (max-width: 720px) {
  .herdr-list-layout { flex-direction: column; }
  .herdr-list-nav { width: auto !important; max-height: 200px; }
  .herdr-list-resizer { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .herdr-layout-switch button, .herdr-list-row, .herdr-list-resizer::after { transition: none; }
}
.herdr-pane {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-pane:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.herdr-pane[data-focused] { border-color: var(--dsw-alias-state-business-primary); }
.herdr-pane-id {
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; font-weight: 500;
}
.herdr-pane-focus { color: var(--dsw-alias-state-business-primary); font-size: 11px; }
.herdr-pane-meta { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.herdr-pane-cwd {
  font-family: var(--ds-font-family-code); font-size: 11px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.herdr-pane-time { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.herdr-pane-chev {
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform .15s var(--ds-ease-in-out);
}
.herdr-pane[data-open] .herdr-pane-chev { transform: rotate(90deg); }
.herdr-pane-out { display: none; flex-direction: column; gap: 8px; padding: 0 4px; }
.herdr-pane[data-open] + .herdr-pane-out { display: flex; }
.herdr-pane-message { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 0 12px; }
.herdr-dot-muted { background: var(--dsw-alias-label-tertiary); }

/* ── pane 卡片（PaneCard，纵向；T06） ──────────────────────────────── */
.herdr-pcard {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px 8px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  min-height: 360px;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-pcard[data-focused] { border-color: var(--dsw-alias-state-business-primary); }
/* 本对话 pane：business-secondary 描边 + 名称后 self 标签 */
.herdr-pcard[data-self] { border-color: var(--dsw-alias-state-business-secondary); }
.herdr-pcard-head {
  display: flex; align-items: center; gap: 8px;
  min-width: 0;
}
.herdr-pcard-name {
  font-size: 13px; line-height: 20px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0;
}
.herdr-pcard-actions {
  display: inline-flex; align-items: center; gap: 2px;
  margin-left: auto; flex: none;
}
/* 卡片 header 操作按钮：默认透明，卡片 hover 时显现（T11 ✕ / T12 ✎） */
.herdr-pcard-close,
.herdr-pcard-edit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; flex: none;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 16px; cursor: pointer;
  opacity: 0; transition: opacity .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-pcard:hover .herdr-pcard-close,
.herdr-pcard:hover .herdr-pcard-edit,
.herdr-pcard-close:focus-visible,
.herdr-pcard-edit:focus-visible { opacity: 1; }
.herdr-pcard-edit:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.herdr-pcard-close:hover { background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); }
.herdr-pcard-close:disabled,
.herdr-pcard-edit:disabled { opacity: .4; cursor: default; }
/* 重命名 inline input（卡片名原位） */
.herdr-pcard-rename-input {
  min-width: 0; flex: 1;
  font-family: var(--dsw-font-family); font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-module-platform);
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 6px; padding: 1px 6px; box-sizing: border-box;
}
.herdr-pcard-rename-input:focus { outline: none; }
.herdr-inline-error {
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
}
/* 拖拽手柄：仅此区域可拖（draggable），避免与点击展开冲突 */
.herdr-pcard-handle {
  flex: none; cursor: grab;
  font-size: 13px; line-height: 16px; letter-spacing: 1px;
  color: var(--dsw-alias-label-tertiary);
  padding: 0 2px; user-select: none;
  /* 手柄本身不触发展开（onClick stopPropagation 兜底） */
}
.herdr-pcard-handle:hover { color: var(--dsw-alias-state-business-primary); }
.herdr-pcard-handle:active { cursor: grabbing; }
/* 被拖项：半透明 + 虚线框，直观反馈正在拖 */
.herdr-pcard[data-dragging] {
  opacity: .45;
  border-style: dashed;
}
/* 插入指示线：before → 左/上边框蓝条；after → 右/下边框蓝条 */
.herdr-pcard[data-insert='before'] {
  box-shadow: -3px 0 0 0 var(--dsw-alias-state-business-primary), 0 -3px 0 0 var(--dsw-alias-state-business-primary);
}
.herdr-pcard[data-insert='after'] {
  box-shadow: 3px 0 0 0 var(--dsw-alias-state-business-primary), 0 3px 0 0 var(--dsw-alias-state-business-primary);
}
.herdr-pcard-time {
  font-size: 11px; color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; flex: none;
}
.herdr-pcard-chev {
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); flex: none;
  transition: transform .15s var(--ds-ease-in-out);
}
.herdr-pcard[data-open] .herdr-pcard-chev { transform: rotate(90deg); }

/* 日志主体：行级渲染；收起 3 行渐变淡出；展开滚动区 220px、等宽 */
.herdr-pcard-log {
  position: relative;
  flex: 1; max-height: 220px; overflow-y: auto;
  font-family: var(--ds-font-family-code); font-size: 12px; line-height: 20px;
  background: var(--dsw-alias-markdown-code-block);
  border-radius: 8px; padding: 8px 10px;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
  transition: max-height .18s var(--ds-ease-in-out), min-height .18s var(--ds-ease-in-out);
}
.herdr-pcard-log::-webkit-scrollbar { width: 6px; }
.herdr-pcard-log::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
/* 展开态：日志区至少 96px（撑起卡片主体） */
.herdr-pcard-log:not([data-collapsed]) { min-height: 96px; }
/* 收起态：min/max 同时约束为 60px（否则 min-height 96 优先于 max-height，收起不生效） */
.herdr-pcard-log[data-collapsed] {
  min-height: 60px; max-height: 60px; overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 55%, transparent);
  mask-image: linear-gradient(#000 55%, transparent);
}
.herdr-pcard-log-body {
  display: flex; flex-direction: column;
  padding-right: 12px; /* 给 working 指示点留位 */
}
.herdr-log-line {
  min-height: 20px; line-height: 20px;
  white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}
/* 行语义着色（classifyLogLine）：命令 / diff 增删 / 标题 / 代码围栏 */
.herdr-log-line[data-kind='cmd'] { color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.herdr-log-line[data-kind='diff-add'] { color: var(--dsw-alias-state-success-primary); }
.herdr-log-line[data-kind='diff-del'] { color: var(--dsw-alias-state-error-primary); }
.herdr-log-line[data-kind='heading'] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.herdr-log-line[data-kind='code-fence'] { color: var(--dsw-alias-label-tertiary); }
/* Agent 品牌强调色（agentTheme）：日志区边框/指示点随 agent 变化 */
.herdr-pcard-log[data-accent='codex'] { border: 1px solid var(--dsw-alias-state-business-secondary); }
.herdr-pcard-log[data-accent='pi'] { border: 1px solid var(--dsw-alias-state-warn-secondary); }
.herdr-pcard-log[data-accent='claude'] { border: 1px solid var(--dsw-alias-state-success-secondary); }
.herdr-pcard-log[data-accent='kimi'] { border: 1px solid var(--dsw-alias-state-info-secondary); }
/* 卡片 header agent 徽章色点 */
.herdr-agent-accent {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.herdr-agent-accent[data-accent='codex'] { background: var(--dsw-alias-state-business-primary); }
.herdr-agent-accent[data-accent='pi'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-agent-accent[data-accent='claude'] { background: var(--dsw-alias-state-success-primary); }
.herdr-agent-accent[data-accent='kimi'] { background: var(--dsw-alias-state-info-primary); }
.herdr-agent-accent[data-accent='dsh'] { background: var(--dsw-alias-label-tertiary); }
.herdr-log-live {
  position: absolute; top: 7px; right: 8px;
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-success-primary);
  animation: herdr-log-live-pulse 1.3s var(--ds-ease-in-out) infinite;
}
@keyframes herdr-log-live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .25; }
}
.herdr-pcard-log-empty {
  font-family: var(--dsw-font-family); font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-log-truncated {
  font-family: var(--dsw-font-family); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border-top: 1px solid var(--dsw-alias-state-warn-secondary);
  padding: 2px 8px;
  border-radius: 0 0 8px 8px;
}
/* ── 交互式终端（design: pane-xterm-terminal-design §4） ─── */
.herdr-term {
  position: relative;
  flex: 1;
  min-height: 280px;
  min-width: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  background: var(--dsw-alias-markdown-code-block);
  border-radius: 8px;
  overflow: hidden;
}
.herdr-list-detail .herdr-term {
  min-height: 420px;
}
/* xterm.js host container */
.herdr-xterm-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  padding: 4px;
  overflow: hidden;
  box-sizing: border-box;
}
/* xterm.js 必要布局样式（从 xterm.css 提取核心选择器，接 DSH token） */
.herdr-xterm-host .xterm {
  height: 100%;
  padding: 0;
  position: relative;
  user-select: none;
  -webkit-user-select: none;
  cursor: text;
}
.herdr-xterm-host .xterm:focus,
.herdr-xterm-host .xterm.focus { outline: none; }
.herdr-xterm-host .xterm-helpers {
  position: absolute;
  top: 0;
  z-index: 5;
}
.herdr-xterm-host .xterm-helper-textarea {
  position: absolute;
  left: -9999em;
  top: 0;
  width: 0;
  height: 0;
  padding: 0;
  border: 0;
  margin: 0;
  opacity: 0;
  overflow: hidden;
  resize: none;
  white-space: nowrap;
}
/* xterm 6 DOM renderer 的测宽节点会写入 )、% 等样本文本；必须离屏隐藏，
 * 否则它们会作为普通 inline 内容覆盖终端首行。 */
.herdr-xterm-host .xterm-char-measure-element {
  display: inline-block;
  visibility: hidden;
  position: absolute;
  top: 0;
  left: -9999em;
  line-height: normal;
}
.herdr-xterm-host .composition-view {
  display: none;
  position: absolute;
  z-index: 6;
  white-space: nowrap;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-primary);
}
.herdr-xterm-host .composition-view.active { display: block; }
.herdr-xterm-host .xterm-viewport {
  overflow-y: auto !important;
  position: absolute;
  inset: 0;
  cursor: default;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
  background-color: transparent !important;
}
.herdr-xterm-host .xterm-viewport::-webkit-scrollbar { width: 6px; }
.herdr-xterm-host .xterm-viewport::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.herdr-xterm-host .xterm-screen {
  position: relative;
  background-color: transparent !important;
}
.herdr-xterm-host .xterm-screen canvas { position: absolute; inset: 0 auto auto 0; }
.herdr-xterm-host .xterm-rows {
  color: var(--dsw-alias-label-secondary);
}
.herdr-xterm-host .xterm { background-color: transparent !important; }
.herdr-xterm-host .xterm-selection {
  background: var(--dsw-alias-state-info-primary) !important;
  opacity: 0.3;
}
html:not([data-ds-dark-theme]) .herdr-xterm-host .xterm-rows span[style*="background"] {
  background-color: #f0f0f0 !important;
  color: #141413 !important;
}
html:not([data-ds-dark-theme]) .herdr-log-segment[style*="background"] {
  background-color: transparent !important;
}
/* 终端同步/状态指示 */
.herdr-term-sync {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 2;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  padding: 2px 8px;
  border-radius: 999px;
}
.herdr-term-warning {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 2;
  font-size: 11px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  padding: 2px 8px;
  border-radius: 999px;
}
.herdr-term-compat {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 2;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: default;
  border: 1px solid var(--dsw-alias-state-info-secondary);
  background: var(--dsw-alias-state-info-tertiary);
  color: var(--dsw-alias-state-info-label);
}
/* controller 冲突覆盖层 */
.herdr-term-conflict {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  border-radius: 8px;
}
.herdr-term-conflict-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.herdr-term-conflict-actions button {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.herdr-term-conflict-actions button:hover {
  border-color: var(--dsw-alias-state-business-primary);
}
.herdr-term-header {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid;
  transition: background-color 180ms, border-color 180ms;
}
.herdr-term-header[data-mode="observing"] {
  background: #f6f6f6;
  border-color: #e5e7eb;
}
.herdr-term-header[data-mode="controlling"] {
  background: color-mix(in srgb, var(--accent, #7c3aed) 6%, transparent);
  border-color: var(--accent);
}
.herdr-term-header[data-mode="conflict"] {
  background: #fee2e2;
  border-color: #fecaca;
}
.herdr-term-header[data-mode="snapshot"] {
  background: #fef3c7;
  border-color: #fde68a;
}
body[data-ds-dark-theme] .herdr-term-header[data-mode="observing"] {
  background: #1f2937;
  border-color: #374151;
}
body[data-ds-dark-theme] .herdr-term-header[data-mode="controlling"] {
  background: color-mix(in srgb, var(--accent, #7c3aed) 12%, #1f2937);
  border-color: var(--accent);
}
body[data-ds-dark-theme] .herdr-term-header[data-mode="conflict"] {
  background: #450a0a;
  border-color: #7f1d1d;
}
body[data-ds-dark-theme] .herdr-term-header[data-mode="snapshot"] {
  background: #451a03;
  border-color: #92400e;
}
.herdr-term-header-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.herdr-term-header-center {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.herdr-term-occupant {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.herdr-term-header-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-left: auto;
}
.herdr-term-sup {
  font-size: 10px;
  line-height: 14px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  cursor: help;
  white-space: nowrap;
}
.herdr-term-header-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out);
}
.herdr-term-header-btn:hover { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }
.herdr-term-header-btn--release { border-color: var(--dsw-alias-state-business-secondary); }
.herdr-term-header-hint {
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}
.herdr-term-host-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.herdr-term-hover {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 150ms 150ms;
  pointer-events: none;
}
.herdr-xterm-host:hover .herdr-term-hover {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .herdr-term-header { transition: none; }
  .herdr-term-hover { transition: none; }
}
.herdr-term-conflict-bar {
  background: #fee2e2;
  border: 1px solid #fecaca;
  padding: 6px 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
body[data-ds-dark-theme] .herdr-term-conflict-bar {
  background: #450a0a;
  border-color: #7f1d1d;
  color: #fecaca;
}
.herdr-term-output {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.herdr-term-output::-webkit-scrollbar { width: 6px; }
.herdr-term-output::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.herdr-term-body {
  display: flex;
  flex-direction: column;
}
.herdr-term-row {
  min-height: 18px;
  white-space: pre;
  color: var(--dsw-alias-label-secondary);
}
.herdr-term-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  border: none;
  padding: 0;
  margin: 0;
  pointer-events: none;
}
.herdr-term-input:focus {
  outline: none;
}
.herdr-term-scroll-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 2;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
}
.herdr-term-scroll-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.herdr-term-error {
  position: absolute;
  bottom: 32px;
  right: 8px;
  z-index: 2;
  font-size: 11px;
  color: var(--dsw-alias-state-error-label);
  background: var(--dsw-alias-state-error-tertiary);
  border: 1px solid var(--dsw-alias-state-error-secondary);
  padding: 2px 8px;
  border-radius: 999px;
}
.herdr-term-input-error {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 3;
  max-width: calc(100% - 16px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-state-error-label);
  background: var(--dsw-alias-state-error-tertiary);
  border: 1px solid var(--dsw-alias-state-error-secondary);
  padding: 2px 8px;
  border-radius: 999px;
}
.herdr-pcard-maximize {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; flex: none;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 16px; cursor: pointer;
  opacity: 0; transition: opacity .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-pcard:hover .herdr-pcard-maximize,
.herdr-pcard-maximize:focus-visible { opacity: 1; }
.herdr-pcard-maximize:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* 最大化终端视图 */
.herdr-terminal-maximized {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
}
.herdr-term-max-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.herdr-term-max-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.herdr-term-max-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px; cursor: pointer;
}
.herdr-term-max-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.herdr-terminal-maximized .herdr-term {
  flex: 1;
  min-height: 0;
  border-radius: 0;
}
/* ── ANSI 终端样式（design: pane-log-terminal-design §3.6-3.8） ──────
 * 16 色 CSS 变量映射到 DSH token，浅色/深色主题自动切换。
 * segment 使用 --herdr-term-fg/bg 自定义属性；显式 ANSI 优先于 semantic fallback。
 * 组件只输出 data-ansi-* 属性，样式表驱动颜色。
 */
/* 16 色 ANSI 变量：定义在终端 surface 作用域（.herdr-term + .herdr-pcard-log 兼容） */
.herdr-term, .herdr-pcard-log {
  --herdr-terminal-ansi-0: var(--dsw-alias-label-tertiary);
  --herdr-terminal-ansi-1: var(--dsw-alias-state-error-primary);
  --herdr-terminal-ansi-2: var(--dsw-alias-state-success-primary);
  --herdr-terminal-ansi-3: var(--dsw-alias-state-warn-primary);
  --herdr-terminal-ansi-4: var(--dsw-alias-state-info-primary);
  --herdr-terminal-ansi-5: var(--dsw-alias-state-business-primary);
  --herdr-terminal-ansi-6: var(--dsw-alias-state-info-primary);
  --herdr-terminal-ansi-7: var(--dsw-alias-label-primary);
  --herdr-terminal-ansi-8: var(--dsw-alias-label-secondary);
  --herdr-terminal-ansi-9: var(--dsw-alias-state-error-label);
  --herdr-terminal-ansi-10: var(--dsw-alias-state-success-primary);
  --herdr-terminal-ansi-11: var(--dsw-alias-state-warn-label);
  --herdr-terminal-ansi-12: var(--dsw-alias-state-info-primary);
  --herdr-terminal-ansi-13: var(--dsw-alias-state-business-primary);
  --herdr-terminal-ansi-14: var(--dsw-alias-state-info-primary);
  --herdr-terminal-ansi-15: var(--dsw-alias-label-primary);
}
/* segment 基础：消费 --herdr-term-fg/bg，无显式 ANSI 时回退到 semantic/基础 token */
.herdr-log-segment {
  color: var(--herdr-term-fg, var(--herdr-log-semantic-fg, var(--dsw-alias-label-secondary)));
  background-color: var(--herdr-term-bg, transparent);
}
/* ANSI 16 色前景 data 属性 → CSS 变量 */
.herdr-log-segment[data-ansi-fg='0'] { --herdr-term-fg: var(--herdr-terminal-ansi-0); }
.herdr-log-segment[data-ansi-fg='1'] { --herdr-term-fg: var(--herdr-terminal-ansi-1); }
.herdr-log-segment[data-ansi-fg='2'] { --herdr-term-fg: var(--herdr-terminal-ansi-2); }
.herdr-log-segment[data-ansi-fg='3'] { --herdr-term-fg: var(--herdr-terminal-ansi-3); }
.herdr-log-segment[data-ansi-fg='4'] { --herdr-term-fg: var(--herdr-terminal-ansi-4); }
.herdr-log-segment[data-ansi-fg='5'] { --herdr-term-fg: var(--herdr-terminal-ansi-5); }
.herdr-log-segment[data-ansi-fg='6'] { --herdr-term-fg: var(--herdr-terminal-ansi-6); }
.herdr-log-segment[data-ansi-fg='7'] { --herdr-term-fg: var(--herdr-terminal-ansi-7); }
.herdr-log-segment[data-ansi-fg='8'] { --herdr-term-fg: var(--herdr-terminal-ansi-8); }
.herdr-log-segment[data-ansi-fg='9'] { --herdr-term-fg: var(--herdr-terminal-ansi-9); }
.herdr-log-segment[data-ansi-fg='10'] { --herdr-term-fg: var(--herdr-terminal-ansi-10); }
.herdr-log-segment[data-ansi-fg='11'] { --herdr-term-fg: var(--herdr-terminal-ansi-11); }
.herdr-log-segment[data-ansi-fg='12'] { --herdr-term-fg: var(--herdr-terminal-ansi-12); }
.herdr-log-segment[data-ansi-fg='13'] { --herdr-term-fg: var(--herdr-terminal-ansi-13); }
.herdr-log-segment[data-ansi-fg='14'] { --herdr-term-fg: var(--herdr-terminal-ansi-14); }
.herdr-log-segment[data-ansi-fg='15'] { --herdr-term-fg: var(--herdr-terminal-ansi-15); }
/* ANSI 16 色背景 data 属性 → CSS 变量 */
.herdr-log-segment[data-ansi-bg='0'] { --herdr-term-bg: var(--herdr-terminal-ansi-0); }
.herdr-log-segment[data-ansi-bg='1'] { --herdr-term-bg: var(--herdr-terminal-ansi-1); }
.herdr-log-segment[data-ansi-bg='2'] { --herdr-term-bg: var(--herdr-terminal-ansi-2); }
.herdr-log-segment[data-ansi-bg='3'] { --herdr-term-bg: var(--herdr-terminal-ansi-3); }
.herdr-log-segment[data-ansi-bg='4'] { --herdr-term-bg: var(--herdr-terminal-ansi-4); }
.herdr-log-segment[data-ansi-bg='5'] { --herdr-term-bg: var(--herdr-terminal-ansi-5); }
.herdr-log-segment[data-ansi-bg='6'] { --herdr-term-bg: var(--herdr-terminal-ansi-6); }
.herdr-log-segment[data-ansi-bg='7'] { --herdr-term-bg: var(--herdr-terminal-ansi-7); }
.herdr-log-segment[data-ansi-bg='8'] { --herdr-term-bg: var(--herdr-terminal-ansi-8); }
.herdr-log-segment[data-ansi-bg='9'] { --herdr-term-bg: var(--herdr-terminal-ansi-9); }
.herdr-log-segment[data-ansi-bg='10'] { --herdr-term-bg: var(--herdr-terminal-ansi-10); }
.herdr-log-segment[data-ansi-bg='11'] { --herdr-term-bg: var(--herdr-terminal-ansi-11); }
.herdr-log-segment[data-ansi-bg='12'] { --herdr-term-bg: var(--herdr-terminal-ansi-12); }
.herdr-log-segment[data-ansi-bg='13'] { --herdr-term-bg: var(--herdr-terminal-ansi-13); }
.herdr-log-segment[data-ansi-bg='14'] { --herdr-term-bg: var(--herdr-terminal-ansi-14); }
.herdr-log-segment[data-ansi-bg='15'] { --herdr-term-bg: var(--herdr-terminal-ansi-15); }
/* 256/truecolor 运行时 RGB（组件通过 style 属性注入 --herdr-term-fg/bg） */
.herdr-log-segment[data-ansi-fg-rgb] { --herdr-term-fg: rgb(from var(--_ansi-fg-r,0) var(--_ansi-fg-g,0) var(--_ansi-fg-b,0)); }
/* SGR 装饰属性 */
.herdr-log-segment[data-ansi-bold] { font-weight: 600; }
.herdr-log-segment[data-ansi-dim] { opacity: 0.6; }
.herdr-log-segment[data-ansi-underline] { text-decoration: underline; }
.herdr-log-segment[data-ansi-inverse] {
  color: var(--herdr-term-bg, var(--dsw-alias-markdown-code-block));
  background-color: var(--herdr-term-fg, var(--dsw-alias-label-primary));
}
/* 语义 fallback 变量：由 .herdr-log-line[data-kind] 设置，仅当 segment 无 --herdr-term-fg 时生效 */
.herdr-log-line[data-kind='cmd'] { --herdr-log-semantic-fg: var(--dsw-alias-state-business-primary); }
.herdr-log-line[data-kind='diff-add'] { --herdr-log-semantic-fg: var(--dsw-alias-state-success-primary); }
.herdr-log-line[data-kind='diff-del'] { --herdr-log-semantic-fg: var(--dsw-alias-state-error-primary); }
.herdr-log-line[data-kind='heading'] { --herdr-log-semantic-fg: var(--dsw-alias-label-primary); }
.herdr-log-line[data-kind='code-fence'] { --herdr-log-semantic-fg: var(--dsw-alias-label-tertiary); }
.herdr-pcard-foot {
  display: flex; align-items: center; gap: 8px;
  flex: none;
}
.herdr-pcard-foot-btn {
  border: none; background: none; padding: 0;
  font-size: 12px; font-weight: 500; cursor: pointer;
  color: var(--dsw-alias-state-business-primary);
}
.herdr-pcard-expand-btn {
  min-height: 28px; padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; font-weight: 500; cursor: pointer;
  color: var(--dsw-alias-state-business-primary);
}
.herdr-pcard-expand-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-pcard-foot-btn:hover { text-decoration: underline; text-underline-offset: 2px; }
.herdr-pcard-expand-btn:focus-visible,
.herdr-pcard-foot-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: 1px;
}
.herdr-pcard-foot-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.herdr-pcard-empty {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  margin-left: 4px;
}
.herdr-state-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
/* ── 五态展示模型 CSS token 映射（design: herdr-tab-redesign §4.3） ────
 * 组件通过 data-state 属性绑定 paneDisplayState() 返回值；
 * 旧的 ongoing/warning/error 选择器保留用于 dotState() 的 StateDot primitive 兼容。
 * unknown 使用 muted token，不再伪装 done（P1-1 修复）。 */
.herdr-state-text[data-state=working] { color: var(--dsw-alias-state-business-primary); }
.herdr-state-text[data-state=blocked] { color: var(--dsw-alias-state-error-primary); }
.herdr-state-text[data-state=idle] { color: var(--dsw-alias-state-success-primary); }
/* done 从成功绿改为中性灰（dashboard-redesign：done≠idle） */
.herdr-state-text[data-state=done] { color: var(--dsw-alias-label-tertiary); }
.herdr-state-text[data-state=unknown] { color: var(--dsw-alias-label-tertiary); }
/* 五态 KPI-lite 状态块（design: herdr-tab-redesign §4.2 重设计——紧凑瓦片，
   与 dashboard KPI 同一视觉语言：16px 数字 + 11px 标签 + 卡片面） */
.herdr-state-tiles {
  display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
}
.herdr-state-tile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 8px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.herdr-state-tile b {
  font-size: 16px; font-weight: 600; line-height: 22px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.herdr-state-tile-label {
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-state-tile[data-state='working'] b { color: var(--dsw-alias-state-business-primary); }
.herdr-state-tile[data-state='blocked'] b { color: var(--dsw-alias-state-error-primary); }
.herdr-state-tile[data-state='idle'] b { color: var(--dsw-alias-state-success-primary); }
.herdr-state-tile[data-state='done'] b,
.herdr-state-tile[data-state='unknown'] b { color: var(--dsw-alias-label-tertiary); }
/* dotState() legacy: StateDot primitive 兼容（ongoing/error/done） */
.herdr-state-text[data-dot=done] { color: var(--dsw-alias-state-success-primary); }
.herdr-state-text[data-dot=error] { color: var(--dsw-alias-state-error-primary); }
.herdr-state-text[data-dot=warning] { color: var(--dsw-alias-state-warn-primary); }
.herdr-state-text[data-dot=ongoing] { color: var(--dsw-alias-state-business-primary); }
.herdr-agent-pill .herdr-agent-name { font-weight: 500; }
.herdr-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  padding: 28px 16px; text-align: center; line-height: 20px;
}
/* 空态 herdr logo（28px tertiary；与会话视图/浮层空态共用） */
.herdr-empty-logo {
  width: 28px; height: 28px; display: block;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-empty code {
  font-family: var(--ds-font-family-code);
  font-size: 11px; background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px; padding: 1px 5px;
}
.herdr-empty-show-all {
  margin-top: 10px; padding: 4px 14px;
  font-size: 12px; font-weight: 500; cursor: pointer;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover-solid);
  border: 1px solid var(--dsw-alias-state-business-secondary);
  border-radius: 999px;
}
.herdr-empty-show-all:hover { background: var(--dsw-alias-state-business-tertiary); }
/* 看板 scope 切换（T13）：segmented pill toggle */
.herdr-scope-toggle {
  display: inline-flex; align-items: center; gap: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 2px; background: var(--dsw-alias-bg-module-platform);
}
.herdr-scope-pill {
  border: none; background: transparent; padding: 3px 10px;
  font-size: 11.5px; line-height: 16px; font-weight: 500;
  color: var(--dsw-alias-label-tertiary); border-radius: 999px; cursor: pointer;
  white-space: nowrap; transition: background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-scope-pill:hover { color: var(--dsw-alias-label-secondary); }
.herdr-scope-pill.active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv1);
}
/* 组头统计旁过滤提示（仅本项目 matched/total） */
.herdr-filter-hint {
  display: inline-block; margin-left: 8px;
  font-size: 11px; line-height: 16px; font-weight: 500;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  border: 1px solid var(--dsw-alias-state-business-secondary);
  border-radius: 999px; padding: 0 8px;
  cursor: help;
}
/* 操作失败横幅（关闭/关闭 workspace 失败回滚后展示） */
.herdr-action-error {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-error-label);
  background: var(--dsw-alias-state-error-tertiary);
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 10px; padding: 8px 12px;
}
.herdr-drop-hint {
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  border-radius: 10px; padding: 8px 12px;
}
.herdr-action-error span { flex: 1; }
.herdr-action-error button {
  border: none; background: none; padding: 0; cursor: pointer;
  color: inherit; font-size: 12px; line-height: 18px;
}
/* 确认 modal（T11）：遮罩 + 卡片（DSH token） */
.herdr-mask {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1);
}
.herdr-modal {
  max-width: 360px; width: calc(100% - 48px);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
  padding: 16px;
  display: flex; flex-direction: column; gap: 14px;
}
.herdr-modal-title {
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-primary); word-break: break-word;
}
.herdr-modal-title code {
  font-family: var(--ds-font-family-code);
  font-size: 12px; background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px; padding: 0 5px;
}
.herdr-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.herdr-modal-btn {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px; font-weight: 500; line-height: 16px;
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
}
.herdr-modal-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-modal-btn:disabled { opacity: .5; cursor: default; }
.herdr-modal-btn-danger {
  color: var(--dsw-alias-state-error-label);
  background: var(--dsw-alias-state-error-tertiary);
  border-color: var(--dsw-alias-state-error-secondary);
}
.herdr-modal-btn-danger:hover { background: var(--dsw-alias-state-error-secondary); }
/* ── 会话页右侧 pane 状态列表面板 ─────────────────────────────── */
.pane-list-panel {
  position: fixed; top: 56px; right: 16px; width: 264px; max-width: calc(100vw - 32px); z-index: 30;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv2);
  display: flex; flex-direction: column;
  max-height: calc(100vh - 72px);
  transition: left .25s var(--ds-ease-in-out, ease), top .25s var(--ds-ease-in-out, ease), width .25s var(--ds-ease-in-out, ease), max-height .25s var(--ds-ease-in-out, ease), box-shadow .25s var(--ds-ease-in-out, ease), height .25s var(--ds-ease-in-out, ease), aspect-ratio .25s var(--ds-ease-in-out, ease);
}
.pane-list-panel[data-viewer] { width: 400px; }
@media (prefers-reduced-motion: reduce) {
  .pane-list-panel { transition: none; }
}
.pane-list-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab;
}
.pane-list-head:active { cursor: grabbing; }
.pane-list-title { font-size: 13px; font-weight: 500; line-height: 20px; }
.pane-list-meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.pane-list-collapse {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; flex: none;
}
.pane-list-collapse:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.pane-list-body { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
/* 悬浮面板过滤提示（T15）：列表顶部窄行，复用 .herdr-filter-hint 胶囊（覆盖其 margin） */
.pane-list-filter {
  padding: 4px 8px 2px;
  display: flex; align-items: center;
}
.pane-list-filter .herdr-filter-hint {
  margin-left: 0;
  font-size: 10.5px; line-height: 15px; padding: 0 7px;
}
.pane-list-body::-webkit-scrollbar { width: 6px; }
.pane-list-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.pl-group { border-radius: 8px; }
.pl-group + .pl-group { margin-top: 4px; }
.pl-group-head {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 7px; cursor: pointer;
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
  user-select: none;
}
.pl-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pl-group-head:focus-visible,
.pl-row:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: -1px;
}
.pl-group-head .chev { width: 12px; height: 12px; transition: transform .15s var(--ds-ease-in-out); flex: none; }
.pl-group[data-collapsed] .chev { transform: rotate(-90deg); }
.pl-group-head .ws { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
.pl-group-head .n { margin-left: auto; font-variant-numeric: tabular-nums; }
.pl-group[data-collapsed] .pl-group-body { display: none; }
.pl-group-body { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 3px; }
.pl-row {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 8px; border-radius: 7px;
  min-height: 26px;
  cursor: pointer;
}
.pl-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
@media (max-width: 480px) {
  .pl-group-head .ws,
  .pl-paneid { display: none; }
}
.pl-row[data-self] { background: var(--dsw-alias-state-business-tertiary); }
.pl-row[data-self]:hover { background: var(--dsw-alias-interactive-bg-hover-accent); }
.pl-paneid { font-size: 12px; line-height: 16px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-agent { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-state { margin-left: auto; font-size: 11px; line-height: 16px; flex: none; }
/* done 与 idle 区分（done=中性灰；与 dashboard/herdr-tab 一致） */
.pl-state[data-state=done] { color: var(--dsw-alias-label-tertiary); }
.pl-state[data-state=warning] { color: var(--dsw-alias-state-warn-primary); }
.pl-state[data-state=error] { color: var(--dsw-alias-state-error-primary); }
.pl-self-tag,
.herdr-pcard-self-tag {
  font-size: 9.5px; line-height: 14px; font-weight: 600; flex: none;
  color: var(--dsw-alias-state-business-primary);
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 4px; padding: 0 4px;
}
/* 折叠态：仅 Herdr logo 圆钮 */
.pane-list-min {
  position: fixed; top: 56px; right: 16px; z-index: 30;
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 50%;
  box-shadow: var(--dsw-shadow-lv2);
  cursor: grab;
  transition: background .15s var(--ds-ease-in-out), box-shadow .15s var(--ds-ease-in-out);
}
.pane-list-min:active { cursor: grabbing; }
.pane-list-min:hover { background: var(--dsw-alias-interactive-bg-hover); box-shadow: var(--dsw-shadow-lv3); }
.pane-list-min .logo-svg { width: 22px; height: 22px; display: block; color: var(--dsw-alias-label-primary); }
.pane-list-head .logo-svg { width: 16px; height: 16px; display: block; flex: none; color: var(--dsw-alias-label-tertiary); }
.pane-list-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; flex: none; padding: 0;
}
.pane-list-logo:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* 跳转定位高亮 */
.herdr-pane-flash {
  animation: herdr-pane-flash 1.4s var(--ds-ease-in-out);
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary);
}
@keyframes herdr-pane-flash {
  0% { box-shadow: 0 0 0 0 var(--dsw-alias-state-business-tertiary); }
  30% { box-shadow: 0 0 0 6px var(--dsw-alias-state-business-tertiary); }
  100% { box-shadow: 0 0 0 0 var(--dsw-alias-state-business-tertiary); }
}
/* ── 服务状态看板条 / 胶囊 / 安装提示 / hero 卡片 ─────────────── */
.herdr-server-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 10px;
  font-size: 12px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.herdr-conn-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.herdr-conn-dot.ok { background: var(--dsw-alias-state-success-primary); }
.herdr-conn-dot.bad { background: var(--dsw-alias-state-error-primary); }
.herdr-server-title { font-weight: 600; }
.herdr-server-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-left: auto; white-space: nowrap; }
.herdr-server-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); margin-top: 6px; }
.herdr-pane-list-error { padding: 0 12px 6px; font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.herdr-server-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.herdr-banner-stopped { border-color: var(--dsw-alias-state-warn-secondary); background: var(--dsw-alias-state-warn-tertiary); }
.herdr-banner-running { border-color: var(--dsw-alias-state-success-secondary); background: var(--dsw-alias-state-success-tertiary); }
.herdr-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 999px; padding: 3px 10px; cursor: default;
}
.herdr-pill button {
  border: none; background: none; color: inherit;
  font-size: 11px; font-weight: 600; padding: 0; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.herdr-pill button:hover { color: var(--dsw-alias-label-primary); }
.herdr-pill button:disabled { opacity: .55; cursor: default; }
.herdr-install {
  font-size: 12px; color: var(--dsw-alias-label-primary);
  padding: 10px 12px; border-radius: 10px;
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  line-height: 20px;
}
.herdr-install-title { font-weight: 600; margin-bottom: 4px; color: var(--dsw-alias-state-warn-label); }
.herdr-install code {
  font-family: var(--ds-font-family-code);
  font-size: 11px; background: var(--dsw-alias-bg-module-platform);
  border-radius: 4px; padding: 1px 6px; user-select: all;
}
.herdr-install a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.herdr-install a:hover { text-decoration: underline; }

/* ── herdr 模式门控与 Tab logo（design: herdr-mode-gating） ─────────────────
 * 门控锚点 data-herdr-mode 由 src/web/mode.ts 镜像到 <html>；
 * herdr-tab class 由 src/web/tab-controller.ts 打在 tablist 的 Herdr 按钮上。
 * 非 herdr（含初始未决）会话隐藏 tab；label 文字以 font-size:0 隐藏，
 * 保留 textContent 供 a11y（aria-label）与 DOM 匹配，::before 以 CSS mask
 * 渲染 herdr logo（currentColor 随主题取色）。 */
:root {
  --herdr-logo-mask: url("${herdrLogoMaskUrl()}");
}
html:not([data-herdr-mode='1']) .herdr-tab { display: none; }
.herdr-tab { font-size: 0; line-height: 0; }
.herdr-tab::before {
  content: '';
  display: inline-block;
  width: 16px;
  height: 16px;
  vertical-align: middle;
  background: currentColor;
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
}

/* ── herdr 模式新会话品牌化（design: herdr-hero-branding）───────────────────
 * 门控：html[data-herdr-mode='1']（mode.ts 镜像，hero 相位同样适用）+
 *       [data-phase='hero']（shell ConversationRoot 的相位属性）；
 * 标记类由 src/web/hero-branding.ts 打上（fish 座位 / 标题文本 span / 标题容器）。
 * 品牌紫：herdr.dev 官网两套主题的 --spot（paper #8839ef / ink #cba6f7），
 * 随 DSH 深色主题标记 body[data-ds-dark-theme]（ui-theme 宿主写入）切换。
 * logo 居中适配：herdr path 在 512 画布内实际分布偏右 +10.18%、偏下 +13.58%
 * （getBBox 实测，设计文档 §4.3.3）——fish 占满 34×25 画布天然居中；
 * 以 transform 平移把图形重心拉回座位中心（百分比相对 ::before 自身 30×30）。 */
:root {
  --herdr-brand: ${HERDR_BRAND_LIGHT};
  --herdr-brand-glow: ${HERDR_BRAND_GLOW_LIGHT};
}
body[data-ds-dark-theme] {
  --herdr-brand: ${HERDR_BRAND_DARK};
  --herdr-brand-glow: ${HERDR_BRAND_GLOW_DARK};
}

/* 需求 1：新会话输入卡紫色边框（data-composer-card 为稳定属性，无需打标；
   保持 1px 不跳布局，叠加外圈与柔和辉光，辉光为视觉验收项可移除）。
   过渡：无条件 transition 挂在卡片上，模式双向切换均平滑（herdr 规则只改值） */
[data-phase='hero'] [data-composer-card] {
  transition:
    border-color .35s var(--ds-ease-in-out, ease),
    box-shadow .35s var(--ds-ease-in-out, ease);
}
html[data-herdr-mode='1'] [data-phase='hero'] [data-composer-card],
html[data-herdr-hero='1'] [data-phase='hero'] [data-composer-card] {
  border-color: var(--herdr-brand);
  box-shadow:
    var(--dsw-shadow-lv2, 0 4px 16px rgba(0, 0, 0, 0.08)),
    0 0 0 1px var(--herdr-brand),
    0 0 28px var(--herdr-brand-glow);
}

/* 需求 2a：fish 与 herdr logo 常驻并存 + 交叉淡入淡出（模式切换过渡）。
   - fish svg 绝对定位居中于座位 span（布局由 ::before 恒占 30×30 决定，
     两种模式布局恒定、行高/图形位置不跳，居中适配值保持不变）；
   - ::before 默认 opacity 0（透明常驻），herdr 时 1 —— 双向都可过渡；
   - DOM 顺序 ::before 先于 svg 渲染，淡出 fish 即显露下层 logo。 */
[data-phase='hero'] .herdr-hero-fish { position: relative; }
[data-phase='hero'] .herdr-hero-fish svg {
  position: absolute;
  width: 34px;
  height: 25px;
  left: calc(50% - 17px);      /* 居中于座位（不依赖 span 是否 stretch） */
  top: calc(50% - 12.5px);
  opacity: 1; /* 显式基础值：模式切回时从 0 过渡回 1（回退到隐式 UA 值不触发过渡） */
  transition: opacity .35s var(--ds-ease-in-out, ease);
}
[data-phase='hero'] .herdr-hero-fish::before {
  content: '';
  display: block;
  width: 30px;
  height: 30px;
  background: var(--herdr-brand);
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
  /* 水平：图形在 512 画布内偏右 +10.18% → 平移回列中心；
     垂直：图形偏下 +13.58% → 平移回行中心，再额外上移 2px（-6.67%）
     对齐 fish 的视觉位置（用户反馈 logo 偏下，视觉验收值；如需微调改此处） */
  transform: translate(-10.18%, -20.25%);
  opacity: 0;
  transition: opacity .35s var(--ds-ease-in-out, ease);
}
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-fish svg,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-fish svg { opacity: 0; }
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-fish::before,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-fish::before { opacity: 1; }

/* 需求 2b：标题分段替换（文案常量来自 hero-branding.ts，修改需同步该文件）：
   ::before = 「Herdr 助你」品牌特效；::after = 「探索未至之境」原字体原色
   （color / font-weight 继承自 headline，仅显式恢复 font-size）。
   过渡：新文案淡入上浮（::after 级联延迟 .08s），原文本 font-size:0 即时隐藏 */
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text { font-size: 0; }
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::before,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text::before {
  content: '${HERDR_HERO_TEXT_BRAND}';
  font-size: 26px;
  line-height: 32px;
  font-weight: 500;
  color: var(--herdr-brand);
  text-shadow: 0 0 18px var(--herdr-brand-glow);
  white-space: nowrap;
  animation: herdr-text-in .35s var(--ds-ease-in-out, ease) both;
}
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::after,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text::after {
  content: '${HERDR_HERO_TEXT_PLAIN}';
  font-size: 26px;
  line-height: 32px;
  white-space: nowrap;
  animation: herdr-text-in .35s var(--ds-ease-in-out, ease) .08s both;
}
@keyframes herdr-text-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 英文界面（design: herdr-hero-branding §4.6）：文案随 data-herdr-lang
   （hero-branding.ts 按 locale 服务 active 设置；DSH 的 html lang 是静态的不可依赖）。
   仅覆盖 content，动画/过渡参数沿用中文版。 */
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::before,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::before {
  content: '${HERDR_HERO_TEXT_BRAND_EN}';
}
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::after,
html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::after {
  content: '${HERDR_HERO_TEXT_PLAIN_EN}';
}

/* 减弱动效偏好（prefers-reduced-motion）：关闭过渡与动画，切换即时生效 */
@media (prefers-reduced-motion: reduce) {
  [data-phase='hero'] [data-composer-card],
  [data-phase='hero'] .herdr-hero-fish svg,
  [data-phase='hero'] .herdr-hero-fish::before {
    transition: none;
  }
  html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::before,
  html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::after,
  html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text::before,
  html[data-herdr-hero='1'] [data-phase='hero'] .herdr-hero-text::after {
    animation: none;
  }
}

/* 新建会话「选择模式」中 Herdr 模式芯片前的图标替换为 Herdr logo（与 hero 鱼标 mask 同源） */
.herdr-preset-logo {
  width: 16px;
  height: 16px;
  display: inline-block;
  flex: none;
  flex-shrink: 0;
  background: var(--herdr-brand);
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
}
.herdr-preset-logo svg,
.herdr-preset-logo path,
.herdr-preset-logo circle,
.herdr-preset-logo rect,
.herdr-preset-logo use,
.herdr-preset-logo img {
  display: none;
}
svg.herdr-preset-logo {
  background: var(--herdr-brand);
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
}
svg.herdr-preset-logo > * {
  display: none;
}

/* ── Herdr Dashboard（design: dashboard §5.5；全部使用 DSH token：herdr-* / dsw-alias-*） ── */
.herdr-dash {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 12px 20px; box-sizing: border-box;
  width: 100%; max-width: none; margin: 0;
}
@media (min-width: 1600px) {
  .herdr-dash { max-width: 1440px; margin: 0 auto; }
}
/* KPI 条：窄屏自动折行成多列 */
.herdr-dash-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.herdr-dash-kpi {
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.herdr-dash-kpi-value {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 22px; font-weight: 600; line-height: 30px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
/* Working 用品牌紫（语义优先于品牌的红留给 Blocked） */
.herdr-dash-kpi-working .herdr-dash-kpi-value { color: var(--herdr-brand); }
.herdr-dash-kpi-blocked .herdr-dash-kpi-value { color: var(--dsw-alias-state-error-primary); }
.herdr-dash-kpi-label {
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
/* Blocked > 0 时的小脉冲点（复用 herdr-state-pulse；reduced-motion 关闭） */
.herdr-dash-kpi-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-error-primary);
  animation: herdr-state-pulse 1.4s var(--ds-ease-in-out) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .herdr-dash-kpi-dot { animation: none; }
}
/* 摘要卡片网格：窄屏自动单列 */
.herdr-dash-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.herdr-dash-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.herdr-dash-card-title {
  font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.herdr-dash-row {
  display: flex; align-items: baseline; gap: 8px; min-width: 0;
}
.herdr-dash-row-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); flex: none; }
.herdr-dash-row-value {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  font-variant-numeric: tabular-nums;
}
.herdr-dash-code {
  font-family: var(--ds-font-family-code); font-size: 11px;
}
.herdr-dash-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 1px 8px; white-space: nowrap;
}
.herdr-dash-chip b { font-weight: 600; font-variant-numeric: tabular-nums; }
.herdr-dash-chip[data-state='working'] { color: var(--dsw-alias-state-business-primary); }
.herdr-dash-chip[data-state='blocked'] { color: var(--dsw-alias-state-error-primary); }
.herdr-dash-chip[data-state='idle'] { color: var(--dsw-alias-state-success-primary); }
/* done 从成功绿改为中性灰（dashboard-redesign：done≠idle） */
.herdr-dash-chip[data-state='done'] { color: var(--dsw-alias-label-tertiary); }
/* 数据新鲜度徽标 / 最近错误行（新鲜度时间与刷新按钮已上移至 surface header） */
.herdr-dash-stale-badge {
  font-size: 11px; line-height: 16px; font-weight: 600; flex: none;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
  border-radius: 999px; padding: 0 8px;
}
.herdr-dash-last-error {
  font-size: 11px; color: var(--dsw-alias-state-error-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  max-width: min(36rem, 100%);
}
/* workspace 列表 */
.herdr-dash-section { display: flex; flex-direction: column; gap: 6px; }
.herdr-dash-section-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.herdr-dash-section-count {
  margin-left: auto; font-size: 11px; line-height: 16px; font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-ws {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
/* workspace 卡片网格：≥480px 双列，窄屏自动单列 */
.herdr-dash-ws-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 10px;
}
/* workspace 卡片不可点击（关闭 surface 由 header ✕ 承担） */
.herdr-dash-ws-card {
  padding: 8px 12px 10px;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-dash-ws-head {
  display: flex; flex-direction: column; gap: 4px;
  padding: 0 0 6px;
  user-select: none;
}
.herdr-dash-ws-line1 {
  display: flex; align-items: center; gap: 8px; min-width: 0;
}
.herdr-dash-ws-line2 {
  display: flex; align-items: center; gap: 8px; min-width: 0;
}
.herdr-dash-ws-line1 .herdr-dash-ws-chips {
  margin-left: auto; margin-top: 0; flex: none;
  justify-content: flex-end;
}
.herdr-dash-ws-label {
  font-size: 13px; line-height: 20px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  flex: 1;
}
.herdr-dash-ws-id {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; flex: none;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform);
  border-radius: 5px; padding: 0 6px;
}
/* checkout 路径：等宽、三级灰、超长省略（title 见全值） */
.herdr-dash-ws-meta {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0; flex: 1;
}
.herdr-dash-ws-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
/* ── workspace Treemap（矩形树图：按 kind 计数面积，块可点击跳转） ── */
.herdr-tm {
  position: relative;
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
  outline: none;
  margin-top: 6px;
}
.herdr-tm-block {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-bg-layer-1);
  border-radius: 4px;
  background: var(--dsw-alias-state-info-primary);
  cursor: pointer;
}
.herdr-tm-block:hover,
.herdr-tm-block:focus-visible {
  filter: brightness(1.15);
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: 1px;
}
.herdr-tm-block:active { filter: brightness(0.9); }
.herdr-tm-label {
  font-family: var(--ds-font-family-code);
  font-size: 10px; line-height: 14px;
  color: var(--dsw-alias-bg-base);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: calc(100% - 4px);
  pointer-events: none;
}
.herdr-tm-block[data-kind='codex'] { background: var(--dsw-alias-state-business-primary); }
.herdr-tm-block[data-kind='pi'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-tm-block[data-kind='opencode'] { background: var(--dsw-alias-state-success-primary); }
.herdr-tm-block[data-kind='claude'] { background: var(--dsw-alias-state-success-primary); }
.herdr-tm-block[data-kind='kimi'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='droid'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='devin'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='kilo'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='copilot'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='cursor'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='antigravity_cli'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='grok'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='hermes'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='mastracode'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='omp'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='qodercli'] { background: var(--dsw-alias-state-info-primary); }
.herdr-tm-block[data-kind='dsh'] { background: var(--dsw-alias-label-tertiary); }
.herdr-tm-block[data-kind='unknown'] { background: var(--dsw-alias-label-tertiary); }
.herdr-tm-empty {
  display: flex; align-items: center; justify-content: center;
  height: 96px;
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 8px;
  margin-top: 6px;
}
/* 状态堆积条（dashboard workspace 卡片；段宽按 flex-grow=计数，最小 4px） */
.herdr-dash-bar {
  display: flex;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
  width: 100%; height: 16px;
  border-radius: 8px;
}
.herdr-dash-bar-seg {
  min-width: 4px; flex-shrink: 0;
}
.herdr-dash-bar-seg[data-state='working'] { background: var(--dsw-alias-state-business-primary); }
.herdr-dash-bar-seg[data-state='blocked'] { background: var(--dsw-alias-state-error-primary); }
.herdr-dash-bar-seg[data-state='idle'] { background: var(--dsw-alias-state-success-primary); }
.herdr-dash-bar-seg[data-state='done'] { background: var(--dsw-alias-label-tertiary); }
.herdr-dash-bar-seg[data-state='unknown'] { background: var(--dsw-alias-border-l2); }
/* kind chips：复用 .herdr-dash-agent-dot 的 data-kind 颜色映射 */
.herdr-dash-kind-chips {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 2px;
}
.herdr-dash-kind-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-kind-chip b {
  font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
/* ── v5：workspace 卡片 ✕ 关闭（hover 显现，对照 .herdr-pcard-close） ── */
.herdr-dash-ws-actions {
  display: inline-flex; align-items: center; gap: 2px;
  margin-left: 4px; flex: none;
}
.herdr-dash-ws-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; flex: none;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 16px; cursor: pointer;
  opacity: 0; transition: opacity .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-dash-ws-card:hover .herdr-dash-ws-close,
.herdr-dash-ws-close:focus-visible { opacity: 1; }
.herdr-dash-ws-close:hover { background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); }
.herdr-dash-ws-close:disabled { opacity: .4; cursor: default; }
/* ── v5：workspace 卡片可展开 pane 列表（点击跳转 / ✕ 关闭） ── */
.herdr-dash-pane-count { color: var(--dsw-alias-label-tertiary); }
.herdr-dash-pane-list {
  display: flex; flex-direction: column; gap: 2px;
  margin-top: 4px;
  padding: 4px;
  box-sizing: border-box;
  max-height: 200px;
  overflow-y: auto; overflow-x: hidden;
  border-top: 1px solid var(--dsw-alias-border-l1);
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.herdr-dash-pane-list::-webkit-scrollbar { width: 6px; }
.herdr-dash-pane-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.herdr-dash-pane-row {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 11px; line-height: 18px;
  border-radius: 6px; padding: 1px 4px;
}
.herdr-dash-pane-row[role='button'] { cursor: pointer; }
.herdr-dash-pane-row[role='button']:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-dash-pane-row[role='button']:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: -1px;
}
.herdr-dash-pane-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.herdr-dash-pane-dot[data-state='working'] { background: var(--dsw-alias-state-business-primary); }
.herdr-dash-pane-dot[data-state='blocked'] { background: var(--dsw-alias-state-error-primary); }
.herdr-dash-pane-dot[data-state='idle'] { background: var(--dsw-alias-state-success-primary); }
.herdr-dash-pane-dot[data-state='done'] { background: var(--dsw-alias-label-tertiary); }
.herdr-dash-pane-dot[data-state='unknown'] { background: var(--dsw-alias-border-l2); }
.herdr-dash-pane-name {
  color: var(--dsw-alias-label-secondary); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.herdr-dash-pane-kind {
  flex: none; font-family: var(--ds-font-family-code); font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-pane-status {
  margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-pane-status[data-state='working'] { color: var(--dsw-alias-state-business-primary); }
.herdr-dash-pane-status[data-state='blocked'] { color: var(--dsw-alias-state-error-primary); }
.herdr-dash-pane-status[data-state='done'] { color: var(--dsw-alias-label-tertiary); }
.herdr-dash-pane-status[data-state='idle'] { color: var(--dsw-alias-state-success-primary); }
.herdr-dash-pane-actions {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
}
.herdr-dash-pane-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; flex: none;
  border: none; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px; line-height: 14px; cursor: pointer;
  opacity: 0; transition: opacity .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-dash-pane-row:hover .herdr-dash-pane-close,
.herdr-dash-pane-close:focus-visible { opacity: 1; }
.herdr-dash-pane-close:hover { background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); }
.herdr-dash-pane-close:disabled { opacity: .4; cursor: default; }
/* ── Agents 全名称列表（v4 需求 4；长列表滚动 + 显示全部） ── */
.herdr-dash-agent-list {
  list-style: none;
  margin: 0;
  /* 4px 水平内边距补偿可点击行的 hover 内缩（负 margin 会造成横向滚动条） */
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 176px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.herdr-dash-agent-list[data-collapsed] { max-height: 176px; }
.herdr-dash-agent-list::-webkit-scrollbar { width: 6px; }
.herdr-dash-agent-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }
.herdr-dash-agent-row {
  display: flex; align-items: center; gap: 6px;
  min-width: 0;
  font-size: 11px; line-height: 18px;
}
.herdr-dash-agent-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-info-primary);
}
.herdr-dash-agent-dot[data-kind='codex'] { background: var(--dsw-alias-state-business-primary); }
.herdr-dash-agent-dot[data-kind='pi'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-dash-agent-dot[data-kind='opencode'] { background: var(--dsw-alias-state-success-primary); }
.herdr-dash-agent-dot[data-kind='claude'] { background: var(--dsw-alias-state-success-primary); }
.herdr-dash-agent-dot[data-kind='kimi'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='droid'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='devin'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='kilo'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='copilot'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='cursor'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='antigravity_cli'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='grok'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='hermes'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='mastracode'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='omp'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='qodercli'] { background: var(--dsw-alias-state-info-primary); }
.herdr-dash-agent-dot[data-kind='dsh'],
.herdr-dash-agent-dot[data-kind='unknown'] { background: var(--dsw-alias-label-tertiary); }
.herdr-dash-agent-name {
  color: var(--dsw-alias-label-secondary); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.herdr-dash-agent-kind {
  flex: none; font-family: var(--ds-font-family-code); font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-agent-status {
  margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-agent-status[data-state='working'] { color: var(--dsw-alias-state-business-primary); }
.herdr-dash-agent-status[data-state='blocked'] { color: var(--dsw-alias-state-error-primary); }
.herdr-dash-agent-status[data-state='done'] { color: var(--dsw-alias-label-tertiary); }
.herdr-dash-agent-status[data-state='idle'] { color: var(--dsw-alias-state-success-primary); }
/* 代理行可点击（仅当 onPaneClick 存在，role=button 条件渲染） */
.herdr-dash-agent-row[role='button'] {
  cursor: pointer;
  border-radius: 6px;
  padding: 1px 4px;
  margin: 0;
}
.herdr-dash-agent-row[role='button']:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.herdr-dash-agent-row[role='button']:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, var(--dsw-alias-state-info-primary));
  outline-offset: -1px;
}
.herdr-dash-link-btn {
  align-self: flex-start;
  border: none; background: none; padding: 2px 0;
  font-size: 11px; font-weight: 500; cursor: pointer;
  color: var(--dsw-alias-state-business-primary);
}
.herdr-dash-link-btn:hover { text-decoration: underline; text-underline-offset: 2px; }
/* 进程 unavailable / best-effort 注记（并入 Herdr 服务卡片，v4 需求 5） */
.herdr-dash-process-unavail {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label);
}
.herdr-dash-process-note {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
}
/* 窄屏：workspace 卡片 meta 隐藏（避免横向溢出）；header 新鲜度时间隐藏（保留刷新按钮） */
@media (max-width: 720px) {
  .herdr-dash-ws-meta { display: none; }
  .herdr-gds-fresh-time { display: none; }
}
@media (max-width: 480px) {
  .herdr-gds-head { align-items: flex-start; flex-wrap: wrap; padding: 6px 12px; }
  .herdr-gds-title { font-size: 13px; }
  .herdr-gds-state { flex: 1 0 100%; font-size: 11px; margin-left: 8px; }
  .herdr-dash-last-error { flex: 1 0 100%; max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
}
/* ── 加载骨架屏与空态（dashboard-redesign：loading 3 块脉冲卡片；空态 logo） ── */
.herdr-dash-loading {
  display: flex; flex-direction: column; gap: 10px;
}
.herdr-dash-skeleton {
  height: 96px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  animation: herdr-state-pulse 1.4s var(--ds-ease-in-out) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .herdr-dash-skeleton { animation: none; }
}
.herdr-dash-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 28px 16px; text-align: center;
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-dash-empty-logo {
  width: 28px; height: 28px; display: block;
  color: var(--dsw-alias-label-tertiary);
}
/* 视觉隐藏（loading 文案兜底，不占布局） */
.herdr-visually-hidden {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
/* ── 五态 panel list 状态文本 token（pane-list 浮层共用） ─── */
.pl-state[data-state=working] { color: var(--dsw-alias-state-business-primary); }
.pl-state[data-state=blocked] { color: var(--dsw-alias-state-error-primary); }
.pl-state[data-state=idle] { color: var(--dsw-alias-state-success-primary); }
/* done 与 idle 区分（done=中性灰；与 dashboard/herdr-tab 一致） */
.pl-state[data-state=done] { color: var(--dsw-alias-label-tertiary); }
.pl-state[data-state=unknown] { color: var(--dsw-alias-label-tertiary); }
/* ── 减弱动效偏好：关闭 live pulse 和 pane flash ──── */
@media (prefers-reduced-motion: reduce) {
  .herdr-log-live { animation: none; }
  .herdr-pane-flash { animation: none; }
}

/* ── 全局 Dashboard 入口与右侧工作区 surface（design: dashboard-global v3） ──
   按钮为 sidebar 文档流内的 marker（v3 不再有 fixed 悬浮按钮）；rail/wide 由
   data-rail 切换；surface 从 sidebar 右边界覆盖右侧工作区（left/top/宽高内联）。 */
.herdr-sb-marker {
  flex: none;
  min-width: 0;
  width: auto;
  margin: 0 2px 8px;
  box-sizing: border-box;
}
.herdr-sb-marker[data-rail] {
  align-self: flex-start;
  width: 36px;
  margin: 0 0 12px;
}
.herdr-sb-marker-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 38px;
  padding: 8px 16px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  transition: background .12s var(--ds-ease-in-out), border-color .12s var(--ds-ease-in-out);
}
.herdr-sb-marker-button:hover {
  background: var(--dsw-alias-button-floating-hover);
}
.herdr-sb-marker-button[aria-pressed='true'] {
  border-color: var(--dsw-alias-state-business-secondary);
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
}
.herdr-sb-marker[data-rail] .herdr-sb-marker-button {
  width: 36px;
  height: 36px;
  padding: 0;
  gap: 0;
  border-color: transparent;
  background: transparent;
}
.herdr-sb-marker[data-rail] .herdr-sb-marker-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.herdr-sb-marker-icon {
  width: 18px;
  height: 18px;
  display: none;
  flex: none;
  color: currentColor;
  background: currentColor;
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
}
.herdr-sb-marker[data-rail] .herdr-sb-marker-icon {
  display: block;
}
/* v4 需求 2：marker 三态状态点（颜色 + 文本 title，颜色不是唯一信息） */
.herdr-sb-marker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.herdr-sb-marker-dot[data-state='running'] { background: var(--dsw-alias-state-success-primary); }
.herdr-sb-marker-dot[data-state='stopped'] { background: var(--dsw-alias-label-tertiary); }
.herdr-sb-marker-dot[data-state='not-installed'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-sb-marker-dot[data-state='checking'] {
  background: var(--dsw-alias-label-tertiary);
  animation: herdr-state-pulse 1.4s var(--ds-ease-in-out) infinite;
}
@keyframes herdr-state-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .3; }
}
@media (prefers-reduced-motion: reduce) {
  .herdr-sb-marker-dot[data-state='checking'] { animation: none; }
}
.herdr-sb-marker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.herdr-sb-marker[data-rail] .herdr-sb-marker-label { display: none; }
/* 右侧工作区 surface：opaque、全高、独立滚动；不覆盖 sidebar（left 由测量内联） */
.herdr-gds {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  outline: none;
  border-left: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-shadow-lv2);
}
.herdr-gds-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 8px 16px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}
.herdr-gds-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
}
/* v4 需求 3：header 状态行（状态点 + 文本 + 版本 + 启动按钮） */
.herdr-gds-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  min-width: 0;
}
.herdr-state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.herdr-state-dot[data-state='running'] { background: var(--dsw-alias-state-success-primary); }
.herdr-state-dot[data-state='stopped'] { background: var(--dsw-alias-label-tertiary); }
.herdr-state-dot[data-state='not-installed'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-state-dot[data-state='checking'] {
  background: var(--dsw-alias-label-tertiary);
  animation: herdr-state-pulse 1.4s var(--ds-ease-in-out) infinite;
}
.herdr-gds-version {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.herdr-gds-start-error {
  font-size: 11px;
  color: var(--dsw-alias-state-error-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* pane 跳转/定位内联提示（header 下方，3s 自动消失） */
.herdr-gds-notice {
  flex: none;
  margin: 0 16px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}
.herdr-gds-logo {
  width: 18px;
  height: 18px;
  display: block;
  flex: none;
  color: var(--herdr-brand);
}
/* header 新鲜度组：最近更新 + 过期徽标 + 刷新按钮（状态组与 ✕ 之间，右对齐） */
.herdr-gds-fresh {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  flex: none;
  white-space: nowrap;
}
/* 新鲜度组存在时 ✕ 不再自行右推（组已右对齐） */
.herdr-gds-fresh + .herdr-gds-close { margin-left: 0; }
.herdr-gds-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  flex: none;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  cursor: pointer;
}
.herdr-gds-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.herdr-gds-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;
}
.herdr-gds-body::-webkit-scrollbar { width: 6px; }
.herdr-gds-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 3px; }

/* ── floating viewer ── */
.pane-list-viewer {
  display: flex; flex-direction: column; gap: 8px;
  flex: 1; min-height: 280px; max-height: 52vh;
  overflow: hidden; padding: 0; box-sizing: border-box;
  transition: min-height .25s var(--ds-ease-in-out, ease), height .25s var(--ds-ease-in-out, ease), aspect-ratio .25s var(--ds-ease-in-out, ease);
}
@media (prefers-reduced-motion: reduce) {
  .pane-list-viewer { transition: none; }
}
.pane-list-viewer-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab;
  background: var(--dsw-alias-bg-layer-1);
}
.pane-list-viewer-head:active { cursor: grabbing; }
.pane-list-viewer-title {
  flex: 1; font-size: 13px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary);
}
.pane-list-viewer-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px; cursor: pointer;
}
.pane-list-viewer-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pane-list-viewer-body {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden; padding: 6px;
  background: var(--dsw-alias-bg-layer-1);
}
.pane-list-viewer-body .herdr-term {
  flex: 1; min-height: auto; width: 100%; height: auto; aspect-ratio: 9 / 6; max-height: calc(100vh - 72px);
}
.pl-row[data-disabled] { opacity: .45; cursor: not-allowed; }
.pl-row[data-disabled]:hover { background: transparent; }

`
  document.head.appendChild(style)
}

export {}
