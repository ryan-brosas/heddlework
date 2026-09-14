/**
 * Terminal-local copy failure feedback.
 *
 * A terminal copy shortcut must report a failed clipboard write instead of failing
 * silently, and must never fall through to a PTY interrupt. The ordering rule itself
 * lives in `copy-feedback.ts` so the tool, diff, message, and terminal copy controls
 * share one implementation; this module only binds the terminal's own message.
 */

import { createCopyAction, type ClipboardWriter, type CopyAction, type CopyFailureSink } from './copy-feedback.ts'

export const TERMINAL_COPY_FAILED_MESSAGE = "Couldn't copy visible terminal text. Try again."

/** Clipboard writer contract; re-exported so terminal callers keep one import site. */
export type TerminalCopy = ClipboardWriter

export type TerminalCopyFailureSink = CopyFailureSink

export type TerminalCopyAction = CopyAction

/**
 * Create a copy action that publishes generic failure feedback for the latest
 * active attempt and ignores stale or disposed completions.
 */
export function createTerminalCopyAction(options: {
  readonly writer: TerminalCopy
  readonly onFailure: TerminalCopyFailureSink
}): TerminalCopyAction {
  return createCopyAction({ ...options, message: TERMINAL_COPY_FAILED_MESSAGE })
}
