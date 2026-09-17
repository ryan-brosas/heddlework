/**
 * Parse a keystroke that may carry its modifiers inside the key string (`shift-insert`) or
 * separately (see `InsertKeyEvent.modifiers`). One owner for that split: the terminal encoder and the
 * insert-key clipboard policy both depend on the same reading.
 */
export interface KeyChordModifiers {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly cmd: boolean
  readonly shift: boolean
}

export interface ParsedKeyChord {
  readonly key: string
  readonly modifiers: KeyChordModifiers
}

export function parseKeyChord(chord: string | undefined): ParsedKeyChord {
  const text = (chord ?? '').toLowerCase()
  const tokens = text.split(/[+-]/).filter(Boolean)
  const modifiers = { ctrl: false, alt: false, cmd: false, shift: false }
  // With nothing to split there is no chord: the original text is the key. Falling back to the empty
  // token would drop a lone separator character, so a plain "+" or "-" must survive as itself.
  if (tokens.length <= 1) return { key: tokens[0] ?? text, modifiers }
  for (const token of tokens.slice(0, -1)) {
    if (token === 'ctrl' || token === 'control') modifiers.ctrl = true
    else if (token === 'alt' || token === 'option') modifiers.alt = true
    else if (token === 'cmd' || token === 'meta' || token === 'super' || token === 'win') modifiers.cmd = true
    else if (token === 'shift') modifiers.shift = true
  }
  return { key: tokens.at(-1) ?? '', modifiers }
}
