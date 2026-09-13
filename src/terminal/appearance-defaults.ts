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
