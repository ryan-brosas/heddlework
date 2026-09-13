export type TerminalSessionId = string

export type TerminalColor =
  | { readonly kind: 'default-fg' }
  | { readonly kind: 'default-bg' }
  | { readonly kind: 'indexed'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number }

export const CELL_BOLD = 1
export const CELL_DIM = 2
export const CELL_ITALIC = 4
export const CELL_UNDERLINE = 8
export const CELL_BLINK = 16
export const CELL_INVERSE = 32
export const CELL_HIDDEN = 64
export const CELL_STRIKE = 128
export const CELL_WIDE = 256
export const CELL_SPACER = 512

export interface TerminalCell {
  readonly ch: string
  readonly fg: TerminalColor
  readonly bg: TerminalColor
  readonly attrs: number
}

export interface TerminalRow {
  readonly cells: readonly TerminalCell[]
  readonly text: string
}

export const TERMINAL_PACKED_CELL_WORDS = 4
export const TERMINAL_PACKED_COLOR_KIND_MASK = 0xff000000
export const TERMINAL_PACKED_COLOR_INDEXED = 0x01000000
export const TERMINAL_PACKED_COLOR_DEFAULT_FG = 0x02000000
export const TERMINAL_PACKED_COLOR_DEFAULT_BG = 0x03000000

export interface TerminalPackedRow {
  readonly cells: Uint32Array
  readonly graphemes?: ReadonlyMap<number, string>
}

export interface TerminalAppearance {
  readonly fontFamily: string
  readonly nerdFontFamily: string
  readonly ligaturesEnabled: boolean
  readonly nerdFontEnabled: boolean
  readonly muteEmojiColors: boolean
}

export interface TerminalGridSnapshot {
  readonly cols: number
  readonly rows: number
  readonly cursorX: number
  readonly cursorY: number
  readonly cursorVisible: boolean
  readonly applicationCursor: boolean
  readonly bracketedPaste: boolean
  readonly title: string
  readonly viewport: readonly TerminalRow[]
  readonly packedViewport?: readonly TerminalPackedRow[]
  readonly scrollback: number
  readonly scrollOffset: number
}

export type TerminalProcessStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly exitCode: number | null }

export interface TerminalSessionInfo {
  readonly id: TerminalSessionId
  readonly name: string
  readonly title: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly status: TerminalProcessStatus
}

export interface TerminalServiceSnapshot {
  readonly sessions: readonly TerminalSessionInfo[]
  readonly activeBottomId: TerminalSessionId | undefined
  readonly activeRightId: TerminalSessionId | undefined
  readonly appearance: TerminalAppearance
  readonly generation: number
}

export type TerminalPlacement = 'bottom' | 'right'

export interface TerminalSpawnRequest {
  readonly cwd?: string
  readonly name?: string
  readonly cols?: number
  readonly rows?: number
  readonly shell?: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

export type TerminalCleanup = () => void
