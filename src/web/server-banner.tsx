// 服务状态看板条（会话页 Herdr Tab 顶部 + 新建会话浮层卡片复用）

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { t, useHerdrLang } from './i18n.ts'
import { useHerdrStart } from './store.ts'
import type { HerdrStatusSnapshot } from './types.ts'

export function HerdrServerBanner({ snap, error, onStarted }: { snap: HerdrStatusSnapshot | null; error: string | null; onStarted?: () => void }) {
  // 语言订阅：切语言时状态文案/按钮跟随
  void useHerdrLang()
  const { starting, startError, start } = useHerdrStart()
  const server = snap?.server

  const handleStart = async () => {
    const ok = await start()
    if (ok) onStarted?.()
  }

  let body: ReactNode
  if (!snap) {
    body = (
      <>
        <span className="herdr-conn-dot" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
        <span className="herdr-server-title">{t('banner.checking')}</span>
      </>
    )
  } else if (error) {
    body = (
      <>
        <span className="herdr-conn-dot bad" />
        <span className="herdr-server-title">{t('banner.unavailable')}</span>
        <span className="herdr-server-error">{error}</span>
      </>
    )
  } else if (server?.running) {
    body = (
      <>
        <span className="herdr-conn-dot ok" />
        <span className="herdr-server-title">{t('banner.running')}</span>
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
        <span className="herdr-server-title">{t('banner.stopped')}</span>
        <Button variant="primary" size="sm" disabled={starting} onClick={() => void handleStart()}>
          {starting ? t('view.starting') : t('banner.start')}
        </Button>
      </>
    )
  }

  const bannerClass = !snap || error ? 'herdr-server-banner' : server?.running
    ? 'herdr-server-banner herdr-banner-running'
    : server && (server.status === 'not_running' || server.status === 'unknown')
      ? 'herdr-server-banner herdr-banner-stopped'
      : 'herdr-server-banner'

  return (
    <div>
      <div className={bannerClass}>{body}</div>
      {startError ? <div className="herdr-server-error">{t('banner.startFailed', { error: startError })}</div> : null}
    </div>
  )
}
