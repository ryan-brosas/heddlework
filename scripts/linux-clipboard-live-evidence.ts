/** A clipboard helper result: the bytes are only meaningful when the command succeeded. */
export interface ClipboardRead {
  readonly code: number
  readonly stdout: string
}

export interface ClipboardVerdict {
  readonly status: 'pass' | 'skip' | 'fail' | 'inconclusive'
  readonly evidence: string
}

/**
 * The pinned runtime's own diagnostic for a gesture that carried no Wayland selection serial. Only a real
 * key or pointer press produces one, so a press delivered through the automation surface cannot own the
 * clipboard. Measured 2026-09-15 on the installed build: this diagnostic is NOT observable in the app's
 * stderr (`log::warn!` has no logger wired to it), so it can corroborate the reason but never be required.
 * The primary-selection wording is a different claim and must not satisfy it.
 */
export const NATIVE_CLIPBOARD_NO_SERIAL_WARNING =
  'Skipping Wayland clipboard ownership request because no keyboard or pointer press serial has been received'

export function reportsMissingSelectionSerial(stderrSinceGesture: string): boolean {
  return stderrSinceGesture.includes(NATIVE_CLIPBOARD_NO_SERIAL_WARNING)
}

/**
 * Why a staged clipboard value cannot be trusted. A helper that failed, timed out (code -1) or returned
 * different bytes leaves the next assertion measuring the harness rather than the application: a sentinel
 * that never landed would otherwise satisfy an equality check on its own and prove nothing.
 */
export function clipboardStageError(
  writer: { readonly code: number },
  read: ClipboardRead,
  expected: string,
): string | undefined {
  if (writer.code !== 0) return `staging failed: wl-copy exited ${String(writer.code)}`
  if (read.code !== 0) return `staging unverified: wl-paste exited ${String(read.code)}`
  if (read.stdout !== expected) {
    return `staging unverified: the clipboard holds ${JSON.stringify(read.stdout)} instead of ${JSON.stringify(expected)}`
  }
  return undefined
}

/**
 * Decide the native-copy check from one external read of the session clipboard.
 *
 * Order matters: a helper that did not succeed can never be evidence of a copy, an unusable selection is a
 * harness gap, wrong bytes are the application's failure, and an unchanged clipboard is manual coverage. The
 * skip records whether the runtime's own missing-serial diagnostic was seen, so a reader can tell a measured
 * reason from a source-documented one instead of reading silence as proof.
 */
export function classifyNativeCopy(input: {
  readonly selectedText: string
  readonly sentinel: string
  readonly read: ClipboardRead
  readonly stderrSinceGesture: string
}): ClipboardVerdict {
  const { selectedText, sentinel, read, stderrSinceGesture } = input
  if (read.code !== 0) {
    return { status: 'inconclusive', evidence: `wl-paste exited ${String(read.code)}, so the clipboard was not read` }
  }
  // Only an exact collision is ambiguous: pass and skip would then both match the same bytes. A selection
  // that merely contains the sentinel stays distinguishable, because every comparison here is byte-exact.
  if (selectedText === '' || sentinel === '' || selectedText === sentinel) {
    return {
      status: 'inconclusive',
      evidence: `the dragged selection ${JSON.stringify(selectedText)} cannot be told apart from the staged sentinel ${JSON.stringify(sentinel)}`,
    }
  }
  if (read.stdout === selectedText) {
    return { status: 'pass', evidence: `the clipboard held exactly the dragged selection ${JSON.stringify(selectedText)}` }
  }
  if (read.stdout === sentinel) {
    // Unchanged bytes are never a copy, but they are also not a demonstrated application failure: an
    // automation press carries no compositor serial, so a runtime that declines to own the clipboard is
    // indistinguishable here from one that failed to. The named skip says which reason was actually observed.
    const diagnostic = reportsMissingSelectionSerial(stderrSinceGesture)
      ? 'the runtime reported no keyboard or pointer press serial for this gesture'
      : 'the runtime\'s missing-serial diagnostic was not observable on this build, so the reason is documented in the pinned source rather than measured'
    return {
      status: 'skip',
      evidence: `the clipboard still held the staged sentinel; ${diagnostic}, and a physical key press is the only stimulus that can prove native copy`,
    }
  }
  return {
    status: 'fail',
    evidence: `the clipboard held ${JSON.stringify(read.stdout)} instead of the dragged selection ${JSON.stringify(selectedText)}`,
  }
}

/**
 * Identify the artifact a launch really runs, so evidence cannot be attributed to a different build: the
 * installer's launcher resolves to the executable it execs, and a running process is identified by the
 * image at `/proc/<pid>/exe`.
 */
export interface RunningArtifact {
  readonly pid: number
  /** The image at `/proc/<pid>/exe`, or undefined when it could not be read. */
  readonly image: string | undefined
}

/**
 * One line per candidate artifact. Every running process is listed and the match covers all of them: a stale
 * window must not be attributed to the artifact under test just because it was the first PID found.
 */
export function describeArtifact(input: {
  readonly path: string
  readonly exists: boolean
  readonly sha256: string
  readonly launchedFrom?: string | undefined
  readonly running?: readonly RunningArtifact[]
  readonly error?: string | undefined
}): string {
  // A launcher whose target is gone cannot be identified at all; that is a finding, not a crash.
  if (input.error !== undefined) return `${input.path}: cannot identify the artifact (${input.error})`
  if (!input.exists) return `${input.path}: missing`
  const launch = input.launchedFrom === undefined ? '' : ` launcher=${input.launchedFrom}`
  const running = input.running ?? []
  if (running.length === 0) return `${input.path} sha256=${input.sha256}${launch} not running`
  const listed = running.map((entry) => `${String(entry.pid)}@${entry.image ?? 'unreadable'}`).join(',')
  const allMatch = running.every((entry) => entry.image === input.path)
  return `${input.path} sha256=${input.sha256}${launch} running=${listed} allMatchArtifact=${String(allMatch)}`
}
