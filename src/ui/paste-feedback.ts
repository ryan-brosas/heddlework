/**
 * Clipboard paste feedback shared by every surface that performs the paste itself.
 *
 * A paste shortcut that reads nothing must say so instead of disappearing. An empty clipboard and a
 * missing Linux clipboard helper both read as "no text" from here, and that silence is what makes
 * "paste does not work" undiagnosable - the terminal and the browser page both insert the text
 * themselves, so neither inherits the gesture's own feedback. The ordering rules (latest attempt
 * wins, disposal withdraws) live in `attempt-feedback.ts`; this module only binds the clipboard's
 * result shape and message, the way `copy-feedback.ts` does for writes.
 */

import { createLatestAttempt, type AttemptFailureSink, type AttemptOutcome } from './attempt-feedback.ts'

export const PASTE_FAILED_MESSAGE = "Couldn't paste: the clipboard held no text. Try again."

export type PasteFailureSink = AttemptFailureSink

/** What one paste attempt did. `stale` means a later attempt or a disposal owns the outcome. */
export type PasteOutcome = AttemptOutcome

export interface PasteAction {
  /**
   * The clipboard text to insert for this attempt, or `undefined` when nothing was read (already
   * reported through the same failure sink as a copy). A superseded or disposed attempt returns
   * nothing: a later paste owns the insertion.
   */
  readonly paste: () => Promise<string | undefined>
  /** Withdraws the action; a pending read can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create a paste action over a surface's own clipboard reader.
 *
 * `read` is the renderer's reader (`src/ui/clipboard-media.ts` or its web alias), so this module stays
 * renderer-free and both the terminal and the browser page share one paste rule.
 */
export function createPasteAction(options: {
  readonly read: () => Promise<string | undefined>
  readonly onFailure: PasteFailureSink
  readonly message?: string
}): PasteAction {
  const attempt = createLatestAttempt<{ text: string | undefined }>({
    run: async (result) => {
      result.text = await options.read()
      // No text is the outcome this action exists for, so it is reported rather than dropped.
      return result.text || false
    },
    onFailure: options.onFailure,
    message: options.message ?? PASTE_FAILED_MESSAGE,
  })
  return {
    paste: async () => {
      // Each attempt carries its own result, the way a copy carries the text it writes: a shared
      // buffer would let a superseded read hand its text, or a cleared one, to an attempt that had
      // already owned the outcome - dropping that paste or duplicating the newer one.
      const result: { text: string | undefined } = { text: undefined }
      const outcome = await attempt.run(result)
      return outcome === 'done' ? result.text : undefined
    },
    dispose: attempt.dispose,
  }
}
