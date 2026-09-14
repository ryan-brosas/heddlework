export interface TerminalKeyEvent {
  readonly eventType?: string
  readonly key?: string
  readonly keyChar?: string
  readonly modifiers?: {
    readonly shift?: boolean
    readonly ctrl?: boolean
    readonly control?: boolean
    readonly alt?: boolean
    readonly cmd?: boolean
  }
}

const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(0x7f)

function ctrlChar(code: number): string {
  return String.fromCharCode(code & 31)
}

export function normalizeTerminalKey(event: TerminalKeyEvent): {
  key: string
  ctrl: boolean
  alt: boolean
  cmd: boolean
  shift: boolean
  keyChar: string
} {
  const mods = event.modifiers ?? {}
  let ctrl = Boolean(mods.ctrl || mods.control)
  let alt = Boolean(mods.alt)
  let cmd = Boolean(mods.cmd)
  let shift = Boolean(mods.shift)
  let key = (event.key ?? '').toLowerCase()
  const tokens = key.split(/[+-]/).filter(Boolean)
  if (tokens.length > 1) {
    const last = tokens.at(-1) ?? key
    for (const token of tokens.slice(0, -1)) {
      if (token === 'ctrl' || token === 'control') ctrl = true
      else if (token === 'alt' || token === 'option') alt = true
      else if (token === 'cmd' || token === 'meta' || token === 'super' || token === 'win') cmd = true
      else if (token === 'shift') shift = true
    }
    key = last
  }
  if (key.startsWith('arrow')) key = key.slice(5)
  if (key === 'return') key = 'enter'
  if (key === 'esc') key = 'escape'
  if (key === 'bs' || key === 'back') key = 'backspace'
  if (key === 'del') key = 'delete'
  if (key === 'spacebar') key = 'space'
  if (key === 'pgup') key = 'pageup'
  if (key === 'pgdn' || key === 'pgdown') key = 'pagedown'
  return { key, ctrl, alt, cmd, shift, keyChar: event.keyChar ?? '' }
}

export function encodeTerminalKey(event: TerminalKeyEvent, applicationCursor = false): string | undefined {
  const { key, ctrl, alt, cmd, shift, keyChar } = normalizeTerminalKey(event)
  const charCode = keyChar.charCodeAt(0)
  if (cmd && (key === 'c' || key === 'v' || key === 'a') && !ctrl) return undefined
  if (ctrl && !alt) {
    if (key === 'c' || charCode === 3) return ctrlChar(3)
    if (key === 'd' || charCode === 4) return ctrlChar(4)
    if (key === 'z') return ctrlChar(26)
    if (key === 'l') return ctrlChar(12)
    if (key === 'u') return ctrlChar(21)
    if (key === 'w') return ctrlChar(23)
    if (key === 'a') return ctrlChar(1)
    if (key === 'e') return ctrlChar(5)
    if (key === 'k') return ctrlChar(11)
    if (key === 'n') return ctrlChar(14)
    if (key === 'p') return ctrlChar(16)
    if (key === 'r') return ctrlChar(18)
    if (key === 't') return ctrlChar(20)
    if (key.length === 1) {
      const code = key.charCodeAt(0)
      if (code >= 97 && code <= 122) return ctrlChar(code)
    }
  }
  if (charCode === 13 || charCode === 10 || key === 'enter') return '\r'
  if (charCode === 8 || charCode === 127 || key === 'backspace') return DEL
  if (key === 'tab' || charCode === 9) return shift ? ESC + '[Z' : '\t'
  if (charCode > 0 && charCode < 32) return String.fromCharCode(charCode)
  if (key === 'delete') return ESC + '[3~'
  if (key === 'escape') return ESC
  if (key === 'space') return ' '
  if (key === 'up') return applicationCursor ? ESC + 'OA' : ESC + '[A'
  if (key === 'down') return applicationCursor ? ESC + 'OB' : ESC + '[B'
  if (key === 'right') return applicationCursor ? ESC + 'OC' : ESC + '[C'
  if (key === 'left') return applicationCursor ? ESC + 'OD' : ESC + '[D'
  if (key === 'home') return ESC + '[H'
  if (key === 'end') return ESC + '[F'
  if (key === 'pageup') return ESC + '[5~'
  if (key === 'pagedown') return ESC + '[6~'
  if (key.startsWith('f')) {
    const number = Number.parseInt(key.slice(1), 10)
    const map: Record<number, string> = {
      1: ESC + 'OP',
      2: ESC + 'OQ',
      3: ESC + 'OR',
      4: ESC + 'OS',
      5: ESC + '[15~',
      6: ESC + '[17~',
      7: ESC + '[18~',
      8: ESC + '[19~',
      9: ESC + '[20~',
      10: ESC + '[21~',
      11: ESC + '[23~',
      12: ESC + '[24~',
    }
    if (map[number]) return map[number]
  }
  if (keyChar && keyChar !== '\u0000') {
    if (alt) return ESC + keyChar
    if (keyChar.length === 1 && keyChar.charCodeAt(0) >= 32) return keyChar
    if (keyChar.length > 1) return keyChar
  }
  if (key.length === 1 && !ctrl && !cmd) {
    const text = shift ? key.toUpperCase() : key
    return alt ? ESC + text : text
  }
  return undefined
}

