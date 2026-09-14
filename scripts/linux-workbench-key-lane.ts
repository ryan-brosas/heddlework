/**
 * Assert the clipboard shortcuts a compositor actually delivers, through the real workbench.
 *
 * Omarchy's Hyprland bindings rewrite clipboard shortcuts before any window sees them: `Ctrl+V`
 * arrives as `Shift+Insert` ("Direct paste") and `Super+C` as `Ctrl+Insert` ("Universal copy"). The
 * pinned GPUiX input binds neither, so an application that only understands `Ctrl+C`/`Ctrl+V` looks
 * as if it had no clipboard on that desktop. `src/ui/insert-key.ts` resolves both, and this lane
 * proves the wiring end to end in a live window instead of trusting the unit tests alone.
 *
 * The lane runs against stubbed `wl-copy`/`wl-paste` helpers (see scripts/linux-workbench-key-smoke.ts)
 * for two reasons: it never touches the operator's clipboard, and it can observe exactly what the app
 * asked the clipboard to hold. The native `Ctrl+C`/`Ctrl+V` round trip is asserted separately, because
 * that path uses the renderer's own clipboard and needs no helper at all.
 */

import type { App } from '@gpuix/react/automation'

export const KEY_LANE_SELECTION_MARKER: string = 'KEY_LANE_DOC_SELECTION_MARKER'
export const KEY_LANE_PASTE_MARKER: string = 'KEY_LANE_SHIFT_INSERT_MARKER'
export const KEY_LANE_NATIVE_MARKER: string = 'KEY_LANE_NATIVE_ROUND_TRIP_MARKER'

const LEFT_BUTTON = 0

export interface WorkbenchKeyLaneCheck {
  readonly name: string
  readonly evidence: string
}

export interface WorkbenchKeyLaneOptions {
  /** Named in every evidence line so a failure says which environment it came from. */
  readonly compositor: string
  /** Stage what the app's `wl-paste` stub will return for the next read. */
  stagePaste(text: string): void
  /** What the app's `wl-copy` stub most recently received. */
  copiedText(): string
}

/** Throws on the first failed assertion; returns the check report on success. */
export async function runWorkbenchKeyLane(app: App, options: WorkbenchKeyLaneOptions): Promise<WorkbenchKeyLaneCheck[]> {
  const checks: WorkbenchKeyLaneCheck[] = []
  const pass = (name: string, evidence: string) => { checks.push({ name, evidence }) }
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const painted = async (): Promise<string> => ((await app.call('getAllText', {})) as { text: string[] }).text.join(' | ')
  const submit = async (text: string): Promise<void> => {
    await app.getByTestId('composer').fill(text)
    await app.getByTestId('composer').press('enter')
    await wait(2_500)
  }

  const composer = app.getByTestId('composer')
  await composer.waitFor({ timeoutMs: 30_000 })
  await wait(900)

  // A document message to select, so `Ctrl+Insert` has a real selection to copy.
  await submit(KEY_LANE_SELECTION_MARKER)
  assert((await painted()).includes(KEY_LANE_SELECTION_MARKER), 'the composer did not submit a message to select')

  const box = await app.getByTestId('user-message-text').bounds()
  const y = box.y + box.height / 2
  await app.call('clearSelection', {})
  await app.call('mouseDown', { x: box.x + 2, y, button: LEFT_BUTTON })
  await app.call('mouseMove', { x: box.x + box.width * 0.6, y, pressedButton: LEFT_BUTTON })
  await app.call('mouseMove', { x: box.x + box.width - 2, y, pressedButton: LEFT_BUTTON })
  await app.call('mouseUp', { x: box.x + box.width - 2, y, button: LEFT_BUTTON })
  const selectedText = ((await app.call('getSelectedText', {})) as { text: string | null }).text?.trim() ?? ''
  assert(selectedText.length > 0, 'dragging over the message selected no text')

  await composer.press('ctrl-insert')
  await wait(900)
  const copied = options.copiedText().trim()
  assert(copied.includes(selectedText), `Ctrl+Insert did not copy the selection (helper received ${JSON.stringify(copied)})`)
  pass('ctrl-insert-copies-selection', `a drag selected ${JSON.stringify(selectedText)} and Ctrl+Insert sent it to the clipboard helper on ${options.compositor}`)

  options.stagePaste(KEY_LANE_PASTE_MARKER)
  await composer.fill('')
  await composer.press('shift-insert')
  await wait(900)
  await composer.press('enter')
  await wait(2_000)
  const pasted = (await painted()).includes(KEY_LANE_PASTE_MARKER)
  assert(pasted, 'Shift+Insert did not paste the staged clipboard text into the composer')
  pass('shift-insert-pastes', `Shift+Insert pasted the staged clipboard text into the composer and it submitted on ${options.compositor}`)

  await composer.fill(KEY_LANE_NATIVE_MARKER)
  await composer.press('ctrl-a')
  await composer.press('ctrl-c')
  await wait(600)
  await composer.fill('')
  await composer.press('ctrl-v')
  await wait(600)
  await composer.press('enter')
  await wait(2_000)
  assert((await painted()).includes(KEY_LANE_NATIVE_MARKER), 'the native Ctrl+C then Ctrl+V round trip stopped working')
  pass('native-round-trip', `Ctrl+A, Ctrl+C, Ctrl+V still round-trips through the renderer clipboard on ${options.compositor}`)

  return checks
}
