import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import type { App } from '@gpuix/react/automation'
import {
  runWorkbenchKeyLane,
  workbenchKeyLaneMarkers,
  type WorkbenchKeyLaneCheck,
  type WorkbenchKeyLaneClipboard,
  type WorkbenchKeyLaneOptions,
} from '../scripts/linux-workbench-key-lane.ts'

/**
 * The lane's own assertions, run against a scripted workbench.
 *
 * The native test renderer does not exist on Linux, so the lane's automation surface is modelled here.
 * The point is not to re-test the workbench: it is to prove the lane's assertions cannot pass a no-op
 * or a nearly-right implementation, which is exactly how the replaced `getAllText`-includes and
 * trimmed-copy assertions used to pass while the clipboard was broken.
 */

// The lane polls real deadlines; a red variant waits for its own deadline to expire.
setDefaultTimeout(30_000)

const NONCE = 'a1b2c3d4'
const PLACEHOLDER = 'Ask for follow-up changes or attach images'
const COMPOSITOR = 'scripted compositor'
const QUIET_MS = 40

interface FakeWorkbenchOptions {
  /** Model a clipboard write that corrupts the selection (trim, newline, ...). */
  readonly corruptCopy?: (text: string) => string
  /** Model a copy that goes through even with no selection (the old `copied.includes('')` pass). */
  readonly copyWithoutSelection?: boolean
  /** Model a paste that changes nothing at all. */
  readonly pasteNoop?: boolean
  /** Model a paste that appends a trailing newline (the real `wl-paste` default). */
  readonly pasteAppendsNewline?: boolean
  /** Model a submit that never clears the draft. */
  readonly keepDraftAfterSubmit?: boolean
  /** Model an empty draft that resubmits the previous message. */
  readonly resubmitOnEmpty?: boolean
  /** Model a submit that stores a mutated message (the old `includes` pass). */
  readonly mutateSubmit?: (text: string) => string
}

class FakeWorkbench {
  readonly markers = workbenchKeyLaneMarkers(NONCE)
  readonly messages: string[] = []
  readonly copies: string[] = []
  /** The clipboard channel: what the app asked the helpers for, in order. */
  readonly reads: string[] = []
  draft = ''
  selection: string | null = null
  focused = true
  stagedKind: 'text' | 'image' = 'text'
  stagedText = ''
  private platformClipboard = ''
  private dragStart: number | undefined
  private readonly options: FakeWorkbenchOptions

  constructor(options: FakeWorkbenchOptions = {}) {
    this.options = options
  }

  /** The editor logs its own content (or placeholder) into the paint log; nothing else is needed. */
  paintedText(): string[] {
    return [this.draft === '' ? PLACEHOLDER : this.draft]
  }

  allText(): string[]
  {
    return ['Heddlework', ...this.messages]
  }

  private copy(text: string): void {
    const copy = this.options.corruptCopy
    this.copies.push(copy === undefined ? text : copy(text))
  }

  paste(): void {
    if (this.options.pasteNoop === true) return
    if (this.stagedKind === 'image') return
    this.draft += this.stagedText
    if (this.options.pasteAppendsNewline === true) this.draft += '\n'
  }

  submit(): void {
    if (this.draft.trim() !== '') {
      const mutate = this.options.mutateSubmit
      this.messages.push(mutate === undefined ? this.draft : mutate(this.draft))
      if (this.options.keepDraftAfterSubmit !== true) this.draft = ''
      return
    }
    if (this.options.resubmitOnEmpty === true && this.messages.length > 0) {
      this.messages.push(this.messages[this.messages.length - 1]!)
    }
  }

  pressComposer(key: string): void {
    switch (key) {
      case 'ctrl-insert':
        if (this.selection !== null) this.copy(this.selection)
        else if (this.options.copyWithoutSelection === true) this.copy('')
        return
      case 'shift-insert':
        // The app probes the clipboard whenever the paste key arrives: image attempts first, then the text
        // read the lane waits for before it submits.
        this.reads.push('image image/png', 'text text')
        if (this.focused) this.paste()
        return
      case 'enter':
        this.submit()
        return
      case 'ctrl-a':
        return
      case 'ctrl-c':
        this.platformClipboard = this.draft
        return
      case 'ctrl-v':
        this.draft += this.platformClipboard
        return
      default:
        throw new Error(`the lane pressed a key this fake does not map: ${key}`)
    }
  }

