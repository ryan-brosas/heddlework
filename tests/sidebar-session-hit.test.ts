import { describe, expect, it } from 'bun:test'

describe('sidebar session hit target', () => {
  it('uses an opaque fill so the whole card clicks without stealing list scroll', async () => {
    const [row, sidebar] = await Promise.all([
      Bun.file(new URL('../src/ui/sidebar-session-row.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/sidebar.tsx', import.meta.url)).text(),
    ])
    expect(row).toContain('backgroundColor: colors.sidebar')
    expect(row).toContain('withoutRowClick(onSnooze)')
    // Controls fill with the card surface, never the bare sidebar colour, or they show as a
    // dark slab inside an active/hovered card.
    expect(row).toContain("import { TextShimmer } from './motion.ts'")
    expect(row).toContain('const cardSurface = active ? colors.sidebarActive : pointerOnCard ? colors.sidebarHover : colors.sidebar')
    expect(row).toContain('backgroundColor: cardSurface')
    expect(row).toContain('minWidth: 70')
    // Same rule for the settled/snoozed wake control: it must follow the row surface, or it
    // shows as a bare sidebar square once the row takes its hover fill.
    expect(row).toContain('backgroundColor: hovered ? colors.sidebarHover : colors.sidebar')
    // The running label keeps the canonical working animation, not static text.
    expect(row).toContain("? <TextShimmer testId=\"sidebar-session-status\" text=\"Working\"")
    // Time/date and the Working tag live on the session metadata row, not the project row.
    const branchIconIndex = row.indexOf('name="gitBranch"')
    const statusIndex = row.indexOf('sidebar-session-status')
    expect(branchIconIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBeGreaterThan(branchIconIndex)
    expect(row).toContain('withoutRowClick(onSettle)')
    expect(row).toContain('withoutRowClick(onWake)')
    expect(row).toContain("testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'}")
    expect(row).toContain('showLifecycleActions')
    // The Pi mark is the card's harness identity and must survive the controls that share its
    // row: exactly one glyph, rendered after both controls rather than instead of them.
    expect(row).toContain('testId="sidebar-harness-badge"')
    expect(row.match(/π/gu)?.length).toBe(1)
    expect(row.indexOf('sidebar-harness-badge')).toBeGreaterThan(row.indexOf('testId="sidebar-settle"'))
    // Entering a control clears the card's own hover bit in GPUI, so the surface has to follow
    // the controls too or the hover fill drops out from under the pointer.
    expect(row).toContain('const pointerOnCard = hovered || settleHovered || snoozeHovered || snoozeMounted')
    expect(row).toContain('const showLifecycleActions = compact || active || running || pointerOnCard')
    expect(row).toContain('onMouseEnter={() => setSnoozeHovered(true)}')
    expect(sidebar).not.toContain('disabled={state.session.isStreaming || state.connection !== \'connected\'}')
    expect(sidebar).toContain('disabled={state.connection !== \'connected\'}')
    // pointerEvents auto occludes the wheel (GPUI BlockMouse). List rows must not use it.
    const card = row.slice(row.indexOf("sidebar-session-card-active' : 'sidebar-session-card'"))
    expect(card.slice(0, 800)).not.toContain("pointerEvents: 'auto'")
    expect(sidebar).toContain('testId="sidebar-flows"')
    expect(sidebar).toContain('backgroundColor: flowsActive ? colors.sidebarActive : colors.sidebar')
    expect(sidebar).toContain('testId="sidebar-settled-toggle"')
    expect(sidebar).toMatch(/sidebar-settled-toggle[\s\S]{0,400}backgroundColor: colors\.sidebar/)
    // The folder-filter contract lives in tests/sidebar-project-scope.test.ts.
  })
})
