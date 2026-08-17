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
.herdr-head-stats { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.herdr-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.herdr-ws-list { display: flex; flex-direction: column; gap: 2px; }
.herdr-ws { border-radius: 12px; }
.herdr-ws + .herdr-ws { margin-top: 12px; }
.herdr-ws-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 10px; cursor: pointer;
  user-select: none;
}
.herdr-ws-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.herdr-ws-chev {
  width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); flex: none;
  transition: transform .15s var(--ds-ease-in-out);
}
.herdr-ws[data-collapsed] .herdr-ws-chev { transform: rotate(-90deg); }
.herdr-ws-label { font-size: 14px; line-height: 22px; font-weight: 500; }
.herdr-ws-id {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform);
  border-radius: 5px; padding: 0 6px;
}
.herdr-ws-stats { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.herdr-ws-stats b { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.herdr-ws-name { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.herdr-ws-name .herdr-ws-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ws 组头操作按钮（T11 ✕ / T12 ✎）：hover 显现 */
.herdr-ws-close,
.herdr-ws-edit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; flex: none;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 16px; cursor: pointer;
  opacity: 0; transition: opacity .12s var(--ds-ease-in-out), background .12s var(--ds-ease-in-out), color .12s var(--ds-ease-in-out);
}
.herdr-ws-head:hover .herdr-ws-close,
.herdr-ws-head:hover .herdr-ws-edit { opacity: 1; }
.herdr-ws-edit:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.herdr-ws-close:hover { background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); }
.herdr-ws-close:disabled,
.herdr-ws-edit:disabled { opacity: .4; cursor: default; }
/* ws 组头 rename inline input */
.herdr-ws-rename-input {
  font-family: var(--dsw-font-family); font-size: 14px; line-height: 22px;
  font-weight: 500; min-width: 0; max-width: 240px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-module-platform);
  border: 1px solid var(--dsw-alias-state-business-primary);
  border-radius: 6px; padding: 0 6px; box-sizing: border-box;
}
.herdr-ws-rename-input:focus { outline: none; }
.herdr-ws-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  /* 卡片按内容高度（收起=矮、展开=高），不跨行拉伸，否则收起态被同行最高卡片撑住 */
  align-items: start;
  padding: 2px 0 6px 4px;
}
.herdr-ws[data-collapsed] .herdr-ws-body { display: none; }
@media (max-width: 640px) {
  .herdr-ws-body { grid-template-columns: minmax(0, 1fr); }
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
.herdr-dot-muted { opacity: .35; }

/* ── pane 卡片（PaneCard，纵向；T06） ──────────────────────────────── */
.herdr-pcard {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px 8px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  min-height: 132px;
  box-sizing: border-box;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-pcard[data-focused] { border-color: var(--dsw-alias-state-business-primary); }
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
.herdr-pcard-cwd {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

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
/* 卡片 header agent 徽章色点 */
.herdr-agent-accent {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.herdr-agent-accent[data-accent='codex'] { background: var(--dsw-alias-state-business-primary); }
.herdr-agent-accent[data-accent='pi'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-agent-accent[data-accent='claude'] { background: var(--dsw-alias-state-success-primary); }
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
.herdr-pcard-foot {
  display: flex; align-items: center; gap: 8px;
  flex: none;
}
.herdr-pcard-foot-btn {
  border: none; background: none; padding: 0;
  font-size: 12px; font-weight: 500; cursor: pointer;
  color: var(--dsw-alias-state-business-primary);
}
.herdr-pcard-foot-btn:hover { text-decoration: underline; text-underline-offset: 2px; }
.herdr-pcard-foot-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.herdr-pcard-empty {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  margin-left: 4px;
}
.herdr-state-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.herdr-state-text[data-state=done] { color: var(--dsw-alias-state-success-primary); }
.herdr-state-text[data-state=warning] { color: var(--dsw-alias-state-warn-primary); }
.herdr-state-text[data-state=error] { color: var(--dsw-alias-state-error-primary); }
.herdr-agent-pill .herdr-agent-name { font-weight: 500; }
.herdr-empty {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  padding: 28px 16px; text-align: center; line-height: 20px;
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
  position: fixed; top: 56px; right: 16px; width: 264px; z-index: 30;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 14px;
  box-shadow: var(--dsw-shadow-lv2);
  display: flex; flex-direction: column;
  max-height: calc(100vh - 72px);
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
.pl-row[data-self] { background: var(--dsw-alias-state-business-tertiary); }
.pl-row[data-self]:hover { background: var(--dsw-alias-interactive-bg-hover-accent); }
.pl-paneid { font-family: var(--ds-font-family-code); font-size: 11.5px; line-height: 16px; font-weight: 500; }
.pl-agent { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-state { margin-left: auto; font-size: 11px; line-height: 16px; flex: none; }
.pl-state[data-state=done] { color: var(--dsw-alias-state-success-primary); }
.pl-state[data-state=warning] { color: var(--dsw-alias-state-warn-primary); }
.pl-state[data-state=error] { color: var(--dsw-alias-state-error-primary); }
.pl-self-tag {
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
.herdr-server-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.herdr-banner-stopped { border-color: var(--dsw-alias-state-warn-secondary); background: var(--dsw-alias-state-warn-tertiary); }
.herdr-banner-running { border-color: var(--dsw-alias-state-success-secondary); background: var(--dsw-alias-state-success-tertiary); }
.herdr-hero-card {
  position: fixed; top: 56px; right: 16px; width: 320px; z-index: 30;
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3);
}
.herdr-hero-card .herdr-server-banner { border-radius: 12px; }
.herdr-hero-card .herdr-server-error { padding: 0 12px 8px; }
.herdr-hero-card .herdr-server-note { padding: 0 12px 8px; }
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
html[data-herdr-mode='1'] [data-phase='hero'] [data-composer-card] {
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
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-fish svg { opacity: 0; }
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-fish::before { opacity: 1; }

/* 需求 2b：标题分段替换（文案常量来自 hero-branding.ts，修改需同步该文件）：
   ::before = 「Herdr 助你」品牌特效；::after = 「探索未知之境」原字体原色
   （color / font-weight 继承自 headline，仅显式恢复 font-size）。
   过渡：新文案淡入上浮（::after 级联延迟 .08s），原文本 font-size:0 即时隐藏 */
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text { font-size: 0; }
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::before {
  content: '${HERDR_HERO_TEXT_BRAND}';
  font-size: 26px;
  line-height: 32px;
  font-weight: 500;
  color: var(--herdr-brand);
  text-shadow: 0 0 18px var(--herdr-brand-glow);
  white-space: nowrap;
  animation: herdr-text-in .35s var(--ds-ease-in-out, ease) both;
}
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::after {
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
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::before {
  content: '${HERDR_HERO_TEXT_BRAND_EN}';
}
html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text[data-herdr-lang='en']::after {
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
  html[data-herdr-mode='1'] [data-phase='hero'] .herdr-hero-text::after {
    animation: none;
  }
}

/* ── Herdr Dashboard（design: dashboard §5.5；全部使用 DSH herdr-*/dsw-alias-* token） ── */
.herdr-dash {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 16px 24px; box-sizing: border-box;
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
/* 数据新鲜度行 */
.herdr-dash-fresh {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  min-width: 0;
}
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
}
.herdr-dash-actions { margin-left: auto; flex: none; }
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
.herdr-dash-ws + .herdr-dash-ws { margin-top: 6px; }
/* workspace 卡片不可点击（关闭 surface 由 header ✕ 承担） */
.herdr-dash-ws-card {
  padding: 8px 12px 10px;
  transition: border-color .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out);
}
.herdr-dash-ws-head {
  display: flex; align-items: center; gap: 8px;
  padding: 0 0 6px;
  user-select: none;
}
.herdr-dash-ws-label {
  font-size: 13px; line-height: 20px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.herdr-dash-ws-id {
  font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; flex: none;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform);
  border-radius: 5px; padding: 0 6px;
}
.herdr-dash-ws-meta {
  margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; flex: none;
}
.herdr-dash-ws-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
/* ── agent-kind Treemap（v4 需求 7；kind 色 token 映射，无硬编码色） ── */
.herdr-tm {
  position: relative;
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
  outline: none;
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
  background: var(--dsw-alias-label-tertiary);
  /* 可点击跳转（pane → 对应会话 Herdr Tab） */
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
.herdr-tm-block[data-kind='unknown'] { background: var(--dsw-alias-label-tertiary); }
.herdr-tm-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%;
  font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
/* ── Agents 全名称列表（v4 需求 4；长列表滚动 + 显示全部） ── */
.herdr-dash-agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 176px;
  overflow-y: auto;
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
  background: var(--dsw-alias-label-tertiary);
}
.herdr-dash-agent-dot[data-kind='codex'] { background: var(--dsw-alias-state-business-primary); }
.herdr-dash-agent-dot[data-kind='pi'] { background: var(--dsw-alias-state-warn-primary); }
.herdr-dash-agent-dot[data-kind='opencode'] { background: var(--dsw-alias-state-success-primary); }
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
.herdr-dash-agent-status[data-state='done'],
.herdr-dash-agent-status[data-state='idle'] { color: var(--dsw-alias-state-success-primary); }
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
/* 窄屏：workspace 卡片 meta 隐藏（避免横向溢出） */
@media (max-width: 640px) {
  .herdr-dash-ws-meta { display: none; }
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
  display: block;
  flex: none;
  color: currentColor;
  background: currentColor;
  -webkit-mask: var(--herdr-logo-mask) center / contain no-repeat;
  mask: var(--herdr-logo-mask) center / contain no-repeat;
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
  color: var(--dsw-alias-state-business-primary);
}
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

`
  document.head.appendChild(style)
}

export {}
