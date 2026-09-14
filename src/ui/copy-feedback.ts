/**
 * Clipboard copy feedback shared by every explicit copy control in the UI.
 *
 * A copy control must report a failed clipboard write instead of failing silently, and a later
 * attempt must win over an earlier one still in flight. This module owns both rules: it is
 * renderer-free, so the message, tool, and diff controls plus the terminal copy shortcut cannot
 * drift apart. Callers read the outcome instead of re-deriving the ordering themselves.
 */

export const COPY_FAILED_MESSAGE = "Couldn't copy to the clipboard. Try again."

/** Clipboard writer contract; declared here so this module stays renderer-free. */
export type ClipboardWriter = (text: string) => void | boolean | Promise<unknown>

export type CopyFailureSink = (failure: string | undefined) => void

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
  const { writer, onFailure, message = COPY_FAILED_MESSAGE } = options
  let attempts = 0
  let disposed = false
  const copy = async (text: string): Promise<CopyOutcome> => {
    if (disposed) return 'stale'
    const attempt = ++attempts
    // Repeating the copy is the local retry path, so a new attempt clears the old failure.
    onFailure(undefined)
    try {
      const written = await writer(text)
      if (disposed || attempt !== attempts) return 'stale'
      if (written === false) {
        onFailure(message)
        return 'failed'
      }
      return 'copied'
    } catch {
      if (disposed || attempt !== attempts) return 'stale'
      onFailure(message)
      return 'failed'
    }
  }
  const dispose = () => {
    disposed = true
  }
  return { copy, dispose }
}
