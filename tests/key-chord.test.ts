import { describe, expect, it } from 'bun:test'
import { parseKeyChord } from '../src/ui/key-chord.ts'

const NONE = { ctrl: false, alt: false, cmd: false, shift: false }

describe('parseKeyChord', () => {
  it('preserves literal separator keys', () => {
    for (const key of ['+', '-']) {
      expect(parseKeyChord(key)).toEqual({ key, modifiers: NONE })
    }
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
