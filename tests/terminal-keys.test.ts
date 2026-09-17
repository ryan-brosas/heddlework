import { describe, expect, it } from 'bun:test'
import { dispatchTerminalKey, encodeTerminalKey, resolveTerminalCommand, wrapBracketedPaste, type TerminalKeyEffects, type TerminalKeyEvent } from '../src/terminal/keys.ts'
import { createTerminalCopyAction, TERMINAL_COPY_FAILED_MESSAGE } from '../src/ui/terminal-copy-feedback.ts'

const ESC = String.fromCharCode(27)

describe('encodeTerminalKey', () => {
  it('encodes printable, control, navigation, and editing keys', () => {
    expect(encodeTerminalKey({ key: 'a', keyChar: 'a' })).toBe('a')
    expect(encodeTerminalKey({ key: 'enter' })).toBe('\r')
    expect(encodeTerminalKey({ key: 'c', modifiers: { ctrl: true } })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ key: 'up' })).toBe(ESC + '[A')
    expect(encodeTerminalKey({ key: 'up' }, true)).toBe(ESC + 'OA')
    expect(encodeTerminalKey({ key: 'backspace' })).toBe(String.fromCharCode(0x7f))
    expect(encodeTerminalKey({ key: 'arrowdown' })).toBe(ESC + '[B')
    expect(encodeTerminalKey({ key: 'ctrl-c' })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(3) })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(8) })).toBe(String.fromCharCode(0x7f))
  })

  it('lets the view handle copy and paste shortcuts', () => {
    expect(encodeTerminalKey({ key: 'c', modifiers: { cmd: true } })).toBeUndefined()
    expect(encodeTerminalKey({ key: 'v', modifiers: { cmd: true } })).toBeUndefined()
  })

  it('wraps bracketed paste when the emulator enabled it', () => {
    expect(wrapBracketedPaste('hi', false)).toBe('hi')
    expect(wrapBracketedPaste('hi', true)).toBe(ESC + '[200~hi' + ESC + '[201~')
  })
})

describe('resolveTerminalCommand', () => {
  // Catch-first: a copy command must never be classified as an interrupt.
  // The previous view ordered an unqualified ctrl 'c' branch before the copy
  // branch, so Linux Ctrl+Shift+C wrote ETX to the PTY instead of copying.
  it('Linux Ctrl+Shift+C is a copy, not an interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true, shift: true } }, 'linux')).toBe('copy')
  })

  it('Linux plain Ctrl+C stays exactly one interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true } }, 'linux')).toBe('interrupt')
  })

  it('resolves the compound key string form as copy', () => {
    expect(resolveTerminalCommand({ key: 'ctrl-shift-c' }, 'linux')).toBe('copy')
  })

  it('macOS Command+C is a copy and plain Ctrl+C stays an interrupt', () => {
    expect(resolveTerminalCommand({ key: 'c', modifiers: { cmd: true } }, 'darwin')).toBe('copy')
    expect(resolveTerminalCommand({ key: 'c', modifiers: { ctrl: true } }, 'darwin')).toBe('interrupt')
  })

  it('preserves paste for Cmd+V and Ctrl+V', () => {
    expect(resolveTerminalCommand({ key: 'v', modifiers: { cmd: true } }, 'darwin')).toBe('paste')
    expect(resolveTerminalCommand({ key: 'v', modifiers: { ctrl: true } }, 'linux')).toBe('paste')
    // Omarchy/Hyprland send the insert-key convention instead of Ctrl shortcuts.
    expect(resolveTerminalCommand({ key: 'insert', modifiers: { shift: true } }, 'linux')).toBe('paste')
    expect(resolveTerminalCommand({ key: 'insert', modifiers: { ctrl: true } }, 'linux')).toBe('copy')
    expect(resolveTerminalCommand({ key: 'insert', modifiers: {} }, 'linux')).toBe('none')
  })

  it('leaves ordinary keys alone', () => {
    expect(resolveTerminalCommand({ key: 'c' }, 'linux')).toBe('none')
    expect(resolveTerminalCommand({ key: 'x' }, 'linux')).toBe('none')
  })
})

