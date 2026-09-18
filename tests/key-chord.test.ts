import { describe, expect, it } from 'bun:test'
import { parseKeyChord } from '../src/ui/key-chord.ts'

const NONE = { ctrl: false, alt: false, cmd: false, shift: false }

describe('parseKeyChord', () => {
  it('preserves literal separator keys', () => {
    for (const key of ['+', '-']) {
      expect(parseKeyChord(key)).toEqual({ key, modifiers: NONE })
    }
  })

  it('reads a trailing separator as the key that follows its modifiers', () => {
    // The regression: splitting `ctrl+-` on `-` produced only `['ctrl']`, so the minus the user pressed
    // disappeared into an empty key.
    expect(parseKeyChord('ctrl+-')).toEqual({ key: '-', modifiers: { ...NONE, ctrl: true } })
    expect(parseKeyChord('ctrl++')).toEqual({ key: '+', modifiers: { ...NONE, ctrl: true } })
    // A modifier followed by a separator and nothing else keeps that separator as the key.
    expect(parseKeyChord('shift+')).toEqual({ key: '+', modifiers: { ...NONE, shift: true } })
  })

  it('reads modifiers embedded in key strings', () => {
    expect(parseKeyChord('CTRL-SHIFT-C')).toEqual({ key: 'c', modifiers: { ...NONE, ctrl: true, shift: true } })
    expect(parseKeyChord('ctrl+insert')).toEqual({ key: 'insert', modifiers: { ...NONE, ctrl: true } })
    expect(parseKeyChord('super-insert')).toEqual({ key: 'insert', modifiers: { ...NONE, cmd: true } })
  })

  it('returns an empty key for absent input', () => {
    expect(parseKeyChord('')).toEqual({ key: '', modifiers: NONE })
    expect(parseKeyChord(undefined)).toEqual({ key: '', modifiers: NONE })
  })
})
