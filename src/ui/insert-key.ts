/**
 * The X11/Wayland insert-key clipboard convention.
 *
 * Omarchy's Hyprland bindings deliver clipboard commands as insert keystrokes: `Ctrl+V` is remapped
 * to `Shift+Insert` ("Direct paste") and `Super+C` to `Ctrl+Insert` ("Universal copy"). An
 * application that only understands `Ctrl+C` and `Ctrl+V` looks broken on that desktop, because the
 * compositor rewrites the shortcut before the window ever sees it. The pinned GPUiX input element
 * binds neither alternative, so Heddlework resolves them once, here, for every surface that takes
 * keys.
 */
import { parseKeyChord } from './key-chord.ts'

export type InsertKeyCommand = 'copy' | 'paste' | 'none'

export interface InsertKeyEvent {
  readonly key?: string
  readonly modifiers?: {
    readonly shift?: boolean
    readonly ctrl?: boolean
    readonly control?: boolean
    readonly alt?: boolean
    readonly cmd?: boolean
  }
}

/** `Shift+Insert` pastes and `Ctrl+Insert` copies; every other combination stays untouched. */
export function resolveInsertKeyCommand(event: InsertKeyEvent): InsertKeyCommand {
  // A keystroke arrives either with separately encoded modifiers or as one chord such as
  // `shift-keystroke`; `parseKeyChord` is the single owner of that split, shared with the terminal.
  const chord = parseKeyChord(event.key)
  if (chord.key !== 'insert') return 'none'
  const modifiers = event.modifiers
  const ctrl = Boolean(modifiers?.ctrl || modifiers?.control || chord.modifiers.ctrl)
  const cmd = Boolean(modifiers?.cmd || chord.modifiers.cmd)
  const shift = Boolean(modifiers?.shift || chord.modifiers.shift)
  if (modifiers?.alt || chord.modifiers.alt) return 'none'
  if (shift && !ctrl && !cmd) return 'paste'
  if (!shift && (ctrl || cmd)) return 'copy'
  return 'none'
}
