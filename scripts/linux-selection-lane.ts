/**
 * Assert the shipped UI text-selection policy in a real native window.
 *
 * Selection is what makes Ctrl+C possible: the pinned GPUiX runtime only starts a drag inside a
 * text run whose effective `userSelect` is not `none`, so a style regression silently makes tool
 * output or reasoning text uncopyable. This lane drives the production style helpers through
 * whichever window hosts them (`scripts/smoke-linux-selection.tsx` here, and any compositor via
 * `scripts/linux-selection-smoke.ts`) and reports one evidence line per policy direction.
 *
 * The lane deliberately asserts selection, not the operating-system clipboard: writing the
 * compositor clipboard needs an input serial, and an automation-injected key event carries none,
 * so a synthetic Ctrl+C cannot copy even when the selection is correct. Use the real app for that
 * path (see docs/terminal.md).
 */

import type { App } from '@gpuix/react/automation'

export const SELECTION_CONTENT_MARKER: string = 'SELECTION_CONTENT_SELECTABLE'
export const SELECTION_CODE_MARKER: string = 'SELECTION_CODE_SELECTABLE'
export const SELECTION_CHROME_MARKER: string = 'SELECTION_CHROME_BLOCKED'

const LEFT_BUTTON = 0

export interface SelectionLaneCheck {
  readonly name: string
  readonly evidence: string
}

export interface SelectionLaneOptions {
  /** Reported in the evidence lines so a failure names the surface it ran on. */
  readonly compositor: string
}

/**
 * Throws on the first failed assertion; returns the lane's report checks on success.
 */
export async function runSelectionLane(app: App, options: SelectionLaneOptions): Promise<SelectionLaneCheck[]> {
  const checks: SelectionLaneCheck[] = []
  const pass = (name: string, evidence: string) => { checks.push({ name, evidence }) }
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
  }

  // A drag from just inside the left edge to the right edge of the run, mid-height: the same
  // gesture a reader makes, and the one the runtime must resolve into a selection.
  const dragSelect = async (testId: string): Promise<string | null> => {
    const box = await app.getByTestId(testId).bounds()
    assert(box.width > 20, `${testId} is too narrow (${box.width}px) to drag-select`)
    const y = box.y + box.height / 2
    await app.call('clearSelection', {})
    await app.call('mouseDown', { x: box.x + 2, y, button: LEFT_BUTTON })
    await app.call('mouseMove', { x: box.x + box.width * 0.5, y, pressedButton: LEFT_BUTTON })
    await app.call('mouseMove', { x: box.x + box.width - 2, y, pressedButton: LEFT_BUTTON })
    await app.call('mouseUp', { x: box.x + box.width - 2, y, button: LEFT_BUTTON })
    const selected = await app.call('getSelectedText', {})
    return selected.text
  }

  // Every surface the drag below reads bounds from has to be measured first, or the drag lands on a
  // surface that has not been laid out yet and the lane reports a selection failure of its own making.
  for (const surface of ['selection-code', 'selection-content', 'selection-chrome']) {
    await app.getByTestId(surface).waitFor()
  }

  const code = await dragSelect('selection-code')
  assert(code !== null && code.includes(SELECTION_CODE_MARKER), `tool code surface was not selectable (selected ${JSON.stringify(code)})`)
  pass(
    'selection-tool-code',
    `a drag over the production code surface (codeSurfaceStyle) selected ${JSON.stringify(code)} on ${options.compositor}`,
  )

  const content = await dragSelect('selection-content')
  assert(content !== null && content.includes(SELECTION_CONTENT_MARKER), `trace content row was not selectable (selected ${JSON.stringify(content)})`)
  pass(
    'selection-trace-content',
    `a drag over a content row (transcriptRowShellStyle without noSelect) selected ${JSON.stringify(content)} on ${options.compositor}`,
  )

  const chrome = await dragSelect('selection-chrome')
  assert(chrome === null || !chrome.includes(SELECTION_CHROME_MARKER), `chrome row was selectable (selected ${JSON.stringify(chrome)})`)
  pass(
    'selection-chrome-blocked',
    `a drag over a noSelect chrome row selected ${JSON.stringify(chrome)} on ${options.compositor}`,
  )

  // A reversed drag must resolve the same text: the runtime joins spans in document order.
  const box = await app.getByTestId('selection-code').bounds()
  const y = box.y + box.height / 2
  await app.call('clearSelection', {})
  await app.call('mouseDown', { x: box.x + box.width - 2, y, button: LEFT_BUTTON })
  await app.call('mouseMove', { x: box.x + 2, y, pressedButton: LEFT_BUTTON })
  await app.call('mouseUp', { x: box.x + 2, y, button: LEFT_BUTTON })
  const reversed = (await app.call('getSelectedText', {})).text
  assert(reversed !== null && reversed.includes(SELECTION_CODE_MARKER), `reversed drag selected ${JSON.stringify(reversed)}`)
  pass('selection-reversed-drag', `a right-to-left drag selected ${JSON.stringify(reversed)}`)

  return checks
}
