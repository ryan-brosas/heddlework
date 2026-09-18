import {
  CELL_BOLD,
  CELL_DIM,
  CELL_HIDDEN,
  CELL_INVERSE,
  CELL_ITALIC,
  CELL_SPACER,
  CELL_STRIKE,
  CELL_UNDERLINE,
  CELL_WIDE,
  type TerminalAppearance,
  type TerminalCell,
  type TerminalColor,
} from '../terminal/types.ts'
import { DEFAULT_TERMINAL_APPEARANCE } from '../terminal/appearance-defaults.ts'
import type { ResolvedTheme } from './theme.ts'
import {
  blendLinear,
  ensureContrast,
  generateExtendedPalette,
  relativeLuminance,
} from './terminal-color.ts'

const DARK_ANSI = [
  '#0D0D0D', '#E5484D', '#46A758', '#EF9F27', '#52A9FF', '#BF7AF0', '#12A594', '#EDEDEF',
  '#6F6E77', '#FF6369', '#70D083', '#FFC36A', '#82C4FF', '#D4A4FF', '#3BD4C0', '#FFFFFF',
]

const LIGHT_ANSI = [
  '#1D1D20', '#C43D45', '#16845B', '#9A6700', '#2563B8', '#7A3E9D', '#0F6E64', '#E8E8EC',
  '#6F7077', '#E5484D', '#2F9A6A', '#C69026', '#3B82C4', '#9A5FBF', '#1A9B8C', '#FFFFFF',
]

const ZERO_WIDTH_NON_JOINER = '\u200C'
const TEXT_PRESENTATION_SELECTOR = '\uFE0E'
const COLOR_PRESENTATION_SELECTOR = '\uFE0F'
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const EMOJI_OR_COLOR_SELECTOR = /(?:\p{Emoji_Presentation}|\uFE0F)/u

export interface TerminalPaintTheme {
  readonly foreground: string
  readonly background: string
  readonly cursor: string
  readonly ansi: readonly string[]
  readonly light: boolean
  readonly minimumContrastRatio: number
}

export function terminalPaintTheme(appearance: ResolvedTheme): TerminalPaintTheme {
  const light = appearance === 'light'
  const foreground = light ? '#1D1D20' : '#E7E7E7'
  const background = light ? '#F4F4F5' : '#0B0C0C'
  const base = light ? LIGHT_ANSI : DARK_ANSI
  const extended = generateExtendedPalette({
    background,
    foreground,
    red: base[1]!,
    green: base[2]!,
    yellow: base[3]!,
    blue: base[4]!,
    magenta: base[5]!,
    cyan: base[6]!,
  })
  return {
    foreground,
    background,
    cursor: foreground,
    ansi: [...base, ...extended],
    light,
    minimumContrastRatio: light ? 4.5 : 1,
  }
}

function indexedColor(index: number, ansi: readonly string[]): string {
  return ansi[Math.max(0, Math.min(255, index))] ?? ansi[7] ?? '#FFFFFF'
}

function resolveColor(
  color: TerminalColor,
  theme: TerminalPaintTheme,
  role: 'fg' | 'bg',
  bold = false,
): string {
  if (color.kind === 'default-fg') return theme.foreground
  if (color.kind === 'default-bg') return theme.background
  if (color.kind === 'rgb') {
    const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
  }
  const index = role === 'fg' && bold && color.index < 8 ? color.index + 8 : color.index
  return indexedColor(index, theme.ansi)
}

export interface TerminalRunStyle {
  text: string
  columns: number
  fill: boolean
  readonly color: string
  readonly backgroundColor: string
  readonly fontFamily: string
  readonly fontWeight?: number
  readonly fontStyle?: 'italic'
  readonly underline?: boolean
  readonly strike?: boolean
  readonly hidden?: boolean
}

export function isTerminalFillGlyph(ch: string): boolean {
  return ch.codePointAt(0) === 0x2588
}

export function isTerminalGraphicsGlyph(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x2580 && code <= 0x259f
}

export function paintTerminalCell(cell: TerminalCell, theme: TerminalPaintTheme): {
  color: string
  backgroundColor: string
  fontWeight?: number
  fontStyle?: 'italic'
  underline: boolean
  strike: boolean
  hidden: boolean
} {
  const bold = Boolean(cell.attrs & CELL_BOLD)
  const dim = Boolean(cell.attrs & CELL_DIM)
  let fg = resolveColor(cell.fg, theme, 'fg', bold)
  let bg = resolveColor(cell.bg, theme, 'bg')
  if (cell.attrs & CELL_INVERSE) [fg, bg] = [bg, fg]
  const hidden = Boolean(cell.attrs & CELL_HIDDEN)
  const graphical = isTerminalGraphicsGlyph(cell.ch)
  if (!hidden && !graphical && theme.minimumContrastRatio > 1) {
    fg = ensureContrast(bg, fg, dim ? theme.minimumContrastRatio / 2 : theme.minimumContrastRatio)
  }
  if (dim && !hidden) {
    const darkOnLight = relativeLuminance(bg) > relativeLuminance(fg)
    fg = blendLinear(bg, fg, darkOnLight ? 0.9 : 0.5)
    if (theme.light && darkOnLight && !graphical) {
      fg = ensureContrast(bg, fg, theme.minimumContrastRatio)
    }
  }
  if (hidden) fg = bg
  return {
    color: fg,
    backgroundColor: bg,
    ...(bold ? { fontWeight: 700 } : {}),
    ...(cell.attrs & CELL_ITALIC ? { fontStyle: 'italic' as const } : {}),
    underline: Boolean(cell.attrs & CELL_UNDERLINE),
    strike: Boolean(cell.attrs & CELL_STRIKE),
    hidden,
  }
}

