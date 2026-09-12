import React, { useState } from 'react'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { ThreadLifecycle } from '../workbench/state.ts'
import { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket } from '../workbench/thread-lifecycle.ts'
import { formatTimeOfDay } from './format-time.ts'
import { DropdownSurface, useDropdownPresence } from './dropdown.tsx'
import { Icon } from './icons.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { colors } from './theme.ts'

const SIDEBAR_BORDER_WIDTH = 1
const SESSION_ROW_INSET = 8

export { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket }

function SessionRowInset({ sidebarWidth, height, children }: { sidebarWidth: number; height: number; children: React.ReactNode }) {
  const width = sidebarWidth - 2 * SIDEBAR_BORDER_WIDTH
  return <div testId="sidebar-session-inset" style={{ width, height, flexShrink: 0, paddingLeft: SESSION_ROW_INSET, paddingRight: SESSION_ROW_INSET }}>{children}</div>
}

/** GPUI only hit-tests a hitbox. `pointerEvents: 'auto'` occludes the wheel
 *  (BlockMouse), so list rows use an opaque fill instead and leave the event
 *  unset — that is BlockMouseExceptScroll, which still lets the parent list
 *  scroll. */
function withoutRowClick(handler: () => void) {
  return () => handler()
}

export function SessionRow({
  sidebarWidth,
  session,
  projectName,
  active,
  running,
  disabled,
  lifecycle,
  snoozedUntil,
  branch,
  snoozeOpen,
  onClick,
  onSettle,
  onWake,
  onSnooze,
  onSchedule,
}: {
  sidebarWidth: number
  session: PiSessionSummary
  projectName: string
  active: boolean
  running: boolean
  disabled: boolean
  lifecycle: 'active' | 'snoozed' | 'settled'
  snoozedUntil?: number
  branch: string
  snoozeOpen: boolean
  onClick(): void
  onSettle(): void
  onWake(): void
  onSnooze(): void
  onSchedule(until: number): void
}) {
  const { compact } = useResponsiveLayout()
  const [hovered, setHovered] = useState(false)
  const [settleHovered, setSettleHovered] = useState(false)
  const [snoozeHovered, setSnoozeHovered] = useState(false)
  const snoozeMounted = useDropdownPresence(snoozeOpen)
  // Opaque action hitboxes sit above the card in GPUI, so entering Settle/Snooze clears
  // the card hover bit. Pin controls while the pointer is on them or the row is live.
  const showLifecycleActions = compact || hovered || snoozeMounted || active || running
    || settleHovered || snoozeHovered
  if (lifecycle !== 'active') {
    return (
      <SessionRowInset sidebarWidth={sidebarWidth} height={36}>
      <div testId={lifecycle === 'settled' ? 'sidebar-settled-row' : 'sidebar-snoozed-row'} tabIndex={disabled ? -1 : 0} style={{ height: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 6, borderRadius: 7, backgroundColor: colors.sidebar, cursor: disabled ? 'default' : 'pointer', hover: { backgroundColor: colors.sidebarHover } }} {...(disabled ? {} : { onClick })}>
        <Icon name={lifecycle === 'snoozed' ? 'clock' : 'squarePen'} size={13} color={lifecycle === 'snoozed' ? colors.info : colors.settledIcon} />
        <div style={{ minWidth: 0, flexGrow: 1 }}>
          <text {...(lifecycle === 'settled' ? { testId: 'sidebar-settled-title' } : {})} style={{ color: lifecycle === 'settled' ? colors.settledText : colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        </div>
        <text style={{ color: lifecycle === 'settled' ? colors.settledMeta : colors.textFaint, fontSize: 9 }}>{lifecycle === 'snoozed' && snoozedUntil ? formatTimeOfDay(snoozedUntil) : relativeTime(session.modifiedAt)}</text>
        <div testId="sidebar-wake" tabIndex={0} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', backgroundColor: colors.sidebar }} onClick={withoutRowClick(onWake)}>
          <Icon name="check" size={12} color={lifecycle === 'settled' ? colors.settledIcon : colors.textFaint} />
        </div>
      </div>
      </SessionRowInset>
    )
  }

  return (
    <SessionRowInset sidebarWidth={sidebarWidth} height={78}>
    <div testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'} tabIndex={disabled ? -1 : 0} style={{ position: 'relative', height: 78, minHeight: 78, maxHeight: 78, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: 9, borderRadius: 8, backgroundColor: colors.sidebar, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, overflow: 'visible' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} {...(disabled ? {} : { onClick })}>
      <div testId="sidebar-session-surface" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 8, backgroundColor: active ? colors.sidebarActive : hovered ? colors.sidebarHover : colors.transparent, pointerEvents: 'none' }} />
      <div style={{ width: '100%', minWidth: 0, height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <div style={{ minWidth: 0, flexGrow: 1, height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="folder" size={13} color={colors.textFaint} />
          <text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
        </div>
        <div style={{ width: 70, height: 20, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
          {showLifecycleActions ? (
            <>
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
                <div testId="sidebar-snooze" tabIndex={0} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', backgroundColor: colors.sidebar, borderRadius: 5, hover: { backgroundColor: colors.hover } }} onMouseEnter={() => setSnoozeHovered(true)} onMouseLeave={() => setSnoozeHovered(false)} onClick={withoutRowClick(onSnooze)}>
                  <Icon name="clock" size={12} color={colors.textFaint} />
                </div>
                {snoozeMounted && <SnoozeMenu open={snoozeOpen} onSchedule={onSchedule} onClose={onSnooze} />}
              </div>
              <div testId="sidebar-settle" tabIndex={0} style={{ height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 3, paddingRight: 0, cursor: 'pointer', backgroundColor: colors.sidebar }} onMouseEnter={() => setSettleHovered(true)} onMouseLeave={() => setSettleHovered(false)} onClick={withoutRowClick(onSettle)}>
                <Icon name="check" size={11} color={settleHovered ? colors.text : colors.textFaint} />
                <text testId="sidebar-settle-label" style={{ color: settleHovered ? colors.text : colors.textFaint, fontSize: 9 }}>Settle</text>
              </div>
            </>
          ) : (
            <>
              <text style={{ color: running ? colors.info : colors.textFaint, fontSize: 9 }}>{running ? 'Working' : relativeTime(session.modifiedAt)}</text>
              <text style={{ color: '#E9705A', fontSize: 10, fontWeight: 700 }}>π</text>
            </>
          )}
        </div>
      </div>
      <div testId={active ? 'sidebar-session-active' : 'sidebar-session-row'} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="gitBranch" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textFaint, fontSize: 9 }}>{branch}</text>
        </div>
      </div>
    </div>
    </SessionRowInset>
  )
}

function SnoozeMenu({ open, onSchedule, onClose }: { open: boolean; onSchedule(until: number): void; onClose(): void }) {
  const now = Date.now()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  nextWeek.setHours(9, 0, 0, 0)
  const options = [
    { label: 'In 1 hour', value: now + 60 * 60 * 1_000 },
    { label: 'In 3 hours', value: now + 3 * 60 * 60 * 1_000 },
    { label: 'Tomorrow', value: tomorrow.getTime() },
    { label: 'Next week', value: nextWeek.getTime() },
  ]
  return (
    <anchored side="bottom" align="end" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
      <div testId="snooze-menu-positioner" style={{ display: 'flex', backgroundColor: colors.sidebar, pointerEvents: open ? 'auto' : 'none' }}>
        <DropdownSurface testId="snooze-menu" open={open} tabIndex={0} onMouseDownOutside={onClose} style={{ width: 204, padding: 5, borderRadius: 9 }}>
          {options.map((option, index) => (
            <React.Fragment key={option.label}>
              <div testId={`snooze-option-${index}`} tabIndex={0} style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onSchedule(option.value)}>
                <text style={{ color: colors.textMuted, fontSize: 11 }}>{option.label}</text>
                <div style={{ flexGrow: 1 }} />
                <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatTimeOfDay(option.value)}</text>
              </div>
            </React.Fragment>
          ))}
        </DropdownSurface>
      </div>
    </anchored>
  )
}


function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
