import { describe, expect, it } from 'bun:test'

describe('sidebar session hit target', () => {
  it('uses an opaque fill so the whole card clicks without stealing list scroll', async () => {
    const [row, sidebar] = await Promise.all([
      Bun.file(new URL('../src/ui/sidebar-session-row.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/sidebar.tsx', import.meta.url)).text(),
    ])
    expect(row).toContain('backgroundColor: colors.sidebar')
    expect(row).toContain('withoutRowClick(onSnooze)')
    expect(row).toContain('withoutRowClick(onSettle)')
    expect(row).toContain('withoutRowClick(onWake)')
    expect(row).toContain("testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'}")
    expect(row).toContain('compact || hovered || snoozeMounted || active')
    expect(sidebar).not.toContain('disabled={state.session.isStreaming || state.connection !== \'connected\'}')
    expect(sidebar).toContain('disabled={state.connection !== \'connected\'}')
    // pointerEvents auto occludes the wheel (GPUI BlockMouse). List rows must not use it.
    const card = row.slice(row.indexOf("sidebar-session-card-active' : 'sidebar-session-card'"))
    expect(card.slice(0, 800)).not.toContain("pointerEvents: 'auto'")
    expect(sidebar).toContain('testId="sidebar-flows"')
    expect(sidebar).toContain('backgroundColor: flowsActive ? colors.sidebarActive : colors.sidebar')
  })
})