  boxes(): Array<{ x: number; y: number; width: number; height: number }> {
    return this.messages.map((_, index) => ({ x: 10, y: 100 + index * 40, width: 300, height: 30 }))
  }

  beginDrag(y: number): void {
    this.dragStart = y
  }

  endDrag(y: number): void {
    const start = this.dragStart ?? y
    this.dragStart = undefined
    const index = this.boxes().findIndex((box) => start >= box.y && start <= box.y + box.height)
    this.selection = index === -1 ? null : this.messages[index] ?? null
  }
}

function fakeApp(workbench: FakeWorkbench): { app: App; clipboard: WorkbenchKeyLaneClipboard } {
  const clipboard: WorkbenchKeyLaneClipboard = {
    copiedText: () => workbench.copies.at(-1) ?? '',
    copyWrites: () => workbench.copies.length,
    stagePaste: (text: string) => {
      workbench.stagedKind = 'text'
      workbench.stagedText = text
    },
    stageImage: () => { workbench.stagedKind = 'image' },
    helperInvocations: () => workbench.reads,
  }
  const locator = (testId: string) => ({
    waitFor: async () => ({}),
    element: async () => ({ id: testId === 'composer' ? 1 : 2 }),
    fill: async (text: string) => {
      if (testId !== 'composer') throw new Error(`the lane filled an element this fake does not serve: ${testId}`)
      workbench.draft = text
    },
    press: async (key: string) => {
      if (testId !== 'composer') throw new Error(`the lane pressed a key on an element this fake does not serve: ${testId}`)
      workbench.pressComposer(key)
    },
    bounds: async () => workbench.boxes()[0] ?? { x: 0, y: 0, width: 0, height: 0 },
    all: async () => testId === 'user-message-text'
      ? workbench.boxes().map((bounds, index) => ({ id: 100 + index, type: 'text', testId, text: workbench.messages[index], bounds }))
      // The lane gates every submit on the composer action reading `send` (idle) rather than `abort`
      // (streaming). This fake never streams, so the action is always present and idle.
      : testId === 'send' ? [{ id: 900, type: 'text', testId, bounds: { x: 0, y: 0, width: 0, height: 0 } }] : [],
  })
  const app = {
    getByTestId: locator,
    call: async (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case 'getAllText':
          return { text: workbench.allText() }
        case 'getPaintedText':
          return { text: workbench.paintedText() }
        case 'getSelectedText':
          return { text: workbench.selection }
        case 'clearSelection':
          workbench.selection = null
          return { ok: true }
        case 'blur':
          workbench.focused = false
          return { ok: true }
        case 'focus':
          workbench.focused = true
          return { ok: true }
        case 'keystrokes': {
          const keys = String(params.keys)
          if (keys !== 'shift-insert') throw new Error(`the lane sent a window keystroke this fake does not map: ${keys}`)
          if (workbench.focused) workbench.paste()
          return { ok: true }
        }
        default:
          throw new Error(`the lane called an automation method this fake does not serve: ${method}`)
      }
    },
    mouse: {
      down: async (target: { x: number; y: number }) => { workbench.beginDrag(target.y) },
      move: async () => undefined,
      up: async (target: { x: number; y: number }) => { workbench.endDrag(target.y) },
    },
  }
  return { app: app as unknown as App, clipboard }
}

async function runLane(options: FakeWorkbenchOptions = {}): Promise<{ checks: WorkbenchKeyLaneCheck[]; workbench: FakeWorkbench }> {
  const workbench = new FakeWorkbench(options)
  const { app, clipboard } = fakeApp(workbench)
  const laneOptions: WorkbenchKeyLaneOptions = {
    compositor: COMPOSITOR,
    nonce: NONCE,
    clipboard,
    negativeQuietMs: QUIET_MS,
    timeouts: { composerMs: 2_000, transcriptMs: 600, selectionMs: 400 },
  }
  const checks = await runWorkbenchKeyLane(app, laneOptions)
  return { checks, workbench }
}

