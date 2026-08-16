// 服务状态看板条（会话页 Herdr Tab 顶部 + 新建会话浮层卡片复用）

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useHerdrStart } from './store.ts'
import type { HerdrStatusSnapshot } from './types.ts'

export function HerdrServerBanner({ snap, error, onStarted }: { snap: HerdrStatusSnapshot | null; error: string | null; onStarted?: () => void }) {
  const { starting, startError, start } = useHerdrStart()
  const server = snap?.server
  const cliAvailable = snap?.cli?.available !== false

  const handleStart = async () => {
    const ok = await start()
    if (ok) onStarted?.()
  }

  let body: ReactNode
  if (!snap) {
    body = (
      <>
        <span className="herdr-conn-dot" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
        <span className="herdr-server-title">检查 herdr 服务…</span>
      </>
    )
  } else if (error) {
    body = (
      <>
        <span className="herdr-conn-dot bad" />
        <span className="herdr-server-title">herdr 服务状态不可用</span>
        <span className="herdr-server-error">{error}</span>
      </>
    )
  } else if (!cliAvailable) {
    body = (
      <>
        <span className="herdr-conn-dot" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
        <span className="herdr-server-title">herdr CLI 未安装</span>
        <span className="herdr-server-note">安装后自动出现启动按钮</span>
      </>
    )
  } else if (server?.running) {
    body = (
      <>
        <span className="herdr-conn-dot ok" />
        <span className="herdr-server-title">herdr 服务运行中</span>
        <span className="herdr-server-meta">
          {server.version ? `v${server.version}` : ''}
          {server.session ? ` · ${server.session}` : ''}
          {snap ? ` · ${snap.agents.length} agent` : ''}
        </span>
      </>
    )
  } else {
    body = (
      <>
        <span className="herdr-conn-dot bad" />
        <span className="herdr-server-title">herdr 服务未启动</span>
        <Button variant="primary" size="sm" disabled={starting} onClick={() => void handleStart()}>
          {starting ? '启动中…' : '启动 herdr'}
        </Button>
      </>
    )
  }

  const bannerClass = !snap || error ? 'herdr-server-banner' : server?.running
    ? 'herdr-server-banner herdr-banner-running'
    : !cliAvailable
      ? 'herdr-server-banner'
      : server && (server.status === 'not_running' || server.status === 'unknown')
        ? 'herdr-server-banner herdr-banner-stopped'
        : 'herdr-server-banner'

  return (
    <div>
      <div className={bannerClass}>{body}</div>
      {startError ? <div className="herdr-server-error">启动失败：{startError}</div> : null}
    </div>
  )
}
