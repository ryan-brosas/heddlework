import {
  countOccurrences,
  parseTerminalSmokeEvidence,
  TERMINAL_COPY_SOURCE,
  TERMINAL_EVIDENCE_TEST_ID,
  TERMINAL_INTERRUPT_MARKER,
  TERMINAL_PASTE_ECHO,
  type TerminalSmokeEvidence,
} from './linux-terminal-smoke-contract.ts'

/** The automation surface the lane needs; both `@gpuix/react/automation` clients satisfy it. */
export interface TerminalLaneNode {
  waitFor(options?: { timeoutMs?: number }): Promise<unknown>
  click(): Promise<void>
  press(key: string): Promise<void>
  count(): Promise<number>
  textContent(): Promise<string>
}

export interface TerminalLaneApp {
  getByTestId(testId: string): TerminalLaneNode
}

export interface TerminalLaneCheck {
  readonly name: string
  readonly evidence: string
}

export interface TerminalLaneOptions {
  readonly compositor: string
  readonly backend: string
  /**
   * Retry helper supplied by the host, so the lane shares the host's polling semantics instead of
   * carrying a second one. Reads may throw while the surface is still mounting; only the deadline is
   * fatal.
   */
  readonly waitFor: <T>(read: () => Promise<T | undefined>, timeoutMs: number, description: string) => Promise<T>
}

/**
 * Assert the shipped Linux terminal shortcut contract through whichever app is driving the production
 * `TerminalView`: `scripts/linux-window-smoke.ts` on real compositors, and
 * `tests/linux-terminal-smoke-lane.test.tsx` in-process against the local renderer. Both run this one
 * implementation, so the compositor-only assertions cannot drift from something CI can execute locally.
 *
 * Throws on the first failed assertion; returns the lane's report checks on success.
 */
export async function runTerminalShortcutLane(app: TerminalLaneApp, options: TerminalLaneOptions): Promise<TerminalLaneCheck[]> {
  const checks: TerminalLaneCheck[] = []
  const pass = (name: string, evidence: string) => { checks.push({ name, evidence }) }
  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
  }
  const nextEvidence = (accept: (value: TerminalSmokeEvidence) => TerminalSmokeEvidence | undefined) =>
    options.waitFor(
      async () => accept(parseTerminalSmokeEvidence(await app.getByTestId(TERMINAL_EVIDENCE_TEST_ID).textContent())),
      10_000,
      'terminal evidence transition',
    )

  const terminalInput = app.getByTestId('terminal-input-bottom')
  await terminalInput.waitFor()
  const sessionReady = await nextEvidence((value) => value.text.includes(TERMINAL_COPY_SOURCE) ? value : undefined)
  assert(sessionReady.status === 'running', `terminal PTY was ${sessionReady.status} before the shortcut checks`)
  assert(sessionReady.copyCalls === 0, 'a terminal copy happened before any shortcut was pressed')
  pass(
    'terminal-session-ready',
    `real PTY on ${options.compositor} printed ${TERMINAL_COPY_SOURCE} into a ${options.backend} terminal hosted by the production TerminalView`,
  )

  await terminalInput.click()
  await terminalInput.press('ctrl-shift-c')
  const copied = await nextEvidence((value) => value.copyCalls > sessionReady.copyCalls ? value : undefined)
  assert(copied.wroteClipboard, 'Ctrl+Shift+C did not reach the operating-system clipboard (wl-copy/xclip reported failure)')
  assert(copied.copiedMarker, 'Ctrl+Shift+C copied text that does not contain the terminal marker')
  assert(countOccurrences(copied.text, TERMINAL_PASTE_ECHO) === 0, 'Ctrl+Shift+C wrote bytes to the PTY; copy must send zero input')
  assert(copied.status === 'running', `Ctrl+Shift+C changed the terminal status to ${copied.status}`)
  assert((await app.getByTestId('terminal-copy-failure-bottom').count()) === 0, 'Ctrl+Shift+C reported copy-failure feedback')
  pass(
    'terminal-copy-shortcut',
    `Ctrl+Shift+C produced ${copied.copyCalls} clipboard payload(s) accepted by the OS clipboard, with zero PTY bytes and no failure feedback`,
  )

  await terminalInput.press('ctrl-v')
  const pasted = await nextEvidence((value) => value.text.includes(TERMINAL_PASTE_ECHO + TERMINAL_COPY_SOURCE) ? value : undefined)
  assert(pasted.copyCalls === copied.copyCalls, 'Ctrl+V was resolved as a copy instead of a paste')
  pass('terminal-paste-shortcut', `Ctrl+V read the OS clipboard and the PTY echoed ${TERMINAL_PASTE_ECHO}${TERMINAL_COPY_SOURCE}`)

  await terminalInput.press('ctrl-c')
  const interrupted = await nextEvidence((value) => value.status === 'exited' ? value : undefined)
  assert(interrupted.text.includes(TERMINAL_INTERRUPT_MARKER), 'plain Ctrl+C did not reach the PTY as the one ETX byte the shortcut owns')
  assert(interrupted.copyCalls === copied.copyCalls, 'plain Ctrl+C was resolved as a copy')
  assert(interrupted.exitCode === 0, `the interrupt trap exited with code ${interrupted.exitCode}`)
  pass(
    'terminal-interrupt-shortcut',
    `plain Ctrl+C delivered one ETX byte, the PTY child trapped ${TERMINAL_INTERRUPT_MARKER}, and the session exited 0`,
  )

  return checks
}
