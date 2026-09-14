/**
 * Terminal-local copy failure feedback.
 *
 * A terminal copy shortcut must report a failed clipboard write instead of
 * failing silently, and must never fall through to a PTY interrupt. This is a
 * narrow, renderer-free adapter: it consumes the writer's outcome, converts
 * every definite failure (resolved `false`, synchronous throw, rejected
 * promise) into one generic local error, and ignores stale completions so an
 * older attempt cannot overwrite newer feedback.
 */

export const TERMINAL_COPY_FAILED_MESSAGE = "Couldn't copy visible terminal text. Try Copy again."

/** Clipboard writer contract; declared here so this adapter stays renderer-free. */
export type TerminalCopy = (text: string) => void | boolean | Promise<unknown>

export type TerminalCopyFailureSink = (failure: string | undefined) => void

export interface TerminalCopyAction {
  /** Handled copy: resolves once the outcome has been consumed and reported. */
  readonly copy: (text: string) => Promise<void>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create a copy action that publishes generic failure feedback for the latest
 * active attempt and ignores stale or disposed completions.
 */
export function createTerminalCopyAction(options: {
  readonly writer: TerminalCopy
  readonly onFailure: TerminalCopyFailureSink
}): TerminalCopyAction {
  const { writer, onFailure } = options
  let attempts = 0
  let disposed = false
  const copy = async (text: string): Promise<void> => {
    if (disposed) return
    const attempt = ++attempts
    // Repeating the Copy shortcut is the local retry path, so a new attempt
    // clears the previous failure.
    onFailure(undefined)
    try {
      const outcome = await writer(text)
      if (disposed || attempt !== attempts) return
      if (outcome === false) onFailure(TERMINAL_COPY_FAILED_MESSAGE)
    } catch {
      if (disposed || attempt !== attempts) return
      onFailure(TERMINAL_COPY_FAILED_MESSAGE)
    }
  }
  const dispose = () => {
    disposed = true
  }
  return { copy, dispose }
}
