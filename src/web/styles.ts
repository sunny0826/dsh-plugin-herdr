// 样式注入（布局样式全部使用 DSH 真实 token；组件样式由 web shell 提供）。
// 顺序、内容与拆分前的 client.tsx 完全一致：模块加载时执行一次注入，
// 通过 STYLE_ID 检查避免重复（原样保留）。

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
`
  document.head.appendChild(style)
}

export {}