describe('dispatchTerminalKey (shared production seam)', () => {
  // Exercises the SAME function TerminalView.onKeyDown calls, with injected
  // clipboard/PTY sinks, so acceptance does not depend on a native renderer.
  function run(event: TerminalKeyEvent, overrides: Partial<TerminalKeyEffects> = {}) {
    const writes: string[] = []
    const copies: string[] = []
    const effects: TerminalKeyEffects = {
      platform: 'linux',
      grid: { viewport: [{ text: 'alpha' }, { text: 'beta' }], bracketedPaste: false, applicationCursor: false },
      write: (data: string) => writes.push(data),
      copy: (text: string) => { copies.push(text) },
      readPaste: () => Promise.resolve('pasted'),
      ...overrides,
    }
    dispatchTerminalKey(event, effects)
    return { writes, copies }
  }

  it('Ctrl+Shift+C copies and writes zero PTY bytes', () => {
    const { writes, copies } = run({ key: 'c', modifiers: { ctrl: true, shift: true } })
    expect(copies).toEqual(['alpha\nbeta'])
    expect(writes).toEqual([])
  })

  it('plain Ctrl+C writes exactly one ETX and never copies', () => {
    const { writes, copies } = run({ key: 'c', modifiers: { ctrl: true } })
    expect(writes).toEqual([String.fromCharCode(3)])
    expect(copies).toEqual([])
  })

  it('ordinary keys fall through to encoding unchanged', () => {
    const { writes } = run({ key: 'x' })
    expect(writes).toEqual(['x'])
  })

  it('keeps application-cursor mode intact', () => {
    const { writes } = run({ key: 'up' }, { grid: { viewport: [{ text: '' }], applicationCursor: true } })
    expect(writes).toEqual([ESC + 'OA'])
  })

  it('writes direct text input and bracketed paste events without keyboard encoding', () => {
    expect(run({ eventType: 'textInput', keyChar: 'hi' }).writes).toEqual(['hi'])
    const bracketed = run({ eventType: 'paste', keyChar: 'hi' }, { grid: { viewport: [{ text: '' }], bracketedPaste: true } })
    expect(bracketed.writes).toEqual([ESC + '[200~hi' + ESC + '[201~'])
  })

  it('paste via Ctrl+V writes wrapped bracketed text when the emulator enabled it', async () => {
    const writes: string[] = []
    dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, {
      platform: 'linux',
      grid: { viewport: [{ text: 'a' }], bracketedPaste: true, applicationCursor: false },
      write: (data: string) => writes.push(data),
      copy: () => {},
      readPaste: () => Promise.resolve('hi'),
    })
    await Bun.sleep(1)
    expect(writes).toEqual([ESC + '[200~hi' + ESC + '[201~'])
  })

  it('a rejected paste read never becomes an unhandled rejection or a PTY write', async () => {
    const writes: string[] = []
    dispatchTerminalKey({ key: 'v', modifiers: { ctrl: true } }, {
      platform: 'linux',
      grid: { viewport: [{ text: 'a' }] },
      write: (data: string) => writes.push(data),
      copy: () => {},
      readPaste: () => Promise.reject(new Error('clipboard read failed')),
    })
    await Bun.sleep(1)
    expect(writes).toEqual([])
  })
})

