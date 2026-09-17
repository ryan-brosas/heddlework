/**
 * Shared "latest attempt wins" feedback for a UI action whose promise its caller cannot await.
 *
 * Two rules live here: an attempt that fails or is refused is reported instead of failing silently,
 * and a later attempt wins over an earlier one still in flight. The module is renderer-free, so
 * every surface that reports one of these actions - clipboard copies and external launches - cannot
 * drift apart. Callers read the outcome instead of re-deriving the ordering themselves.
 */

/** What one attempt did. `stale` means a later attempt or a disposal already owns the outcome. */
export type AttemptOutcome = 'done' | 'failed' | 'stale'

/** The attempt itself: `false`, or a rejection, means it did not take effect. */
export type AttemptRunner<T> = (value: T) => void | boolean | Promise<unknown>

/** Receives the shared failure text, or undefined when a new attempt clears the previous failure. */
export type AttemptFailureSink = (failure: string | undefined) => void

export interface LatestAttempt<T> {
  /** Runs the attempt and resolves once its outcome has been consumed and reported. */
  readonly run: (value: T) => Promise<AttemptOutcome>
  /** Withdraws the action; pending completions can no longer publish state. */
  readonly dispose: () => void
}

/**
 * Create an action that publishes `message` for the latest active attempt and resolves every older
 * or disposed attempt as stale.
 */
export function createLatestAttempt<T>(options: {
  readonly run: AttemptRunner<T>
  readonly onFailure: AttemptFailureSink
  readonly message: string
}): LatestAttempt<T> {
  const { run, onFailure, message } = options
  let attempts = 0
  let disposed = false
  const attempt = async (value: T): Promise<AttemptOutcome> => {
    if (disposed) return 'stale'
    const current = ++attempts
    // Retrying is the local recovery path, so a new attempt clears the previous failure.
    onFailure(undefined)
    try {
      const result = await run(value)
      if (disposed || current !== attempts) return 'stale'
      if (result === false) {
        onFailure(message)
        return 'failed'
      }
      return 'done'
    } catch {
      if (disposed || current !== attempts) return 'stale'
      onFailure(message)
      return 'failed'
    }
  }
  return { run: attempt, dispose: () => { disposed = true } }
}
