import type { DragEvent } from 'react'
import type { HerdrAgentStatus, HerdrPaneView } from './types.ts'
import { PaneCard } from './pane-card.tsx'

export function PaneGridView({
  panes,
  agentByPane,
  selfPaneId,
  wsId,
  dragId,
  overId,
  insertPos,
  onClosePane,
  onRenamePane,
  onMaximize,
  onHandleDragStart,
  onHandleDragEnd,
  onCardDragOver,
  onCardDrop,
  onCardDragLeave,
}: {
  panes: HerdrPaneView[]
  agentByPane: Map<string, HerdrAgentStatus>
  selfPaneId: string | null
  wsId: string
  dragId: string | null
  overId: string | null
  insertPos: 'before' | 'after' | null
  onClosePane: (paneId: string) => void
  onRenamePane: (paneId: string, label: string | null) => Promise<void>
  onMaximize: (paneId: string, triggerEl: HTMLElement | null) => void
  onHandleDragStart: (e: DragEvent, paneId: string) => void
  onHandleDragEnd: (e: DragEvent) => void
  onCardDragOver: (e: DragEvent, targetId: string, targetWsId: string) => void
  onCardDrop: (e: DragEvent, targetId: string, targetWsId: string) => void
  onCardDragLeave: () => void
}) {
  return (
    <div className='herdr-pane-grid'>
      {panes.map(pane => (
        <PaneCard
          key={pane.pane_id}
          pane={pane}
          agent={agentByPane.get(pane.pane_id)}
          self={pane.pane_id === selfPaneId}
          onClose={() => onClosePane(pane.pane_id)}
          onRename={label => onRenamePane(pane.pane_id, label)}
          onMaximize={triggerEl => onMaximize(pane.pane_id, triggerEl)}
          dragging={dragId === pane.pane_id}
          insert={overId === pane.pane_id ? insertPos : null}
          onHandleDragStart={e => onHandleDragStart(e, pane.pane_id)}
          onHandleDragEnd={onHandleDragEnd}
          onCardDragOver={e => onCardDragOver(e, pane.pane_id, wsId)}
          onCardDrop={e => onCardDrop(e, pane.pane_id, wsId)}
          onCardDragLeave={onCardDragLeave}
        />
      ))}
    </div>
  )
}