export function terminalRowRuns(
  cells: readonly TerminalCell[],
  theme: TerminalPaintTheme,
  options: TerminalAppearance = DEFAULT_TERMINAL_APPEARANCE,
): TerminalRunStyle[] {
  const runs: TerminalRunStyle[] = []
  let previousWide = false
  for (const cell of cells) {
    if (cell.attrs & CELL_SPACER) continue
    const painted = paintTerminalCell(cell, theme)
    const raw = cell.ch || ' '
    const ch = options.muteEmojiColors ? muteEmojiPresentation(raw) : raw
    const fill = isTerminalFillGlyph(raw)
    const columns = cell.attrs & CELL_WIDE ? 2 : 1
    const fontFamily = options.nerdFontEnabled && isNerdFontGlyph(raw)
      ? options.nerdFontFamily
      : options.fontFamily
    const last = runs.at(-1)
    const same = last
      && last.color === painted.color
      && last.backgroundColor === painted.backgroundColor
      && last.fontFamily === fontFamily
      && last.fontWeight === painted.fontWeight
      && last.fontStyle === painted.fontStyle
      && last.underline === painted.underline
      && last.strike === painted.strike
      && last.fill === fill
    if (same && last && !previousWide && !(cell.attrs & CELL_WIDE)) {
      last.text += options.ligaturesEnabled || fill ? ch : ZERO_WIDTH_NON_JOINER + ch
      last.columns += columns
    } else {
      runs.push({
        text: ch,
        columns,
        fill,
        color: painted.color,
        backgroundColor: painted.backgroundColor,
        fontFamily,
        ...(painted.fontWeight ? { fontWeight: painted.fontWeight } : {}),
        ...(painted.fontStyle ? { fontStyle: painted.fontStyle } : {}),
        underline: painted.underline,
        strike: painted.strike,
        hidden: painted.hidden,
      })
    }
    previousWide = Boolean(cell.attrs & CELL_WIDE)
  }
  return runs
}

export function muteEmojiPresentation(text: string): string {
  if (!EMOJI_OR_COLOR_SELECTOR.test(text)) return text
  const characters = [...text]
  let result = ''
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!
    if (character === COLOR_PRESENTATION_SELECTOR) {
      result += TEXT_PRESENTATION_SELECTOR
      continue
    }
    result += character
    const next = characters[index + 1]
    if (EMOJI_PRESENTATION.test(character)
      && next !== TEXT_PRESENTATION_SELECTOR
      && next !== COLOR_PRESENTATION_SELECTOR) {
      result += TEXT_PRESENTATION_SELECTOR
    }
  }
  return result
}

export function isNerdFontCodepoint(code: number): boolean {
  return (code >= 0x23fb && code <= 0x23fe)
    || (code >= 0x2500 && code <= 0x259f)
    || code === 0x2630
    || code === 0x2665
    || code === 0x26a1
    || (code >= 0x276c && code <= 0x2771)
    || code === 0x2b58
    || (code >= 0xe000 && code <= 0xe00a)
    || (code >= 0xe0a0 && code <= 0xe0a3)
    || (code >= 0xe0b0 && code <= 0xe0d7)
    || (code >= 0xe200 && code <= 0xe2a9)
    || (code >= 0xe300 && code <= 0xe3e3)
    || (code >= 0xe5fa && code <= 0xe6b8)
    || (code >= 0xe700 && code <= 0xe8ef)
    || (code >= 0xea60 && code <= 0xeac7)
    || code === 0xeac9
    || (code >= 0xeacc && code <= 0xeb09)
    || (code >= 0xeb0b && code <= 0xeb4e)
    || (code >= 0xeb50 && code <= 0xec1e)
    || (code >= 0xed00 && code <= 0xefce)
    || (code >= 0xf000 && code <= 0xf533)
    || (code >= 0xf0001 && code <= 0xf1af0)
}

export function isNerdFontGlyph(text: string): boolean {
  for (const character of text) {
    if (isNerdFontCodepoint(character.codePointAt(0) ?? 0)) return true
  }
  return false
}
