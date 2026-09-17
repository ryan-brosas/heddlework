import { describe, expect, it } from 'bun:test'
import { bunTerminalAvailable, BunPtyBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { dispatchTerminalKey, type TerminalKeyEffects } from '../src/terminal/keys.ts'

/**
 * The production clipboard dispatch over a real PTY.
 *
 * `tests/terminal-keys.test.ts` pins the resolution rules against injected sinks; this suite
 * pins the bytes that actually reach a child process, because a shortcut that leaked the
 * interrupt byte while also copying would still look like a passing copy in a fake sink.
 *
 * The child reads raw bytes (`stty -isig`), so the assertions hold wherever the suite runs:
 * interrupt delivery as a kernel `SIGINT` needs the PTY slave to own a foreground process
 * group (`tpgid`), which a container or CI lane does not provide. That part stays a manual
 * acceptance step; what the application owns is the single ETX byte asserted here.
 */
const describePty = bunTerminalAvailable() ? describe : describe.skip

const EXPECTED = 'HEDDLEWORK_CLIPBOARD_SOURCE'
const PASTE_REPORT = 'CLIPBOARD_PASTE_OK'
const INTERRUPT_REPORT = 'CLIPBOARD_INTERRUPT_OK'
const UNEXPECTED_REPORT = 'CLIPBOARD_UNEXPECTED_BYTES'

const CHILD = [
  `ETX=$(printf '\\003')`,
  `MARKER=${EXPECTED}`,
  `stty -isig -icanon min 1 time 0 -echo 2>/dev/null`,
  `printf '%s\\n' "$MARKER"`,
  `window=''`,
  `while :; do`,
  `  chunk=$(dd bs=4096 count=1 2>/dev/null)`,
  `  window="$window$chunk"`,
  `  case "$window" in`,
  `    "$ETX") printf '\\n%s\\n' ${INTERRUPT_REPORT}; exit 0;;`,
  `    *"$ETX"*) printf '\\n%s\\n' ${UNEXPECTED_REPORT}; exit 3;;`,
  `  esac`,
  `  case "$window" in *"$MARKER"*) printf '%s\\n' ${PASTE_REPORT}; window='';; esac`,
  `  [ -n "$chunk" ] || break`,
  `  [ \"\${#window}\" -le 4096 ] || window=$(printf '%s' "$window" | tail -c 4096)`,
  `done`,
].join('\n')

const itUnix = process.platform === 'win32' ? it.skip : it

describePty('terminal clipboard dispatch over a real PTY', () => {
  itUnix('copies without writing PTY bytes, pastes into stdin, and interrupts with one ETX', async () => {
    const service = new TerminalSessionService({ cwd: process.cwd(), backend: new BunPtyBackend() })
    const id = await service.spawn({
      cols: 100,
      rows: 32,
      shell: '/bin/sh',
      args: ['-c', CHILD],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    })
    const viewport = (): string => service.grid(id)?.viewport.map((row) => row.text).join('\n') ?? ''
    const status = () => service.getStateSnapshot().sessions.find((session) => session.id === id)?.status
    const waitFor = async (description: string, predicate: () => boolean): Promise<void> => {
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        if (predicate()) return
        await Bun.sleep(20)
      }
      throw new Error(`timed out waiting for ${description}; viewport:\n${viewport()}`)
    }
    try {
      await waitFor('the copyable marker', () => viewport().includes(EXPECTED))
      let copied = ''
      const effects = (overrides: Partial<TerminalKeyEffects> = {}): TerminalKeyEffects => ({
        platform: 'linux',
        grid: service.grid(id),
        write: (data) => service.write(id, data),
        copy: (text) => { copied = text },
        readPaste: async () => undefined,
        ...overrides,
      })

      // Copy resolves to the viewport and must send zero bytes: the child never reports a paste
      // or an interrupt, and the tapped text is what the terminal is showing.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true, shift: true } }, effects())
      expect(copied).toContain(EXPECTED)
      await Bun.sleep(50)
      expect(viewport()).not.toContain(PASTE_REPORT)
      expect(viewport()).not.toContain(INTERRUPT_REPORT)

      // Paste writes the clipboard text to the child, which echoes a report line back, so this
      // asserts the bytes that reached stdin rather than that a handler fired.
      dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, effects({ readPaste: async () => copied }))
      await waitFor('the paste report', () => viewport().includes(PASTE_REPORT))

      // A second copy after a paste still adds no PTY bytes.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true, shift: true } }, effects())
      await Bun.sleep(50)
      expect(viewport()).not.toContain(UNEXPECTED_REPORT)

      // Plain Ctrl+C remains exactly one ETX: the child reports any other byte as a failure.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true } }, effects())
      await waitFor('the interrupt report', () => viewport().includes(INTERRUPT_REPORT))
      expect(viewport()).not.toContain(UNEXPECTED_REPORT)
      await waitFor('the session exit', () => status()?.kind === 'exited')
    } finally {
      await service.dispose()
    }
  }, 20_000)
})
