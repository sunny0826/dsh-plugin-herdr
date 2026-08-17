// 本会话绑定 pane 查询（/herdr-session-pane）：HerdrView 与 HerdrPaneList 共用。
// 服务端优先查绑定 registry，未命中时兜底查 herdr 中带标记（label = dsh:<agent>）
// 的 pane（进程重启/插件重载后 registry 内存清空的恢复路径）。

/** 查询本会话绑定 pane；未绑定/查询失败返回 null。 */
export async function fetchSelfPaneId(sessionId: string): Promise<string | null> {
  try {
    const resp = await fetch('/herdr-session-pane?agent=' + encodeURIComponent(sessionId))
    if (!resp.ok) return null
    const d = (await resp.json()) as { pane_id?: string | null }
    return d.pane_id ?? null
  } catch {
    return null
  }
}

/** 反查 pane 所属会话（/herdr-pane-session）；无归属/查询失败返回 null。 */
export async function fetchPaneSession(paneId: string): Promise<string | null> {
  try {
    const resp = await fetch('/herdr-pane-session?pane=' + encodeURIComponent(paneId))
    if (!resp.ok) return null
    const d = (await resp.json()) as { session_id?: string | null }
    return d.session_id ?? null
  } catch {
    return null
  }
}
