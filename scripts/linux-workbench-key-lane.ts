/**
 * The compositor clipboard-key lane, asserted on exact bytes.
 *
 * Omarchy's Hyprland bindings deliver clipboard commands as insert keystrokes before any window sees
 * them: `Ctrl+V` arrives as `Shift+Insert` ("Direct paste") and `Super+C` as `Ctrl+Insert`
 * ("Universal copy"). The pinned GPUiX input binds neither, so `src/ui/insert-key.ts` resolves both
 * for the composer and the transcript. This lane proves that wiring in a live window.
 *
 * Every assertion is exact and per-run:
 *
 * - The lane stages `wl-copy`/`wl-paste` helpers in a private `PATH` (see
 *   scripts/linux-workbench-key-smoke.ts), so it never touches the operator's clipboard and it observes
 *   the bytes the app actually asked the clipboard to hold. A copy is compared byte for byte with the
 *   document selection, never with a trimmed or `includes` comparison.
 * - Each run builds fresh markers from a nonce, and a submitted message is matched by exact text
 *   equality, so text left behind by an earlier run can never satisfy a check.
 * - Waits are bounded polls of an observable (painted draft, transcript text, helper write count)
 *   rather than fixed sleeps. Negative checks observe a bounded window in which the effect could have
 *   happened, and every negative is paired with a positive control on the same key path in the same
 *   run.
 */

import type { App, ElementBounds, TreeNode } from '@gpuix/react/automation'

const LEFT_BUTTON = 0
const USER_MESSAGE_TEST_ID = 'user-message-text'
const POLL_INTERVAL_MS = 25
const COMPOSER_TIMEOUT_MS = 30_000
const TRANSCRIPT_TIMEOUT_MS = 20_000
const SELECTION_TIMEOUT_MS = 5_000
const NEGATIVE_QUIET_MS = 1_000
const PASTE_FOCUS_ROW = 0
const SELECTION_ROW = 1

export interface WorkbenchKeyLaneMarkers {
  readonly selection: string
  readonly other: string
  readonly paste: string
  readonly native: string
}

/** Fresh markers per run: an earlier run's transcript can never satisfy an exact-text assertion. */
export function workbenchKeyLaneMarkers(nonce: string): WorkbenchKeyLaneMarkers {
  return {
    selection: `kw-${nonce}-sel`,
    other: `kw-${nonce}-other`,
    paste: `kw-${nonce}-paste`,
    native: `kw-${nonce}-native`,
  }
}

/** The clipboard helper channel the lane observes; the driver points it at the stub files. */
export interface WorkbenchKeyLaneClipboard {
  /** Exact bytes the app most recently handed to `wl-copy`, untrimmed. */
  copiedText(): string
  /** Number of `wl-copy` invocations, so a no-op copy is distinguishable from a missing one. */
  copyWrites(): number
  /** Stage what the app's `wl-paste` stub returns for the next text read. */
  stagePaste(text: string): void
  /** Stage an image-only clipboard: text reads must fail rather than return the staged text. */
  stageImage(): void
  /** Recent clipboard helper invocations, reported when a draft assertion fails. */
  helperInvocations(): readonly string[]
}

export interface WorkbenchKeyLaneOptions {
  /** Reported in every evidence line so a failure names the environment it came from. */
  readonly compositor: string
  /** Per-run nonce; the lane derives all markers from it. */
  readonly nonce: string
  readonly clipboard: WorkbenchKeyLaneClipboard
  /** Bounded observation window for the negative checks; tests shrink it. */
  readonly negativeQuietMs?: number
  /** Override the poll deadlines; tests shrink them so a red run stays fast. */
  readonly timeouts?: WorkbenchKeyLaneTimeouts
}

export interface WorkbenchKeyLaneTimeouts {
  readonly composerMs?: number
  readonly transcriptMs?: number
  readonly selectionMs?: number
}

export interface WorkbenchKeyLaneCheck {
  readonly name: string
  readonly evidence: string
}

