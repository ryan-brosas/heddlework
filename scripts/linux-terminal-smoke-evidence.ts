import type { TerminalSessionService } from '../src/terminal/service.ts'
import type { TerminalCopy } from '../src/ui/terminal-copy-feedback.ts'
import { formatTerminalSmokeEvidence, type TerminalSmokeCopyState } from './linux-terminal-smoke-contract.ts'

export interface TerminalSmokeCopyRecorder {
  readonly state: { calls: number; wroteClipboard: boolean; text: string }
  readonly write: TerminalCopy
}

/**
 * Records clipboard outcomes for the smoke evidence document.
 *
 * Shared by the native fixture view and the lane harness so `copyCalls`, `wroteClipboard` and the copied
 * payload are derived identically no matter which host drives the lane.
 */
export function createTerminalSmokeCopyRecorder(write: TerminalCopy): TerminalSmokeCopyRecorder {
  const state = { calls: 0, wroteClipboard: false, text: '' }
  return {
    state,
    write: async (text: string) => {
      state.text = text
      try {
        const outcome = await write(text)
        // `false` is the writer contract's definite failure; any other outcome counts as written.
        state.wroteClipboard = outcome !== false
        return outcome
      } catch (error) {
        state.wroteClipboard = false
        throw error
      } finally {
        // The call count is evidence of a finished attempt, not a started one: incrementing before
        // the outcome is known let a poll observe `calls: 1` while `wroteClipboard` was still false.
        state.calls += 1
      }
    },
  }
}

/** Read the evidence document from the same service state the fixture view publishes. */
export function readTerminalSmokeEvidence(
  service: TerminalSessionService,
  sessionId: string | undefined,
  copy: TerminalSmokeCopyState,
): string {
  const session = service.getStateSnapshot().sessions.find((entry) => entry.id === sessionId)
  return formatTerminalSmokeEvidence({
    text: service.grid(sessionId)?.viewport.map((row) => row.text).join('\n') ?? '',
    status: session?.status.kind ?? 'running',
    ...(session?.status.kind === 'exited' ? { exitCode: session.status.exitCode } : {}),
    copy,
  })
}
