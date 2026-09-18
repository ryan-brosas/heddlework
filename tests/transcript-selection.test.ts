import { describe, expect, it } from 'bun:test'
import { traceBodyStyle, transcriptRowShellStyle } from '../src/ui/transcript.tsx'
import { codeSurfaceStyle, toolRowHeaderStyle } from '../src/ui/transcript-tools.tsx'

/**
 * Selection policy for read-only content.
 *
 * The pinned GPUiX runtime only starts a drag selection inside a text run whose effective
 * `userSelect` is not `none` (measured in a real native window). A `none` here therefore made
 * tool args, tool output, diffs, and reasoning impossible to select and copy in the desktop
 * app. These assertions keep content surfaces selectable and chrome non-selectable.
 */
describe('transcript selection policy', () => {
  it('keeps tool code surfaces selectable', () => {
    expect(codeSurfaceStyle().userSelect).toBe('text')
  })

  it('keeps expanded trace content selectable', () => {
    const compact = transcriptRowShellStyle({ user: false, compact: true, noSelect: false, contentGutter: 24 })
    const content = transcriptRowShellStyle({ user: false, compact: false, noSelect: false, contentGutter: 24 })
    expect(compact.userSelect).toBe('text')
    expect(content.userSelect).toBe('text')
  })

  it('keeps an expanded trace body interactive so its links are clickable', () => {
    // A `pointerEvents: 'none'` here left every link in a disclosure inert while still rendering
    // it as a link, so a click opened nothing and said nothing.
    const body: { pointerEvents?: unknown; userSelect: string } = traceBodyStyle()
    expect(body.pointerEvents).toBeUndefined()
    expect(body.userSelect).toBe('text')
  })

  it('keeps the clickable tool header row non-selectable', () => {
    expect(toolRowHeaderStyle().userSelect).toBe('none')
  })

  it('keeps explicitly non-selectable chrome non-selectable', () => {
    const chrome = transcriptRowShellStyle({ user: false, compact: true, noSelect: true, contentGutter: 24 })
    expect(chrome.userSelect).toBe('none')
  })

  it('preserves the row padding contract', () => {
    const compact = transcriptRowShellStyle({ user: false, compact: true, noSelect: false, contentGutter: 24 })
    const content = transcriptRowShellStyle({ user: false, compact: false, noSelect: false, contentGutter: 24 })
    const user = transcriptRowShellStyle({ user: true, compact: false, noSelect: false, contentGutter: 24 })
    expect([compact.paddingTop, compact.paddingBottom]).toEqual([0, 0])
    expect([content.paddingTop, content.paddingBottom]).toEqual([4, 7])
    expect([user.paddingTop, user.paddingBottom]).toEqual([9, 11])
    expect(content.paddingLeft).toBe(24)
  })
})
