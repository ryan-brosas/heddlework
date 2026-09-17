/**
 * Terminal copy failure feedback.
 *
 * A terminal copy shortcut must report a failed clipboard write instead of failing
 * silently, and must never fall through to a PTY interrupt. This module owns the
 * ordering rule: only the newest attempt can publish feedback, so a stale or disposed
 * completion cannot overwrite a newer one, and the published message is generic - never
 * the clipboard payload or an exception detail.
 */

export const TERMINAL_COPY_FAILED_MESSAGE = "Couldn't copy visible terminal text. Try again."

/** Clipboard writer contract; declared here so this module stays renderer-free. */
export type TerminalCopy = (text: string) => void | boolean | Promise<unknown>

export type TerminalCopyFailureSink = (failure: string | undefined) => void

/**
 * Result of one copy attempt.
 *
 * `stale` covers both supersession and disposal: a later attempt owns the feedback state now,
 * so this attempt published nothing and a caller must not react to it.
 */
export type TerminalCopyOutcome = 'copied' | 'failed' | 'stale'

export interface TerminalCopyAction {
  /**
   * Handled copy: resolves once the outcome has been consumed and reported. Only the newest
   * attempt can resolve `copied` or `failed`; every older or disposed attempt resolves `stale`.
   */
  readonly copy: (text: string) => Promise<TerminalCopyOutcome>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create a copy action that publishes generic failure feedback for the latest active attempt and
 * resolves every older or disposed attempt as stale.
 */
export function createTerminalCopyAction(options: {
  readonly writer: TerminalCopy
  readonly onFailure: TerminalCopyFailureSink
}): TerminalCopyAction {
  const { writer, onFailure } = options
  let attempts = 0
  let disposed = false
  const copy = async (text: string): Promise<TerminalCopyOutcome> => {
    if (disposed) return 'stale'
    const attempt = ++attempts
    // Repeating the copy is the local retry path, so a new attempt clears the old failure.
    onFailure(undefined)
    try {
      const written = await writer(text)
      if (disposed || attempt !== attempts) return 'stale'
      if (written === false) {
        onFailure(TERMINAL_COPY_FAILED_MESSAGE)
        return 'failed'
      }
      return 'copied'
    } catch {
      if (disposed || attempt !== attempts) return 'stale'
      onFailure(TERMINAL_COPY_FAILED_MESSAGE)
      return 'failed'
    }
  }
  const dispose = () => {
    disposed = true
  }
  return { copy, dispose }
}
