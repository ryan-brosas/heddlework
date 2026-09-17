import { describe, expect, it } from 'bun:test'
import { bunTerminalAvailable, BunPtyBackend, TerminalOutputBuffer } from '../src/terminal/backend.ts'
import type { TerminalProcessStatus } from '../src/terminal/types.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { dispatchTerminalKey, type TerminalKeyEffects } from '../src/terminal/keys.ts'
import { TERMINAL_COPY_SOURCE, TERMINAL_INTERRUPT_MARKER, TERMINAL_PASTE_ECHO, TERMINAL_SMOKE_SHELL } from '../scripts/linux-terminal-smoke-contract.ts'

const describePty = bunTerminalAvailable() ? describe : describe.skip
const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

describe('terminal output buffering', () => {
  it('delivers ordinary output at microtask latency', async () => {
    const chunks: string[] = []
    const synchronized: boolean[] = []
    const output = new TerminalOutputBuffer((chunk, metadata) => {
      chunks.push(decode(chunk))
      synchronized.push(metadata.synchronizedFrame)
    })

    output.write(encode('hel'))
    output.write(encode('lo'))
    expect(chunks).toEqual([])
    await Promise.resolve()
    expect(chunks).toEqual(['hello'])
    expect(synchronized).toEqual([false])
  })

  it('coalesces fragmented DEC 2026 output into one tagged complete frame', async () => {
    const chunks: string[] = []
    const synchronized: boolean[] = []
    const output = new TerminalOutputBuffer((chunk, metadata) => {
      chunks.push(decode(chunk))
      synchronized.push(metadata.synchronizedFrame)
    })

    output.write(encode('\x1b[?20'))
    output.write(encode('26hfirst'))
    output.write(encode('-second'))
    await Promise.resolve()
    expect(chunks).toEqual([])
    output.write(encode('\x1b[?20'))
    output.write(encode('26l'))

    expect(chunks).toEqual(['\x1b[?2026hfirst-second\x1b[?2026l'])
    expect(synchronized).toEqual([true])
  })

  it('splits adjacent frames that share one transport chunk', async () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('\x1b[?2026hone\x1b[?2026l\x1b[?2026htwo'))
    await Promise.resolve()
    expect(chunks).toEqual(['\x1b[?2026hone\x1b[?2026l'])
    output.write(encode('\x1b[?2026l'))

    expect(chunks).toEqual([
      '\x1b[?2026hone\x1b[?2026l',
      '\x1b[?2026htwo\x1b[?2026l',
    ])
  })

  it('flushes an abandoned synchronized frame when closed', () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('\x1b[?2026hpartial'))
    output.close()

    expect(chunks).toEqual(['\x1b[?2026hpartial'])
  })
})

/**
 * A PTY whose data and stream-end dispatch the test controls, so the ordering Bun produces under load
 * (process exit first, final chunk second) is reproducible instead of rare.
 */
interface FakeTerminalOptions {
  data?: (terminal: unknown, chunk: Uint8Array) => void
  exit?: (terminal: unknown, exitCode: number | null, signal: string | null) => void
}

class FakeTerminal {
  static last: FakeTerminal | undefined
  closed = false
  readonly #options: FakeTerminalOptions

  constructor(options: FakeTerminalOptions = {}) {
    this.#options = options
    FakeTerminal.last = this
  }

