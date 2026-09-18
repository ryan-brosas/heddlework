import type { TerminalAppearance } from './types.ts'

/**
 * Terminal appearance fields every surface agrees on; each surface picks its own `fontFamily`
 * because the native terminal and the browser bundle resolve fonts differently.
 */
export const SHARED_TERMINAL_APPEARANCE = Object.freeze({
  nerdFontFamily: 'Symbols Nerd Font Mono',
  ligaturesEnabled: true,
  nerdFontEnabled: false,
  muteEmojiColors: true,
} satisfies Omit<TerminalAppearance, 'fontFamily'>)

/** Native terminal default: the desktop font stack. */
export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = Object.freeze({ fontFamily: 'Menlo', ...SHARED_TERMINAL_APPEARANCE })

/** Browser default: the CSS system stack instead of the native font. */
export const DEFAULT_REMOTE_TERMINAL_APPEARANCE: TerminalAppearance = Object.freeze({ fontFamily: 'ui-monospace', ...SHARED_TERMINAL_APPEARANCE })
