import { describe, expect, it } from 'bun:test'
import { sidebarPropsEqual, type WorkbenchSidebarProps } from '../src/ui/sidebar.tsx'
import { createInitialState } from '../src/workbench/state.ts'
import type { WorkbenchService } from '../src/workbench/controller.ts'

// One controller identity for every fixture: the comparison is identity-based, so a fresh object
// per call would make even an unchanged state look different.
const controller = {} as WorkbenchService

function props(state: WorkbenchSidebarProps['state']): WorkbenchSidebarProps {
  return {
    state,
    controller, 
    settingsActive: false,
    notificationsActive: false,
    unreadCount: 0,
    onSelectSession: () => undefined,
    onSettings: () => undefined,
    onNotifications: () => undefined,
  }
}

/**
 * The sidebar's memo rule decides whether a controller update reaches the session rows. A
 * messages-only update keeps the same `session` object, and the row title is derived from
 * `messages` when the session is unnamed, so skipping that render would leave a stale title.
 */
describe('sidebar memo', () => {
  it('re-renders on a messages-only update that keeps the same session', () => {
    const before = createInitialState('/tmp/project')
    const after = { ...before, messages: [{ role: 'user' as const, content: 'Fix the picker', timestamp: 1 }] }
    expect(after.session).toBe(before.session)
    expect(sidebarPropsEqual(props(before), props(after))).toBe(false)
  })

  it('skips a shallowly identical update', () => {
    const state = createInitialState('/tmp/project')
    expect(sidebarPropsEqual(props(state), props({ ...state }))).toBe(true)
  })

  it('re-renders when the persisted session list is replaced', () => {
    const before = createInitialState('/tmp/project')
    const after = { ...before, sessions: [...before.sessions] }
    expect(sidebarPropsEqual(props(before), props(after))).toBe(false)
  })
})
