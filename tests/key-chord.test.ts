import { describe, expect, it } from 'bun:test'
import { parseKeyChord } from '../src/ui/key-chord.ts'

// The same parser reads a chord that carries its modifiers inside the key string (ctrl-shift-c) and a
// bare key that is itself a separator character (+ or -), so both readings are pinned here.
const NONE = { ctrl: false, alt: false, cmd: false, shift: false }

describe('parseKeyChord', () => {
  it('reads modifiers that travel inside the key string', () => {
    expect(parseKeyChord('ctrl-shift-c')).toEqual({ key: 'c', modifiers: { ...NONE, ctrl: true, shift: true } })
    expect(parseKeyChord('super-insert')).toEqual({ key: 'insert', modifiers: { ...NONE, cmd: true } })
    expect(parseKeyChord('CTRL-C')).toEqual({ key: 'c', modifiers: { ...NONE, ctrl: true } })
  })

  it('treats a lone separator character as the key itself', () => {
    // Splitting "+" on the separator produces no tokens. Falling back to the empty token would make
    // Shift+= and the minus key encode nothing; the original text is the key.
    expect(parseKeyChord('+')).toEqual({ key: '+', modifiers: NONE })
    expect(parseKeyChord('-')).toEqual({ key: '-', modifiers: NONE })
  })

  it('returns an empty key and no modifiers for empty input', () => {
    expect(parseKeyChord('')).toEqual({ key: '', modifiers: NONE })
    expect(parseKeyChord(undefined)).toEqual({ key: '', modifiers: NONE })
  })
})
