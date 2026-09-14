/**
 * Clipboard copy feedback shared by every explicit copy control in the UI.
 *
 * A copy control must report a failed clipboard write instead of failing silently, and a
 * later attempt must win over an earlier one still in flight. This module is the single
 * owner of that ordering rule; renderer-free, so the message/tool/diff controls and the
 * terminal copy shortcut cannot drift apart.
 */

export const COPY_FAILED_MESSAGE = "Couldn't copy to the clipboard. Try again."

/** Clipboard writer contract; declared here so this module stays renderer-free. */
export type ClipboardWriter = (text: string) => void | boolean | Promise<unknown>

export type CopyFailureSink = (failure: string | undefined) => void

export interface CopyAction {
  /** Handled copy: resolves once the outcome has been consumed and reported. */
  readonly copy: (text: string) => Promise<boolean>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create a copy action that publishes generic failure feedback for the latest active
 * attempt and ignores stale or disposed completions. Resolves `true` when the write
 * succeeded so a caller can show a transient success state.
 */
export function createCopyAction(options: {
  readonly writer: ClipboardWriter
  readonly onFailure: CopyFailureSink
  readonly message?: string
}): CopyAction {
  const { writer, onFailure, message = COPY_FAILED_MESSAGE } = options
  let attempts = 0
  let disposed = false
  const copy = async (text: string): Promise<boolean> => {
    if (disposed) return false
    const attempt = ++attempts
    // Repeating the copy is the local retry path, so a new attempt clears the old failure.
    onFailure(undefined)
    try {
      const outcome = await writer(text)
      if (disposed || attempt !== attempts) return false
      if (outcome === false) {
        onFailure(message)
        return false
      }
      return true
    } catch {
      if (disposed || attempt !== attempts) return false
      onFailure(message)
      return false
    }
  }
  const dispose = () => {
    disposed = true
  }
  return { copy, dispose }
}