  write(): number { return 0 }
  resize(): void {}
  close(): void { this.closed = true }
  deliver(text: string): void { this.#options.data?.(this, encode(text)) }
  end(): void { this.#options.exit?.(this, 0, null) }
}

class FakeSubprocess {
  readonly pid = 4242
  readonly exited: Promise<number>
  #resolve: ((code: number) => void) | undefined

  constructor() {
    this.exited = new Promise((resolve) => { this.#resolve = resolve })
  }

  finish(code: number): void { this.#resolve?.(code) }
  kill(): void {}
}

describePty('Bun.Terminal PTY', () => {
  it('runs a login-free shell command through the session service', async () => {
    const service = new TerminalSessionService({
      cwd: process.cwd(),
      backend: new BunPtyBackend(),
    })
    const id = await service.spawn({
      cols: 40,
      rows: 10,
      shell: '/bin/sh',
      args: ['-c', 'printf hello-pty; exit 0'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    })
    const started = Date.now()
    while (Date.now() - started < 2000) {
      const grid = service.grid(id)
      if (grid?.viewport.some((row) => row.text.includes('hello-pty'))) break
      await Bun.sleep(20)
    }
    expect(service.grid(id)?.viewport.some((row) => row.text.includes('hello-pty'))).toBe(true)
    await service.dispose()
  }, 8_000)

  /**
   * Bun resolves `subprocess.exited` before it dispatches the last chunk. Closing the PTY from the exit
   * path therefore dropped the shell's final output in 1 of 60 measured runs of `printf x; exit 0` - the
   * intermittent failure this test pins down deterministically through the injected PTY lifecycle.
   */
  it('keeps the PTY open until its stream ends, so the last output still arrives', async () => {
    const subprocess = new FakeSubprocess()
    const backend = new BunPtyBackend({
      createTerminal: FakeTerminal as never,
      spawn: (() => subprocess) as never,
    })
    const ptyProcess = await backend.spawn({ cwd: process.cwd(), cols: 40, rows: 10, shell: '/bin/sh', args: [] })
    const terminal = FakeTerminal.last!
    const chunks: string[] = []
    const statuses: TerminalProcessStatus[] = []
    ptyProcess.onData((chunk) => chunks.push(decode(chunk)))
    ptyProcess.onExit((status) => statuses.push(status))

    // The process exits first, then the PTY dispatches the bytes it had already read.
    subprocess.finish(0)
    await Bun.sleep(5)
    expect(statuses).toEqual([{ kind: 'exited', exitCode: 0 }])
    expect(terminal.closed).toBe(false)

    terminal.deliver('hello-pty')
    await Bun.sleep(5)
    expect(chunks.join('')).toBe('hello-pty')

    terminal.end()
    expect(terminal.closed).toBe(true)
  })

  const itUnix = process.platform === 'win32' ? it.skip : it
  itUnix('resizes a foreground TUI process group', async () => {
    const pty = await new BunPtyBackend().spawn({
      cwd: process.cwd(),
      cols: 40,
      rows: 10,
      shell: '/bin/bash',
      args: ['--noprofile', '--norc', '-i'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color', LC_ALL: 'C' },
    })
    let output = ''
    const stop = pty.onData((chunk) => { output += new TextDecoder().decode(chunk) })
    try {
      await Bun.sleep(100)
      pty.write("/bin/sh -c 'trap \"echo RESIZED:\\$(stty size)\" WINCH; echo READY; while :; do sleep .1; done'\n")
      const readyAt = Date.now()
      while (!output.includes('READY') && Date.now() - readyAt < 2_000) await Bun.sleep(20)
      expect(output).toContain('READY')

      pty.resize(100, 30)
      const resizedAt = Date.now()
      while (!output.includes('RESIZED:30 100') && Date.now() - resizedAt < 2_000) await Bun.sleep(20)
      expect(output).toContain('RESIZED:30 100')
    } finally {
      stop()
      pty.kill()
    }
  }, 8_000)

  itUnix('drives copy, paste, and interrupt through the production dispatch over a real PTY', async () => {
    const service = new TerminalSessionService({ cwd: process.cwd(), backend: new BunPtyBackend() })
    const id = await service.spawn({
      cols: 100,
      rows: 32,
      shell: '/bin/sh',
      args: ['-c', TERMINAL_SMOKE_SHELL],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    })
    const viewport = () => service.grid(id)?.viewport.map((row) => row.text).join('\n') ?? ''
    const sessionStatus = () => service.getStateSnapshot().sessions.find((session) => session.id === id)?.status
    const waitFor = async (description: string, predicate: () => boolean): Promise<void> => {
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        if (predicate()) return
        await Bun.sleep(20)
      }
      throw new Error(`timed out waiting for ${description}; viewport:\n${viewport()}`)
    }
    try {
      await waitFor('the PTY copy source', () => viewport().includes(TERMINAL_COPY_SOURCE))
      let copied = ''
      const effects = (overrides: Partial<TerminalKeyEffects> = {}): TerminalKeyEffects => ({
        platform: 'linux',
        grid: service.grid(id),
        write: (data) => service.write(id, data),
        copy: (text) => { copied = text },
        readPaste: async () => undefined,
        ...overrides,
      })

      // Ctrl+Shift+C copies the visible viewport and must send zero PTY bytes.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true, shift: true } }, effects())
      expect(copied).toContain(TERMINAL_COPY_SOURCE)
      expect(copied.endsWith('\n')).toBe(false)
      expect(viewport()).not.toContain(TERMINAL_PASTE_ECHO)

      // Ctrl+V returns the clipboard text to the PTY, and the child echoes the matching line back,
      // so this asserts the bytes that actually reached stdin rather than that a shortcut fired.
      dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, effects({ readPaste: async () => copied }))
      await waitFor('the paste echo', () => viewport().includes(TERMINAL_PASTE_ECHO + TERMINAL_COPY_SOURCE))

      // Plain Ctrl+C writes ETX: this raw-mode child observes the byte, not kernel SIGINT delivery.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true } }, effects())
      await waitFor('the interrupt marker', () => viewport().includes(TERMINAL_INTERRUPT_MARKER))
      await waitFor('the session exit', () => sessionStatus()?.kind === 'exited')
      expect(sessionStatus()).toEqual({ kind: 'exited', exitCode: 0 })
    } finally {
      await service.dispose()
    }
  }, 15_000)
})
