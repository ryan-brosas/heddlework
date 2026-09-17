/**
 * Clipboard copy feedback shared by every explicit copy control in the UI.
 *
 * The ordering and reporting rules live in `attempt-feedback.ts`; this module keeps the clipboard's
 * public shape and message so the message, tool, diff, and terminal copy controls cannot drift.
 */

import { createLatestAttempt, type AttemptFailureSink } from './attempt-feedback.ts'

export const COPY_FAILED_MESSAGE = "Couldn't copy to the clipboard. Try again."

/** Clipboard writer contract; declared here so this module stays renderer-free. */
export type ClipboardWriter = (text: string) => void | boolean | Promise<unknown>

export type CopyFailureSink = AttemptFailureSink

/**
 * Result of one copy attempt.
 *
 * `stale` covers both supersession and disposal: a later attempt owns the feedback state now, so
 * this attempt published nothing and a caller must not react to it.
 */
export type CopyOutcome = 'copied' | 'failed' | 'stale'

export interface CopyAction {
  /**
   * Handled copy: resolves once the outcome has been consumed and reported. Only the newest
   * attempt can resolve `copied` or `failed`; every older or disposed attempt resolves `stale`.
   */
  readonly copy: (text: string) => Promise<CopyOutcome>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create a copy action that publishes generic failure feedback for the latest active attempt and
 * resolves every older or disposed attempt as stale.
 */
export function createCopyAction(options: {
  readonly writer: ClipboardWriter
  readonly onFailure: CopyFailureSink
  readonly message?: string
}): CopyAction {
  const attempt = createLatestAttempt<string>({
    run: options.writer,
    onFailure: options.onFailure,
    message: options.message ?? COPY_FAILED_MESSAGE,
  })
  return {
    copy: async (text) => {
      const outcome = await attempt.run(text)
      return outcome === 'done' ? 'copied' : outcome
    },
    dispose: attempt.dispose,
  }
}
