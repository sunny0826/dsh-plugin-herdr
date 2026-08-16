// PaneLog：日志主体（替代卡片内 TerminalBlock）。
// v2 可读性优化：
// - 行级渲染（每行独立 div），命令提示符行（❯ / $ 开头）着色区分；
// - 压缩连续空行（窄终端折行噪音），折叠预览取最后 3 个非空行；
// - 展开滚动区 + working 呼吸指示点；working 且位于底部时自动跟随。

import { useEffect, useMemo, useRef } from 'react'
import { classifyLogLine, type AgentAccent } from '../client-logic.ts'
import type { HerdrAgentStatus } from './types.ts'

/** 清洗 ANSI 转义序列（与 pane-read 的 strip 语义一致）；纯函数供单测。 */
export function stripAnsi(text: string): string {
  // 依次清除 OSC（Esc]...）、CSI、单 char ESC 引导的控制序列
  return text
    .replace(/\u001b\](?:.*?)(?:\u0007|\u001b\\|$)/g, '')
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001b[()][0-9A-Za-z]/g, '')
}

/** 压缩连续空行（保留至多 1 个空行分隔），纯函数。 */
export function compactLines(lines: string[]): string[] {
  const out: string[] = []
  let blank = false
  for (const l of lines) {
    if (l.trim() === '') {
      if (!blank) out.push('')
      blank = true
    } else {
      out.push(l)
      blank = false
    }
  }
  return out
}

export function PaneLog({
  agent,
  open,
  accent,
}: {
  agent: HerdrAgentStatus | undefined
  open: boolean
  /** Agent 品牌主题（日志区强调色作用域）。 */
  accent?: AgentAccent
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用户是否停留在底部（上滚暂停跟随，回底恢复）
  const atBottomRef = useRef(true)

  // 完整输出（清洗 ANSI）→ 行拆分 → 压缩连续空行。
  // 数据源为 herdr recent_unwrapped（status.ts pollOutputs），已是逻辑行无宽度折行
  const output = useMemo(() => stripAnsi(agent?.output ?? ''), [agent?.output])
  const lines = useMemo(() => compactLines(output.split(/\r?\n/)), [output])
  // 折叠预览：最后 3 个非空行（空行不占预览名额）
  const preview = useMemo(() => lines.filter(l => l.trim() !== '').slice(-3), [lines])
  const empty = lines.every(l => l.trim() === '')

  // 展开态：working 且位于底部时自动跟随
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (!el) return
    if (agent?.status === 'working' && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [open, agent?.status, output])

  // 监听滚动：离开底部则暂停跟随，回到底部恢复
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
      atBottomRef.current = nearBottom
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const renderLines = (ls: string[]) =>
    ls.map((line, i) => {
      const kind = classifyLogLine(line)
      return (
        <div key={i} className="herdr-log-line" data-kind={kind === 'plain' ? undefined : kind}>
          {line}
        </div>
      )
    })

  return (
    <div
      className="herdr-pcard-log"
      data-collapsed={open ? undefined : true}
      data-accent={accent ?? undefined}
      ref={scrollRef}
    >
      {agent?.status === 'working' && !empty ? <span className="herdr-log-live" title="agent working" /> : null}
      {empty ? (
        <div className="herdr-pcard-log-empty">（无输出）</div>
      ) : open ? (
        <div className="herdr-pcard-log-body">{renderLines(lines)}</div>
      ) : (
        <div className="herdr-pcard-log-body">{renderLines(preview)}</div>
      )}
    </div>
  )
}