describe('terminal copy feedback (production action)', () => {
  // The failure behavior is part of the contract: a failed copy reports an
  // error and never falls through to interrupt. These run the production
  // dispatch seam through the real createTerminalCopyAction adapter.
  const COPY_KEY: TerminalKeyEvent = { key: 'c', modifiers: { ctrl: true, shift: true } }
  const INTERRUPT_KEY: TerminalKeyEvent = { key: 'c', modifiers: { ctrl: true } }

  function setup(writer: (text: string) => boolean | void | Promise<unknown>) {
    const failures: Array<string | undefined> = []
    const writes: string[] = []
    let writerCalls = 0
    const action = createTerminalCopyAction({
      writer: (text: string) => {
        writerCalls += 1
        return writer(text)
      },
      onFailure: (failure) => failures.push(failure),
    })
    const effects: TerminalKeyEffects = {
      platform: 'linux',
      grid: { viewport: [{ text: 'SECRET-PAYLOAD-a1' }], bracketedPaste: false, applicationCursor: false },
      write: (data: string) => writes.push(data),
      copy: action.copy,
      readPaste: () => Promise.resolve('pasted'),
    }
    return { action, effects, failures, writes, calls: () => writerCalls }
  }

  it('publishes one generic failure with zero PTY bytes when the writer resolves false', async () => {
    const { effects, failures, writes } = setup(() => false)
    dispatchTerminalKey(COPY_KEY, effects)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
    expect(writes).toEqual([])
  })

  it('treats rejection and synchronous throw as the same generic failure without PTY writes', async () => {
    const rejected = setup(() => Promise.reject(new Error('clipboard helper exploded')))
    dispatchTerminalKey(COPY_KEY, rejected.effects)
    await Bun.sleep(1)
    expect(rejected.failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
    expect(rejected.writes).toEqual([])

    const thrown = setup(() => {
      throw new Error('boom before promise')
    })
    dispatchTerminalKey(COPY_KEY, thrown.effects)
    await Bun.sleep(1)
    expect(thrown.failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
    expect(thrown.writes).toEqual([])
  })

  it('publishes nothing on success and clears a previous failure on the next attempt', async () => {
    let result = false
    const { effects, failures } = setup(() => result)
    dispatchTerminalKey(COPY_KEY, effects)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
    result = true
    dispatchTerminalKey(COPY_KEY, effects)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE, undefined])
  })

  it('keeps plain Ctrl+C immediate while a copy is pending; the late failure adds no PTY bytes', async () => {
    let settle!: (value: boolean) => void
    const { effects, failures, writes } = setup(() => new Promise<boolean>((resolve) => { settle = resolve }))
    dispatchTerminalKey(COPY_KEY, effects)
    dispatchTerminalKey(INTERRUPT_KEY, effects)
    expect(writes).toEqual([String.fromCharCode(3)])
    settle(false)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
    expect(writes).toEqual([String.fromCharCode(3)])
  })

  it('ignores stale completions and publishes nothing after disposal', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    const { action, effects, failures, calls } = setup(() => new Promise<boolean>((resolve) => { resolvers.push(resolve) }))
    dispatchTerminalKey(COPY_KEY, effects)
    dispatchTerminalKey(COPY_KEY, effects)
    resolvers[1]!(false)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, undefined, TERMINAL_COPY_FAILED_MESSAGE])
    // The older attempt completing late cannot overwrite newer feedback.
    resolvers[0]!(false)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, undefined, TERMINAL_COPY_FAILED_MESSAGE])

    dispatchTerminalKey(COPY_KEY, effects)
    action.dispose()
    resolvers[2]!(false)
    await Bun.sleep(1)
    expect(failures).toEqual([undefined, undefined, TERMINAL_COPY_FAILED_MESSAGE, undefined])
    // A disposed action is inert and never reaches its writer again.
    await action.copy('after dispose')
    expect(calls()).toBe(3)
  })

  it('publishes no clipboard payload or exception detail', async () => {
    const { action, failures } = setup(() => Promise.reject(new Error('secret-exception-detail')))
    await action.copy('SECRET-PAYLOAD-z9')
    const published = failures.join(' ')
    expect(published).toContain(TERMINAL_COPY_FAILED_MESSAGE)
    expect(published).not.toContain('SECRET-PAYLOAD')
    expect(published).not.toContain('secret-exception-detail')
  })
})
