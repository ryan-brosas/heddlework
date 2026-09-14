import { useEffect, useMemo, useState } from 'react'
import type { WorkbenchService } from '../workbench/controller.ts'
import { queueItemsInDeliveryOrder, queueSize, queuedInputControl, type QueuedInput, type WorkbenchQueueState } from '../workbench/queue.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'
import { colors, nativeTheme } from './theme.ts'
import { useResponsiveLayout } from './responsive.tsx'
import { NativeVirtualList, useNativeVirtualWindow } from './virtual-list.tsx'

const HEADER_HEIGHT = 42
const COLLAPSED_HEIGHT = HEADER_HEIGHT
const DOCK_INSET = 0
const ROW_HEIGHT = 44
const MAX_LIST_HEIGHT = 264

interface MouseEventLike {
  button?: number
  pressedButton?: number
}

interface QueueRowView {
  id: string
  text: string
  placement: 'queued' | 'steering' | 'follow-up'
  item?: QueuedInput
}

export function queueDockReserveHeight(queue: WorkbenchQueueState): number {
  return queueSize(queue) > 0 ? COLLAPSED_HEIGHT + 8 : 0
}

export function QueueDock({ state, controller }: { state: WorkbenchState; controller: WorkbenchService }) {
  const { compact } = useResponsiveLayout()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined)
  const [draggingId, setDraggingId] = useState<string | undefined>(undefined)
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined)
  const ownedItems = useMemo(() => queueItemsInDeliveryOrder(state.queue.items), [state.queue.items])
  const rows = useMemo<QueueRowView[]>(() => [
    ...state.queue.steering.map((text, index) => ({ id: `native-steering-${index}-${text}`, text, placement: 'steering' as const })),
    ...ownedItems.map((item) => ({ id: item.id, text: item.text, placement: 'queued' as const, item })),
    ...state.queue.followUp.map((text, index) => ({ id: `native-follow-up-${index}-${text}`, text, placement: 'follow-up' as const })),
  ], [ownedItems, state.queue.followUp, state.queue.steering])
  const virtualWindow = useNativeVirtualWindow(rows.length, `queue:${rows.length}:${rows[0]?.id ?? ''}:${rows.at(-1)?.id ?? ''}`)
  const visibleRows = rows.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  const drainable = state.queue.items.some((item) => !item.flow && !queuedInputControl(item))
  const open = expanded && rows.length > 0
  const listTargetHeight = Math.min(MAX_LIST_HEIGHT, rows.length * ROW_HEIGHT + 8)
  const listHeight = open ? listTargetHeight : 0
  const height = COLLAPSED_HEIGHT + listHeight

  useEffect(() => {
    if (rows.length === 0) {
      setExpanded(false)
      setEditing(undefined)
      setDraggingId(undefined)
      setHoveredId(undefined)
      return
    }
    if (editing && !state.queue.items.some((item) => item.id === editing.id)) setEditing(undefined)
    if (draggingId && !state.queue.items.some((item) => item.id === draggingId)) setDraggingId(undefined)
  }, [draggingId, editing, rows.length, state.queue.items])

  if (rows.length === 0) return null

  const first = rows[0]!
  const saveEdit = () => {
    if (!editing) return
    controller.updateQueuedInput(editing.id, editing.text)
    setEditing(undefined)
  }

  return (
    <MotionDiv initial={false} animate={{ height }} transition={LAYOUT_MOTION_TRANSITION} testId="queue-dock" style={{ position: 'relative', width: '100%', maxWidth: 768, height, flexShrink: 0, marginBottom: 8, overflow: 'hidden', userSelect: 'none', pointerEvents: 'auto' }}>
      <div testId="queue-panel" style={{ position: 'absolute', left: DOCK_INSET, right: DOCK_INSET, top: 0, bottom: 0, borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.raised }} />

      <MotionDiv
        initial={false}
        animate={{ height: listHeight, opacity: open ? 1 : 0 }}
        transition={LAYOUT_MOTION_TRANSITION}
        style={{ position: 'absolute', left: DOCK_INSET, right: DOCK_INSET, bottom: COLLAPSED_HEIGHT, height: listHeight, overflow: 'hidden' }}
      >
      <NativeVirtualList
        testId="queue-scroll"
        alignment="top"
        estimatedItemHeight={ROW_HEIGHT}
        overdraw={ROW_HEIGHT * 3}
        itemCount={Math.max(1, rows.length)}
        windowStart={virtualWindow.windowStart}
        onVisibleRange={virtualWindow.onVisibleRange}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 4,
          paddingBottom: 4,
          overflow: 'hidden',
        }}
      >
        {visibleRows.map((row) => {
          const ownedIndex = row.item ? ownedItems.findIndex((item) => item.id === row.id) : -1
          const dispatching = state.queue.dispatchingId === row.id
          const control = row.item ? queuedInputControl(row.item) : undefined
          const actionsVisible = compact || hoveredId === row.id
          const pauseActionVisible = actionsVisible || Boolean(row.item?.paused)
          return (
            <div
              key={row.id}
              testId={`queue-row:${row.id}`}
              style={{ width: '100%', minHeight: ROW_HEIGHT, height: ROW_HEIGHT, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: hoveredId === row.id || draggingId === row.id ? colors.hover : colors.transparent, opacity: dispatching ? 0.55 : 1, flexShrink: 0 }}
              onMouseEnter={() => setHoveredId(row.id)}
              onMouseLeave={() => { if (draggingId !== row.id) setHoveredId(undefined) }}
              onMouseMove={(event: MouseEventLike) => {
                if (!draggingId || event.pressedButton !== 0 || ownedIndex < 0) return
                controller.moveQueuedInput(draggingId, ownedIndex)
              }}
              onMouseUp={() => setDraggingId(undefined)}
            >
              {row.item ? (
                <MotionDiv
                  testId={`queue-drag:${row.id}`}
                  initial={{ opacity: 0, left: -4 }}
                  animate={{ opacity: actionsVisible || draggingId === row.id ? 1 : 0, left: actionsVisible || draggingId === row.id ? 0 : -4 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                  style={{ position: 'relative', width: 22, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: actionsVisible ? 'grab' : 'default', color: colors.textFaint, flexShrink: 0 }}
                  onMouseDown={(event: MouseEventLike) => { if (actionsVisible && (event.button ?? 0) === 0 && !state.queue.dispatchingId) setDraggingId(row.id) }}
                  onMouseUp={() => setDraggingId(undefined)}
                >
                  <Icon name="grip" size={13} color={colors.textFaint} />
                </MotionDiv>
              ) : (
                <div style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={row.placement === 'steering' ? 'arrowUp' : 'lock'} size={11} color={row.placement === 'steering' ? '#7EA2FF' : colors.textFaint} /></div>
              )}

              {editing?.id === row.id ? (
                <input
                  testId={`queue-editor:${row.id}`}
                  value={editing.text}
                  autoFocus
                  theme={nativeTheme}
                  style={{ minWidth: 0, height: 30, flexGrow: 1, paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.input, color: colors.text, fontSize: 11 }}
                  onChange={(event) => setEditing({ id: row.id, text: String(event.value ?? '') })}
                  onSubmit={saveEdit}
                  onKeyDown={(event: { key?: string }) => { if (event.key === 'escape') setEditing(undefined) }}
                />
              ) : (
                <div {...(row.item ? { testId: `queue-edit:${row.id}` } : {})} style={{ minWidth: 0, flexGrow: 1, height: 30, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, cursor: row.item ? 'text' : 'default' }} {...(row.item && !dispatching ? { onClick: () => setEditing({ id: row.id, text: row.text }) } : {})}>
                  <text style={{ color: colors.text, fontSize: 11, lineHeight: 14, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{row.text || `${row.item?.images.length ?? 0} attached image${row.item?.images.length === 1 ? '' : 's'}`}</text>
                  <text style={{ color: control ? colors.warning : row.item?.lane === 'steer' || row.placement === 'steering' ? '#7EA2FF' : row.placement === 'follow-up' ? colors.warning : colors.textFaint, fontSize: 8, fontWeight: 650 }}>{row.placement === 'queued' ? `${control ? `CONTROL · ${control.kind === 'builtin' ? control.name.toUpperCase() : control.kind.toUpperCase().replaceAll('-', ' ')}` : row.item?.lane === 'steer' ? 'STEER · NEXT TURN' : 'FOLLOW-UP · AFTER RUN'}${row.item?.paused ? ' · HELD' : ''}${row.item?.images.length ? ` · ${row.item.images.length} IMAGE${row.item.images.length === 1 ? '' : 'S'}` : ''}` : row.placement === 'steering' ? 'STEERED · NEXT' : row.placement.toUpperCase()}</text>
                </div>
              )}

              {row.item && (
                <MotionDiv testId={`queue-row-pause:${row.id}`} initial={{ opacity: 0, left: 4 }} animate={{ opacity: pauseActionVisible ? 1 : 0, left: pauseActionVisible ? 0 : 4 }} transition={{ duration: 0.14, ease: 'easeOut' }} style={{ position: 'relative', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: row.item.paused ? '#382D18' : colors.transparent, cursor: pauseActionVisible && !dispatching ? 'pointer' : 'default', flexShrink: 0 }} {...(pauseActionVisible && !dispatching ? { onClick: () => controller.toggleQueuedInputPause(row.id) } : {})}>
                  <Icon name={row.item.paused ? 'lock' : 'clock'} size={11} color={row.item.paused ? colors.warning : colors.textFaint} />
                </MotionDiv>
              )}
              {row.item && !row.item.flow && (
                <MotionDiv testId={`queue-lane:${row.id}`} initial={{ opacity: 0, left: 4 }} animate={{ opacity: actionsVisible ? 1 : 0, left: actionsVisible ? 0 : 4 }} transition={{ duration: 0.14, ease: 'easeOut' }} style={{ position: 'relative', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: actionsVisible && !dispatching ? 'pointer' : 'default', flexShrink: 0 }} {...(actionsVisible && !dispatching ? { onClick: () => controller.moveQueuedInputToLane(row.id, row.item?.lane === 'steer' ? 'followUp' : 'steer') } : {})}>
                  <Icon name={row.item.lane === 'steer' ? 'clock' : 'arrowUp'} size={11} color={row.item.lane === 'steer' ? colors.warning : '#7EA2FF'} />
                </MotionDiv>
              )}
              {row.item && state.session.isStreaming && !control && (
                <MotionDiv testId={`queue-steer:${row.id}`} initial={{ opacity: 0, left: 4 }} animate={{ opacity: actionsVisible ? 1 : 0, left: actionsVisible ? 0 : 4 }} transition={{ duration: 0.14, ease: 'easeOut' }} style={{ position: 'relative', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: actionsVisible && !dispatching ? 'pointer' : 'default', flexShrink: 0 }} {...(actionsVisible && !dispatching ? { onClick: () => void controller.steerQueuedInput(row.id) } : {})}>
                  <Icon name="arrowUp" size={12} color="#7EA2FF" />
                </MotionDiv>
              )}
              {row.item && (
                <MotionDiv testId={`queue-remove:${row.id}`} initial={{ opacity: 0, left: 4 }} animate={{ opacity: actionsVisible ? 1 : 0, left: actionsVisible ? 0 : 4 }} transition={{ duration: 0.14, ease: 'easeOut' }} style={{ position: 'relative', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: actionsVisible && !dispatching ? 'pointer' : 'default', flexShrink: 0 }} {...(actionsVisible && !dispatching ? { onClick: () => controller.removeQueuedInput(row.id) } : {})}>
                  <Icon name="x" size={11} color={colors.textFaint} />
                </MotionDiv>
              )}
            </div>
          )
        })}
      </NativeVirtualList>
      </MotionDiv>

      <div testId="queue-header" tabIndex={0} style={{ position: 'absolute', left: DOCK_INSET, right: DOCK_INSET, bottom: 0, height: HEADER_HEIGHT, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 11, borderTopWidth: open ? 1 : 0, borderColor: colors.border, backgroundColor: colors.transparent, cursor: 'pointer' }} onClick={() => setExpanded((value) => !value)}>
        <Icon name="list" size={13} color={state.queue.paused ? colors.warning : colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{`${rows.length} queued`}</text>
        <text {...(state.queue.blockingActivity ? { testId: 'queue-blocking-note' } : {})} style={{ minWidth: 0, flexGrow: 1, color: state.queue.blockingActivity ? colors.warning : colors.textFaint, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{state.queue.blockingNote ?? first.text ?? 'Image attachment'}</text>
        <div testId="queue-peer-gate" tabIndex={0} style={{ height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, paddingLeft: compact ? 6 : 8, paddingRight: compact ? 6 : 8, borderRadius: 6, backgroundColor: colors.hover, cursor: 'pointer', flexShrink: 0 }} onClick={() => void controller.queueFabricPeerGate()} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') void controller.queueFabricPeerGate() }}>
          <Icon name="gitBranch" size={11} color={colors.textMuted} />
          {!compact && <text style={{ color: colors.textMuted, fontSize: 9, fontWeight: 700 }}>Wait peer</text>}
        </div>
        {state.queue.blockingActivity === 'fabric-await' && (
          <div testId="queue-stop-gate" tabIndex={0} style={{ height: 24, display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 7, borderRadius: 6, backgroundColor: '#382D18', cursor: 'pointer' }} onClick={() => controller.cancelBlockingQueueActivity()}>
            <Icon name="stop" size={9} color={colors.warning} />
            {!compact && <text style={{ color: colors.warning, fontSize: 9, fontWeight: 700 }}>Stop wait</text>}
          </div>
        )}
        {drainable && (
          <div testId="queue-drain" tabIndex={0} style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: colors.hover, cursor: 'pointer' }} onClick={() => void controller.drainQueueMessages()}>
            <text style={{ color: colors.textMuted, fontSize: 9, fontWeight: 700 }}>Drain</text>
          </div>
        )}
        {state.session.isStreaming && (
          <div testId="queue-pause" tabIndex={0} style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: colors.hover, cursor: 'pointer' }} onClick={() => void controller.pause()}>
            <text style={{ color: colors.textMuted, fontSize: 9, fontWeight: 700 }}>Pause</text>
          </div>
        )}
        {state.queue.paused && state.queue.items.length > 0 && (
          <div testId="queue-resume" tabIndex={0} style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: '#382D18', cursor: 'pointer' }} onClick={() => controller.resumeQueue()}>
            <text style={{ color: colors.warning, fontSize: 9, fontWeight: 700 }}>Resume</text>
          </div>
        )}
        <Icon name={expanded ? 'chevronDown' : 'chevronUp'} size={12} color={colors.textFaint} />
      </div>
    </MotionDiv>
  )
}