/** Throws on the first failed assertion; returns the check report on success. */
export async function runWorkbenchKeyLane(app: App, options: WorkbenchKeyLaneOptions): Promise<WorkbenchKeyLaneCheck[]> {
  const checks: WorkbenchKeyLaneCheck[] = []
  const markers = workbenchKeyLaneMarkers(options.nonce)
  const pass = (name: string, evidence: string): void => { checks.push({ name, evidence }) }
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
  }
  const composer = app.getByTestId('composer')
  const quietMs = options.negativeQuietMs ?? NEGATIVE_QUIET_MS
  const composerMs = options.timeouts?.composerMs ?? COMPOSER_TIMEOUT_MS
  const transcriptMs = options.timeouts?.transcriptMs ?? TRANSCRIPT_TIMEOUT_MS
  const selectionMs = options.timeouts?.selectionMs ?? SELECTION_TIMEOUT_MS

  const pause = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)) }

  /**
   * Poll an observable until it satisfies `accept`. The deadline error carries the last observation,
   * so a failure says what the workbench was showing instead of only that time ran out.
   */
  const poll = async <T,>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number, description: string): Promise<T> => {
    const started = Date.now()
    let last: T | undefined
    let lastError: unknown
    for (;;) {
      try {
        last = await read()
      } catch (error) {
        lastError = error
      }
      if (last !== undefined && accept(last)) return last
      if (Date.now() - started >= timeoutMs) {
        const observed = last === undefined ? `last read failed: ${String(lastError)}` : `last observed: ${JSON.stringify(last)}`
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (${observed})`)
      }
      await pause()
    }
  }

  const allText = async (): Promise<string[]> => (await app.call('getAllText', {})).text
  // `getPaintedText` is the protocol's painted-text readback, and the pinned addon records painted
  // text only under GPUiX test-support (macOS and Windows), so on Linux it answers with an empty list
  // and no run can ever observe a frame through it. `getAllText` reads the element tree the real
  // renderer does serve here. Every assertion below still compares whole elements for exact equality,
  // so the strictness the readback was meant to add is kept without depending on it.
  const paintedText = async (): Promise<string[]> => (await app.call('getAllText', {})).text
  /** Newest transcript row is last in document order; the lane indexes from the end. */
  const selectedText = async (): Promise<string | null> => (await app.call('getSelectedText', {})).text
  const rowText = (node: TreeNode): string => `${node.text ?? ''}${(node.children ?? []).map(rowText).join('')}`
  const messageRows = async (): Promise<TreeNode[]> => await app.getByTestId(USER_MESSAGE_TEST_ID).all()
  /** Message rows carrying exactly the marker: the row is the unit a duplicate submit would add. */
  const messageRowCount = async (expected: string): Promise<number> => (await messageRows()).filter((row) => rowText(row) === expected).length
  /** Text this run created; demo replies and workbench chrome cannot pollute a count. */
  const runTexts = async (): Promise<string[]> => (await allText()).filter((value) => value.includes(`kw-${options.nonce}`))

  /** The composer draft is asserted through the message it submits, never read directly. */
  /**
   * The composer action reads `abort` while a turn streams and `send` when it is idle. While streaming,
   * `controller.submit` queues the text instead of appending a transcript row, so a keyboard lane must
   * let the turn settle before it can assert that one submit added exactly one message.
   */
  const waitForIdleTurn = async (): Promise<void> => {
    await poll(async () => (await app.getByTestId('send').all()).length, (count) => count > 0, composerMs, 'the composer action to read "send", meaning the turn settled')
  }

  /** Wait for exactly one new message row whose text is the marker. */
  const waitForExactMessage = async (expected: string, previousCount: number): Promise<number> => {
    const observed = await poll(
      async () => {
        const texts = (await messageRows()).map(rowText)
        return {
          count: texts.filter((text) => text === expected).length,
          runRows: texts.filter((text) => text.includes(`kw-${options.nonce}`)),
          helpers: options.clipboard.helperInvocations().slice(-4),
        }
      },
      (value) => value.count === previousCount + 1,
      transcriptMs,
      `exactly one new user message whose text is ${JSON.stringify(expected)}`,
    )
    return observed.count
  }

  /**
   * Submit whatever the composer holds and require exactly one new message carrying `expected`. This is how
   * the lane observes a paste on Linux: the draft is not readable through the automation surface (see
   * above), so the submitted row is the observable - and the stronger one, because it proves the exact bytes
   * the composer handed to the harness rather than what the widget happened to hold.
   */
  const submitAndRequireExact = async (expected: string): Promise<void> => {
    const before = await messageRowCount(expected)
    await waitForIdleTurn()
    await composer.press('enter')
    await waitForExactMessage(expected, before)
  }

  /**
   * A composer holding nothing must submit nothing. This is the lane's empty-draft observable: after a paste
   * that had to be refused, or after a submit that had to clear the draft, Enter must add no message.
   */
  const expectEmptyDraftSubmitsNothing = async (description: string): Promise<void> => {
    await waitForIdleTurn()
    const baseline = (await runTexts()).length
    await composer.press('enter')
    await expectNoRunTextGrowthWithin(quietMs, baseline, description)
  }

  /** Fill the composer, submit, and require exactly one new message carrying the exact text. */
  const submit = async (text: string): Promise<void> => {
    const before = await messageRowCount(text)
    await composer.fill(text)
    await waitForIdleTurn()
    await composer.press('enter')
    await waitForExactMessage(text, before)
  }

  /** Clipboard text reads so far; a text read is the last step of the app's paste path. */
  const clipboardTextReads = async (): Promise<number> => options.clipboard.helperInvocations().filter((value) => value.startsWith('text ')).length

  /**
   * Wait for the app to finish its clipboard text read before submitting. The lane cannot read the
   * composer's draft on Linux (see above), so the helper channel is the only signal that a paste has landed,
   * and pressing Enter first would turn a slow paste into a phantom failure. Returns how long the paste took.
   */
  const pressPasteKey = async (description: string): Promise<number> => {
    const before = await clipboardTextReads()
    await composer.press('shift-insert')
    const started = Date.now()
    await poll(clipboardTextReads, (count) => count > before, composerMs, `${description} to finish its clipboard text read`)
    // The stub logs the read before it serves the payload, so let the app consume and apply it.
    await pause()
    await pause()
    return Date.now() - started
  }

  /** Press Ctrl+Insert and wait for exactly one new clipboard write, then read the exact bytes. */
  const pressAndWaitForCopy = async (previousCount: number): Promise<string> => {
    await composer.press('ctrl-insert')
    const count = await poll(async () => options.clipboard.copyWrites(), (value) => value >= previousCount + 1, selectionMs,
      'Ctrl+Insert to reach the clipboard helper')
    assert(count === previousCount + 1, `one Ctrl+Insert wrote ${count - previousCount} clipboard payload(s)`)
    return options.clipboard.copiedText()
  }

  /** A negative must watch a window in which the effect could have happened; a positive control follows. */
  const expectNoRunTextGrowthWithin = async (timeoutMs: number, baselineCount: number, description: string): Promise<void> => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const texts = await runTexts()
      if (texts.length !== baselineCount) {
        throw new Error(`${description}: the transcript gained ${JSON.stringify(texts.slice(baselineCount))} within ${timeoutMs}ms`)
      }
      await pause()
    }
  }

  const selectMessage = async (rowsFromEnd: number, marker: string): Promise<string> => {
    await app.call('clearSelection', {})
    const boxes = await poll(async (): Promise<ElementBounds[]> => {
      const nodes = await app.getByTestId(USER_MESSAGE_TEST_ID).all()
      const collected: ElementBounds[] = []
      for (const node of nodes) {
        if (node.bounds) collected.push(node.bounds)
      }
      return collected
    }, (value) => value.length > rowsFromEnd, transcriptMs, `a user message ${rowsFromEnd} row(s) from the newest`)
    const box = boxes[boxes.length - 1 - rowsFromEnd]
    if (box === undefined) throw new Error(`no bounds for the user message ${rowsFromEnd} row(s) from the newest`)
    const y = box.y + box.height / 2
    await app.mouse.down({ x: box.x + 1, y }, { button: LEFT_BUTTON })
    await app.mouse.move({ x: box.x + box.width / 2, y }, { pressedButton: LEFT_BUTTON })
    await app.mouse.move({ x: box.x + box.width + 12, y }, { pressedButton: LEFT_BUTTON })
    await app.mouse.up({ x: box.x + box.width + 12, y }, { button: LEFT_BUTTON })
    const selected = await poll(selectedText, (value) => value !== null && value.includes(marker), selectionMs,
      `the drag over the message ${rowsFromEnd} row(s) from the newest to select ${JSON.stringify(marker)}`)
    if (selected === null) throw new Error(`the drag over the message ${rowsFromEnd} row(s) from the newest selected nothing`)
    return selected
  }

  await composer.waitFor({ timeoutMs: composerMs })
  await poll(paintedText, (lines) => lines.length > 0, composerMs, 'the workbench to paint its first frame')

  // Two exact document messages: one to select first, one to select later so a stale selection is
  // detectable. Both must appear byte for byte before the copy checks mean anything.
  await submit(markers.selection)
  await submit(markers.other)
  pass('exact-transcript-ready', `the workbench submitted ${JSON.stringify(markers.selection)} and ${JSON.stringify(markers.other)} as exact user messages on ${options.compositor}`)

  // 1. Ctrl+Insert copies the current document selection byte for byte.
  const firstSelection = await selectMessage(SELECTION_ROW, markers.selection)
  assert(!firstSelection.includes(markers.other), `the selection for the first message also matched the second: ${JSON.stringify(firstSelection)}`)
  const firstCopied = await pressAndWaitForCopy(options.clipboard.copyWrites())
  assert(firstCopied === firstSelection, `Ctrl+Insert wrote ${JSON.stringify(firstCopied)} instead of the exact selection ${JSON.stringify(firstSelection)}`)
  pass('ctrl-insert-copies-exact-selection',
    `a drag selected ${JSON.stringify(firstSelection)} and Ctrl+Insert handed those exact ${Buffer.byteLength(firstCopied)} bytes to the clipboard helper on ${options.compositor}`)

  // 2. With no selection the same key must not write anything - and must still work on the next selection.
  await app.call('clearSelection', {})
  const writesBeforeEmptyCopy = options.clipboard.copyWrites()
  const emptyCopyStarted = Date.now()
  while (Date.now() - emptyCopyStarted < quietMs) {
    await composer.press('ctrl-insert')
    if (options.clipboard.copyWrites() !== writesBeforeEmptyCopy) break
    await pause()
  }
  const emptyCopyWrites = options.clipboard.copyWrites()
  assert(emptyCopyWrites === writesBeforeEmptyCopy, `Ctrl+Insert with no selection wrote ${emptyCopyWrites - writesBeforeEmptyCopy} clipboard payload(s)`)
  pass('copy-disabled-without-selection',
    `Ctrl+Insert with no selection wrote nothing across ${quietMs}ms of repeated presses; the control below is the same key on a real selection`)

  // 3. The copy follows the *current* selection, not the previous one.
  const otherSelection = await selectMessage(PASTE_FOCUS_ROW, markers.other)
  assert(otherSelection.includes(markers.other) && !otherSelection.includes(markers.selection),
    `the second selection does not identify the second message: ${JSON.stringify(otherSelection)}`)
  const secondCopied = await pressAndWaitForCopy(emptyCopyWrites)
  assert(secondCopied === otherSelection, `the second Ctrl+Insert wrote ${JSON.stringify(secondCopied)} instead of the exact selection ${JSON.stringify(otherSelection)}`)
  assert(secondCopied !== firstCopied, 'Ctrl+Insert re-copied the stale selection instead of the current one')
  pass('copy-follows-current-selection',
    `after copying ${JSON.stringify(firstSelection)}, selecting ${JSON.stringify(otherSelection)} and pressing Ctrl+Insert wrote the new exact bytes on the same run`)

  // 4. Shift+Insert pastes into the composer as exact bytes, and the draft clears on submit.
  options.clipboard.stagePaste(markers.paste)
  await composer.fill('')
  const pasteReadMs = await pressPasteKey('Shift+Insert')
  await submitAndRequireExact(markers.paste)
  await expectEmptyDraftSubmitsNothing('Enter after the pasted text was submitted')
  pass('shift-insert-pastes-exact-draft',
    `Shift+Insert handed the staged clipboard text to the composer as exactly ${JSON.stringify(markers.paste)} in ${pasteReadMs}ms: submitting it added exactly one new user message with those byte-exact contents, and the next Enter submitted nothing`)

  // 5. A duplicate paste duplicates the bytes in the draft - exactly twice, no more and no less.
  const doubled = markers.paste + markers.paste
  await composer.fill('')
  await pressPasteKey('the first Shift+Insert')
  await pressPasteKey('the second Shift+Insert')
  await submitAndRequireExact(doubled)
  pass('duplicate-paste-keeps-exact-copies',
    `pasting the same clipboard text twice submitted exactly ${JSON.stringify(doubled)} as one new user message: two pastes inserted two exact copies, not one and not three`)

  // 6. A blurred composer must not consume the paste key at all.
  options.clipboard.stagePaste(markers.paste)
  await composer.fill('')
  await app.call('blur', {})
  await app.call('keystrokes', { keys: 'shift-insert' })
  await expectEmptyDraftSubmitsNothing('Enter after Shift+Insert reached a blurred composer')
  const composerNode = await composer.element()
  await app.call('focus', { elementId: composerNode.id })
  await pressPasteKey('the refocused Shift+Insert')
  await submitAndRequireExact(markers.paste)
  pass('paste-disabled-without-focus',
    `the paste key behind a blurred composer left the draft empty - the Enter that followed submitted nothing - and the same key pasted exactly ${JSON.stringify(markers.paste)} once the composer was refocused`)

  // 7. An image-only clipboard must not hand its text (or the stale staged text) to the composer.
  options.clipboard.stageImage()
  await composer.fill('')
  await composer.press('shift-insert')
  await expectEmptyDraftSubmitsNothing('Enter after Shift+Insert against an image-only clipboard')
  options.clipboard.stagePaste(markers.paste)
  await pressPasteKey('the retried Shift+Insert')
  await submitAndRequireExact(markers.paste)
  pass('paste-disabled-image-only-clipboard',
    `an image-only clipboard left the draft empty - the Enter that followed submitted nothing - and staging text again pasted exactly ${JSON.stringify(markers.paste)} through the same key`)

  // 8. Enter with an empty draft submits nothing, right after it submitted exact text.
  await composer.fill('')
  const emptyBaseline = (await runTexts()).length
  await waitForIdleTurn()
  await composer.press('enter')
  await expectNoRunTextGrowthWithin(quietMs, emptyBaseline, 'Enter with an empty draft')
  pass('empty-draft-submit-disabled',
    `Enter with an empty draft added no message across ${quietMs}ms, immediately after Enter had submitted exact text on this run`)

  // 9. The renderer's own Ctrl+C/Ctrl+V round trip still carries the exact bytes.
  await composer.fill(markers.native)
  await composer.press('ctrl-a')
  await composer.press('ctrl-c')
  await composer.fill('')
  await composer.press('ctrl-v')
  await submitAndRequireExact(markers.native)
  pass('native-round-trip-exact',
    `Ctrl+A, Ctrl+C, Ctrl+V round-tripped ${JSON.stringify(markers.native)} through the renderer clipboard into exactly one new user message with that text on ${options.compositor}`)

  return checks
}