const LANE_CHECK_NAMES = [
  'exact-transcript-ready',
  'ctrl-insert-copies-exact-selection',
  'copy-disabled-without-selection',
  'copy-follows-current-selection',
  'shift-insert-pastes-exact-draft',
  'duplicate-paste-keeps-exact-copies',
  'paste-disabled-without-focus',
  'paste-disabled-image-only-clipboard',
  'empty-draft-submit-disabled',
  'native-round-trip-exact',
]

describe('workbench key lane', () => {
  it('passes every exact-bytes check on a correct workbench', async () => {
    const { checks, workbench } = await runLane()
    expect(checks.map((check) => check.name)).toEqual(LANE_CHECK_NAMES)
    expect(workbench.messages).toEqual([
      workbench.markers.selection,
      workbench.markers.other,
      workbench.markers.paste,
      workbench.markers.paste + workbench.markers.paste,
      workbench.markers.paste,
      workbench.markers.paste,
      workbench.markers.native,
    ])
    expect(workbench.copies).toEqual([
      workbench.markers.selection,
      workbench.markers.other,
    ])
    expect(checks[1]!.evidence).toContain(COMPOSITOR)
    expect(checks[1]!.evidence).toContain(JSON.stringify(workbench.markers.selection))
    expect(checks[4]!.evidence).toContain(JSON.stringify(workbench.markers.paste))
  })

  it('fails a copy that only nearly matches the selection', async () => {
    await expect(runLane({ corruptCopy: (text) => `${text}\n` })).rejects.toThrow(/instead of the exact selection/)
    await expect(runLane({ corruptCopy: (text) => text.slice(1) })).rejects.toThrow(/instead of the exact selection/)
  })

  it('fails a copy that writes with no selection, which the old includes check accepted', async () => {
    await expect(runLane({ copyWithoutSelection: true })).rejects.toThrow(/with no selection wrote/)
  })

  it('fails a paste that changes nothing', async () => {
    await expect(runLane({ pasteNoop: true })).rejects.toThrow(/exactly one new user message/)
  })

  it('fails a paste that appends the trailing newline wl-paste adds by default', async () => {
    await expect(runLane({ pasteAppendsNewline: true })).rejects.toThrow(/exactly one new user message/)
  })

  it('fails a submit that leaves the draft in place, because the next Enter resubmits it', async () => {
    await expect(runLane({ keepDraftAfterSubmit: true })).rejects.toThrow(/Enter after the pasted text was submitted/)
  })

  it('fails an empty submit that resubmits the previous message', async () => {
    // The first empty Enter on this run belongs to the paste check ("and the next Enter submitted
    // nothing"), so that is where a resubmitting workbench is caught; the dedicated empty-draft check
    // later asserts the same contract after the native round trip.
    await expect(runLane({ resubmitOnEmpty: true })).rejects.toThrow(/Enter after the pasted text was submitted/)
  })

  it('fails a message that only contains the submitted text, which the old includes check accepted', async () => {
    await expect(runLane({ mutateSubmit: (text) => `${text}!` })).rejects.toThrow(/exactly one new user message/)
  })

  it('documents the replaced trimmed-includes assertions that accepted these same broken runs', () => {
    // The predicate this lane replaced: trim both sides, then ask whether the copy carries the
    // selection. It answers yes for an empty copy of an empty selection and yes for corrupted bytes.
    const replacedCopyAssertion = (copied: string, selected: string): boolean => copied.trim().includes(selected.trim())
    expect(replacedCopyAssertion('', '')).toBe(true)
    expect(replacedCopyAssertion('  marker  \n', 'marker')).toBe(true)
    // And the transcript predicate: does any text entry merely contain the marker? A message that
    // appended a nonce-breaking suffix passes it, which is why the lane now counts exact entries.
    const replacedMessageAssertion = (texts: readonly string[], marker: string): boolean => texts.some((text) => text.includes(marker))
    expect(replacedMessageAssertion(['Heddlework'], 'marker')).toBe(false)
    expect(replacedMessageAssertion(['Heddlework'], 'Heddlework')).toBe(true)
  })
})
