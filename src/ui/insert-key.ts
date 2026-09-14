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
  if ((event.key ?? '').toLowerCase() !== 'insert') return 'none'
  const modifiers = event.modifiers
  const ctrl = Boolean(modifiers?.ctrl || modifiers?.control)
  const cmd = Boolean(modifiers?.cmd)
  if (modifiers?.alt) return 'none'
  if (modifiers?.shift && !ctrl && !cmd) return 'paste'
  if (!modifiers?.shift && (ctrl || cmd)) return 'copy'
  return 'none'
}
