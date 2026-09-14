import { describe, expect, it } from 'bun:test'
import { BunPtyBackend, bunTerminalAvailable } from '../src/terminal/backend.ts'
import { dispatchTerminalKey, type TerminalKeyEffects } from '../src/terminal/keys.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { TERMINAL_COPY_SOURCE, TERMINAL_EVIDENCE_TEST_ID, TERMINAL_INTERRUPT_MARKER, TERMINAL_PASTE_ECHO, TERMINAL_SMOKE_SHELL } from '../scripts/linux-terminal-smoke-contract.ts'
import { createTerminalSmokeCopyRecorder, readTerminalSmokeEvidence } from '../scripts/linux-terminal-smoke-evidence.ts'
import { runTerminalShortcutLane, type TerminalLaneApp, type TerminalLaneNode } from '../scripts/linux-terminal-smoke-lane.ts'

const describePty = bunTerminalAvailable() ? describe : describe.skip

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number, description: string): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`)
}

/**
 * Runs the lane's own assertions on Linux without a compositor.
 *
 * Only two things are simulated: the automation transport and the GPUIX renderer. The PTY, the smoke
 * shell, the shortcut dispatch, the clipboard recorder and the evidence document are the same code the
 * native fixture uses, which is what keeps the manual compositor lane honest between runs. The key names
 * the lane presses are mapped back onto the production dispatch, so a lane that pressed the wrong key
 * fails here instead of passing silently.
 */
describePty('linux terminal smoke lane harness', () => {
  it('satisfies every lane assertion through the shared evidence path', async () => {
    const service = new TerminalSessionService({ cwd: process.cwd(), backend: new BunPtyBackend() })
    const sessionId = await service.spawn({
      cols: 100,
      rows: 32,
      shell: '/bin/sh',
      args: ['-c', TERMINAL_SMOKE_SHELL],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    })
    let pasted = ''
    const recorder = createTerminalSmokeCopyRecorder((text: string) => {
      pasted = text
      return true
    })
    const effects = (): TerminalKeyEffects => ({
      platform: 'linux',
      grid: service.grid(sessionId),
      write: (data) => service.write(sessionId, data),
      copy: recorder.write,
      readPaste: async () => pasted || undefined,
    })
    const press = async (key: string): Promise<void> => {
      if (key === 'ctrl-shift-c') dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true, shift: true } }, effects())
      else if (key === 'ctrl-v') dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, effects())
      else if (key === 'ctrl-c') dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true } }, effects())
      else throw new Error(`the lane pressed a key this harness does not map: ${key}`)
    }
    const idle: Pick<TerminalLaneNode, 'waitFor' | 'click' | 'press'> = {
      waitFor: async () => undefined,
      click: async () => undefined,
      press,
    }
    const app: TerminalLaneApp = {
      getByTestId(testId: string): TerminalLaneNode {
        if (testId === 'terminal-input-bottom') return { ...idle, count: async () => 1, textContent: async () => '' }
        if (testId === 'terminal-copy-failure-bottom') return { ...idle, count: async () => 0, textContent: async () => '' }
        if (testId === TERMINAL_EVIDENCE_TEST_ID) {
          return {
            ...idle,
            count: async () => 1,
            textContent: async () => readTerminalSmokeEvidence(service, sessionId, recorder.state),
          }
        }
        throw new Error(`the lane queried a test id this harness does not serve: ${testId}`)
      },
    }
    try {
      const checks = await runTerminalShortcutLane(app, {
        compositor: 'local PTY harness',
        backend: 'wayland',
        waitFor: poll,
      })
      expect(checks.map((check) => check.name)).toEqual([
        'terminal-session-ready',
        'terminal-copy-shortcut',
        'terminal-paste-shortcut',
        'terminal-interrupt-shortcut',
      ])
      expect(checks[0]!.evidence).toContain("local PTY harness")
      expect(checks[2]!.evidence).toContain(TERMINAL_PASTE_ECHO + TERMINAL_COPY_SOURCE)
      expect(checks[3]!.evidence).toContain(TERMINAL_INTERRUPT_MARKER)
      expect(pasted).toContain(TERMINAL_COPY_SOURCE)
    } finally {
      await service.dispose()
    }
  }, 20_000)
})
