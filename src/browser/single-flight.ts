/**
 * Share one in-flight operation with every caller that asks while it is running.
 *
 * Chrome must be started once per app: a second launch against the same app-owned profile directory either
 * fights the first over it or fails, and the loser's failure surfaces as a browser that cannot open. Two
 * tabs opening at the same instant is the ordinary way this happens, so the shared attempt lives here with
 * its own tests rather than inside the caller where only a live browser could reach it.
 */
export class SingleFlight<T> {
  #current: Promise<T> | undefined

  /** The in-flight attempt, or a new one started by this call. */
  run(start: () => Promise<T>): Promise<T> {
    if (this.#current) return this.#current
    const attempt = start().catch((error: unknown) => {
      // A failed attempt must not be reused: the next caller retries instead of inheriting the failure.
      // Only this attempt is cleared (and only if it is still the current one): after `clear()` a newer
      // attempt may already be running, and discarding it here would let a third one start alongside it,
      // which is the double launch this class exists to prevent.
      if (this.#current === attempt) this.#current = undefined
      throw error
    })
    this.#current = attempt
    return attempt
  }

  get pending(): boolean {
    return this.#current !== undefined
  }

  /** Forget the current attempt (it finished, or its owner is gone). */
  clear(): void {
    this.#current = undefined
  }
}
