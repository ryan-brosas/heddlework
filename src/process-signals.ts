/**
 * Node and Bun pass the signal name ("SIGINT"/"SIGTERM") to every listener registered for the
 * signal. Shutdown handlers therefore must not treat their first argument as a failure cause, or a
 * clean Ctrl+C is reported as a failed shutdown and the process exits non-zero.
 */
export function shutdownListener(shutdown: (error?: unknown) => void): () => void {
  return () => shutdown()
}
