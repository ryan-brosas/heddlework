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

/**
 * Parse case-insensitive modifier names separated by `+` or `-` from a key string.
 * Lone `+` and `-` keys stay literal; absent input produces an empty key.
 * The terminal encoder and insert-key policy combine these modifiers with explicit event modifiers.
 */
export function parseKeyChord(chord: string | undefined): ParsedKeyChord {
  const text = (chord ?? '').toLowerCase()
  const modifiers = { ctrl: false, alt: false, cmd: false, shift: false }
  // A trailing separator is the key itself - `ctrl+-` types a minus - so it is taken off before the
  // modifiers are split and put back afterwards. A lone "+" or "-" therefore survives as itself, and
  // so does the separator that follows modifiers.
  const trailing = /[+-]$/.test(text) ? text.slice(-1) : ''
  const tokens = (trailing ? text.slice(0, -1) : text).split(/[+-]/).filter(Boolean)
  for (const token of trailing ? tokens : tokens.slice(0, -1)) {
    if (token === 'ctrl' || token === 'control') modifiers.ctrl = true
    else if (token === 'alt' || token === 'option') modifiers.alt = true
    else if (token === 'cmd' || token === 'meta' || token === 'super' || token === 'win') modifiers.cmd = true
    else if (token === 'shift') modifiers.shift = true
  }
  if (trailing) return { key: trailing, modifiers }
  // With nothing to split there is no chord: the original text is the key.
  return { key: tokens.at(-1) ?? text, modifiers }
}
