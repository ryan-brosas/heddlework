import { describe, expect, it } from 'bun:test'
import { bunTerminalAvailable, BunPtyBackend, TerminalOutputBuffer } from '../src/terminal/backend.ts'
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
      expect(viewport()).not.toContain(TERMINAL_PASTE_ECHO)

      // Ctrl+V returns the clipboard text to the PTY, and the child echoes the matching line back,
      // so this asserts the bytes that actually reached stdin rather than that a shortcut fired.
      dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, effects({ readPaste: async () => copied }))
      await waitFor('the paste echo', () => viewport().includes(TERMINAL_PASTE_ECHO + TERMINAL_COPY_SOURCE))

      // Plain Ctrl+C stays an interrupt: the child traps SIGINT and exits cleanly.
      dispatchTerminalKey({ key: 'c', modifiers: { ctrl: true } }, effects())
      await waitFor('the interrupt marker', () => viewport().includes(TERMINAL_INTERRUPT_MARKER))
      await waitFor('the session exit', () => sessionStatus()?.kind === 'exited')
      expect(sessionStatus()).toEqual({ kind: 'exited', exitCode: 0 })
    } finally {
      await service.dispose()
    }
  }, 15_000)
})