export function wrapBracketedPaste(text: string, enabled: boolean): string {
  if (!enabled) return text
  return ESC + '[200~' + text + ESC + '[201~'
}

export type TerminalCommand = 'copy' | 'paste' | 'interrupt' | 'none'

export function resolveTerminalCommand(event: TerminalKeyEvent, platform: NodeJS.Platform): TerminalCommand {
  const { key, ctrl, alt, cmd, shift } = normalizeTerminalKey(event)
  if (key === 'c') {
    // Copy is resolved BEFORE the interrupt branch: an unqualified ctrl 'c'
    // check would otherwise swallow Linux/Windows Ctrl+Shift+C (and macOS
    // Command+C) and write ETX to the PTY instead of copying.
    if (platform === 'darwin') {
      if (cmd) return 'copy'
      if (ctrl && !alt && !shift) return 'interrupt'
      return 'none'
    }
    if (ctrl && shift && !alt && !cmd) return 'copy'
    if (ctrl && !alt && !shift && !cmd) return 'interrupt'
    return 'none'
  }
  if (key === 'v' && (cmd || ctrl) && !alt) return 'paste'
  return 'none'
}

export interface TerminalKeyGridLike {
  readonly viewport: readonly { readonly text: string }[]
  readonly bracketedPaste?: boolean
  readonly applicationCursor?: boolean
}

export interface TerminalKeyEffects {
  readonly platform: NodeJS.Platform
  readonly grid: TerminalKeyGridLike | undefined
  readonly write: (data: string) => void
  readonly copy: (text: string) => void | boolean | Promise<unknown>
  readonly readPaste: () => Promise<string | undefined>
}

/** Production terminal keyboard dispatch, kept renderer-free for deterministic tests. */
export function dispatchTerminalKey(event: TerminalKeyEvent, effects: TerminalKeyEffects): void {
  const { grid } = effects
  if (event.eventType === 'textInput' || event.eventType === 'paste') {
    const text = event.keyChar ?? ''
    if (text) effects.write(event.eventType === 'paste' ? wrapBracketedPaste(text, Boolean(grid?.bracketedPaste)) : text)
    return
  }
  const command = resolveTerminalCommand(event, effects.platform)
  if (command === 'copy') {
    void effects.copy(grid?.viewport.map((row) => row.text).join('\n') ?? '')
    return
  }
  if (command === 'interrupt') {
    effects.write(String.fromCharCode(3))
    return
  }
  if (command === 'paste') {
    // A rejected read stays local: it must never become an unhandled rejection
    // in the key path, and it must never fall through to PTY encoding.
    void effects.readPaste().then((text) => {
      if (text) effects.write(wrapBracketedPaste(text, Boolean(grid?.bracketedPaste)))
    }).catch(() => undefined)
    return
  }
  const encoded = encodeTerminalKey(event, grid?.applicationCursor)
  if (encoded) effects.write(encoded)
}
