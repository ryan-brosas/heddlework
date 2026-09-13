import {
  CELL_BLINK,
  CELL_BOLD,
  CELL_DIM,
  CELL_HIDDEN,
  CELL_INVERSE,
  CELL_ITALIC,
  CELL_SPACER,
  CELL_STRIKE,
  CELL_UNDERLINE,
  CELL_WIDE,
  TERMINAL_PACKED_CELL_WORDS,
  TERMINAL_PACKED_COLOR_DEFAULT_BG,
  TERMINAL_PACKED_COLOR_DEFAULT_FG,
  TERMINAL_PACKED_COLOR_INDEXED,
  TERMINAL_PACKED_COLOR_KIND_MASK,
  type TerminalCell,
  type TerminalColor,
  type TerminalGridSnapshot,
  type TerminalPackedRow,
  type TerminalRow,
} from './types.ts'

const MAX_SCROLLBACK = 5_000
const DEFAULT_FG_COLOR: TerminalColor = { kind: 'default-fg' }
const DEFAULT_BG_COLOR: TerminalColor = { kind: 'default-bg' }
const DEFAULT_FG = TERMINAL_PACKED_COLOR_DEFAULT_FG
const DEFAULT_BG = TERMINAL_PACKED_COLOR_DEFAULT_BG
const SYNCHRONIZED_OUTPUT_ENABLE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68])
const SYNCHRONIZED_OUTPUT_DISABLE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c])
const HIDE_CURSOR = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c])

type ParserState = 'ground' | 'escape' | 'csi' | 'osc' | 'dcs' | 'charset'

interface MutableRow {
  cells: Uint32Array
  graphemes: Map<number, string> | undefined
}

function blankRow(
  cols: number,
  foreground = DEFAULT_FG,
  background = DEFAULT_BG,
  attrs = 0,
): MutableRow {
  const cells = new Uint32Array(cols * TERMINAL_PACKED_CELL_WORDS)
  for (let word = 0; word < cells.length; word += TERMINAL_PACKED_CELL_WORDS) {
    cells[word] = 32
    cells[word + 1] = foreground
    cells[word + 2] = background
    cells[word + 3] = attrs
  }
  return { cells, graphemes: undefined }
}

function cloneRow(row: MutableRow): MutableRow {
  return {
    cells: row.cells.slice(),
    graphemes: row.graphemes ? new Map(row.graphemes) : undefined,
  }
}

function cellText(row: MutableRow, column: number): string {
  const grapheme = row.graphemes?.get(column)
  if (grapheme !== undefined) return grapheme
  return String.fromCodePoint(row.cells[column * TERMINAL_PACKED_CELL_WORDS] ?? 32)
}

function setCellCode(
  row: MutableRow,
  column: number,
  code: number,
  foreground: number,
  background: number,
  attrs: number,
): void {
  const word = column * TERMINAL_PACKED_CELL_WORDS
  row.cells[word] = code
  row.cells[word + 1] = foreground
  row.cells[word + 2] = background
  row.cells[word + 3] = attrs
  if (row.graphemes?.delete(column) && row.graphemes.size === 0) row.graphemes = undefined
}

function setCellText(
  row: MutableRow,
  column: number,
  text: string,
  foreground: number,
  background: number,
  attrs: number,
): void {
  const code = text.codePointAt(0) ?? 32
  setCellCode(row, column, code, foreground, background, attrs)
  if (text !== String.fromCodePoint(code)) {
    row.graphemes ??= new Map()
    row.graphemes.set(column, text)
  }
}

function appendCellText(row: MutableRow, column: number, suffix: string): void {
  const word = column * TERMINAL_PACKED_CELL_WORDS
  setCellText(
    row,
    column,
    cellText(row, column) + suffix,
    row.cells[word + 1] ?? DEFAULT_FG,
    row.cells[word + 2] ?? DEFAULT_BG,
    row.cells[word + 3] ?? 0,
  )
}

function csiParam(params: readonly number[], index: number, fallback: number): number {
  const value = params[index] ?? 0
  return value === 0 ? fallback : value
}

function packRgbParams(params: Int32Array): number {
  return (Math.max(0, Math.min(255, params[2]!)) << 16)
    | (Math.max(0, Math.min(255, params[3]!)) << 8)
    | Math.max(0, Math.min(255, params[4]!))
}

function scanNumericCsi(text: string, start: number, params: Int32Array): number {
  let count = 0
  let value = 0
  let hasValue = false
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x30 && code <= 0x39) {
      value = value * 10 + code - 0x30
      hasValue = true
      continue
    }
    if (code === 0x3b) {
      if (count >= params.length - 1) return -1
      params[count] = hasValue ? value : 0
      count += 1
      value = 0
      hasValue = false
      continue
    }
    if (code >= 0x40 && code <= 0x7e) {
      if (hasValue || count > 0) {
        if (count >= params.length - 1) return -1
        params[count] = hasValue ? value : 0
        count += 1
      }
      params[params.length - 1] = count
      return index + 1
    }
    return -1
  }
  return -1
}

function cellWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (code >= 0x300 && code <= 0x36f) return 0
  if (code >= 0x1ab0 && code <= 0x1aff) return 0
  if (code >= 0x20d0 && code <= 0x20ff) return 0
  if (code >= 0xfe00 && code <= 0xfe0f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)
  ) return 2
  return 1
}

function unpackColor(color: number): TerminalColor {
  const kind = color & TERMINAL_PACKED_COLOR_KIND_MASK
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_FG) return DEFAULT_FG_COLOR
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_BG) return DEFAULT_BG_COLOR
  if (kind === TERMINAL_PACKED_COLOR_INDEXED) return { kind: 'indexed', index: color & 0xff }
  return { kind: 'rgb', r: (color >>> 16) & 0xff, g: (color >>> 8) & 0xff, b: color & 0xff }
}

function rowText(row: readonly { ch: string; attrs: number }[]): string {
  let text = ''
  for (const cell of row) {
    if (cell.attrs & CELL_SPACER) continue
    text += cell.ch
  }
  return text.replace(/ +$/u, '')
}

export class VtEmulator {
  #cols: number
  #rows: number
  #screen: MutableRow[]
  #alt: MutableRow[] | undefined
  #scrollback: MutableRow[] = []
  #x = 0
  #y = 0
  #savedX = 0
  #savedY = 0
  #altSavedX = 0
  #altSavedY = 0
  #scrollTop = 0
  #scrollBottom: number
  #wrap = true
  #wrapPending = false
  #origin = false
  #cursorVisible = true
  #applicationCursor = false
  #bracketedPaste = false
  #insert = false
  #title = ''
  #fg = DEFAULT_FG
  #bg = DEFAULT_BG
  #attrs = 0
  #state: ParserState = 'ground'
  #osc = ''
  #csiParams: number[] = []
  #csiValue = 0
  #csiHasValue = false
  #csiPrivate = false
  #frameParams = new Int32Array(6)
  #utf8 = new TextDecoder('utf-8', { fatal: false })
  #synchronizedOutput = false
  #rowVersions = new WeakMap<MutableRow, number>()
  #packedRowSnapshots = new WeakMap<MutableRow, { cols: number; version: number; row: TerminalPackedRow }>()
  #rowSnapshots = new WeakMap<MutableRow, Array<{ cols: number; version: number; row: TerminalRow }>>()
  #writeVersion = 0
  #lastTouchedRow: MutableRow | undefined
  #lastTouchedVersion = -1
  onOutput?: (data: string) => void

  constructor(cols = 80, rows = 24) {
    this.#cols = Math.max(2, cols)
    this.#rows = Math.max(1, rows)
    this.#screen = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
    this.#scrollBottom = this.#rows - 1
  }

  get cols(): number {
    return this.#cols
  }

  get rows(): number {
    return this.#rows
  }

  get title(): string {
    return this.#title
  }

  get scrollbackLength(): number {
    return this.#scrollback.length
  }

  get applicationCursor(): boolean {
    return this.#applicationCursor
  }

  get bracketedPaste(): boolean {
    return this.#bracketedPaste
  }

  get synchronizedOutput(): boolean {
    return this.#synchronizedOutput
  }

  write(input: string | Uint8Array): void {
    this.#writeVersion += 1
    if (typeof input !== 'string'
      && this.#state === 'ground'
      && input.byteLength >= SYNCHRONIZED_OUTPUT_ENABLE.byteLength
      && SYNCHRONIZED_OUTPUT_ENABLE.every((byte, index) => input[index] === byte)) {
      const pending = this.#utf8.decode()
      if (pending) this.#writeText(pending)
      const consumed = this.#fastFramebufferBytes(input)
      if (consumed < input.byteLength) {
        this.#writeText(this.#utf8.decode(input.subarray(consumed), { stream: true }))
      }
      return
    }
    const text = typeof input === 'string' ? input : this.#utf8.decode(input, { stream: true })
    this.#writeText(text)
  }

  #writeText(text: string): void {
    for (let index = 0; index < text.length;) {
      if (this.#state === 'ground'
        && text.charCodeAt(index) === 0x1b
        && text.charCodeAt(index + 1) === 0x5b) {
        const frameNext = this.#fastFramebufferRun(text, index)
        if (frameNext !== -1) {
          index = frameNext
          continue
        }
        const next = this.#fastCsi(text, index + 2)
        if (next !== -1) {
          index = next
          continue
        }
      }
      const code = text.codePointAt(index) ?? 0
      const length = code > 0xffff ? 2 : 1
      this.#feed(length === 1 ? text[index]! : text.slice(index, index + length))
      index += length
    }
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (nextCols === this.#cols && nextRows === this.#rows) return
    this.#resizeBuffer(this.#screen, nextCols, nextRows)
    if (this.#alt) this.#resizeBuffer(this.#alt, nextCols, nextRows)
    this.#cols = nextCols
    this.#rows = nextRows
    this.#scrollTop = Math.min(this.#scrollTop, this.#rows - 1)
    this.#scrollBottom = this.#rows - 1
    this.#x = Math.min(this.#x, this.#cols - 1)
    this.#y = Math.min(this.#y, this.#rows - 1)
    this.#wrapPending = false
  }

  snapshot(scrollOffset = 0): TerminalGridSnapshot {
    const offset = Math.max(0, Math.min(this.#scrollback.length, Math.floor(scrollOffset)))
    const sources: MutableRow[] = []
    const versions: number[] = []
    const packedViewport: TerminalPackedRow[] = []
    for (let row = 0; row < this.#rows; row += 1) {
      const sourceIndex = this.#scrollback.length - offset + row
      const source = sourceIndex < this.#scrollback.length
        ? this.#scrollback[sourceIndex]!
        : this.#screen[sourceIndex - this.#scrollback.length] ?? blankRow(this.#cols)
      sources.push(source)
      versions.push(this.#rowVersions.get(source) ?? 0)
      packedViewport.push(this.#snapshotPackedRow(source))
    }
    let viewport: readonly TerminalRow[] | undefined
    const materialize = () => {
      viewport ??= packedViewport.map((packed, row) => this.#materializeRow(sources[row]!, versions[row]!, packed))
      return viewport
    }
    return {
      cols: this.#cols,
      rows: this.#rows,
      cursorX: this.#x,
      cursorY: this.#y,
      cursorVisible: this.#cursorVisible && offset === 0,
      applicationCursor: this.#applicationCursor,
      bracketedPaste: this.#bracketedPaste,
      title: this.#title,
      get viewport() { return materialize() },
      packedViewport,
      scrollback: this.#scrollback.length,
      scrollOffset: offset,
    }
  }

  #snapshotPackedRow(source: MutableRow): TerminalPackedRow {
    const version = this.#rowVersions.get(source) ?? 0
    const cached = this.#packedRowSnapshots.get(source)
    if (cached && cached.cols === this.#cols && cached.version === version) return cached.row
    const cells = source.cells.slice(0, this.#cols * TERMINAL_PACKED_CELL_WORDS)
    const graphemes = source.graphemes?.size ? new Map(source.graphemes) : undefined
    const row: TerminalPackedRow = { cells, ...(graphemes ? { graphemes } : {}) }
    this.#packedRowSnapshots.set(source, { cols: this.#cols, version, row })
    return row
  }

  #materializeRow(source: MutableRow, version: number, packed: TerminalPackedRow): TerminalRow {
    const snapshots = this.#rowSnapshots.get(source) ?? []
    const cached = snapshots.find((entry) => entry.cols === this.#cols && entry.version === version)
    if (cached) return cached.row
    const cells: TerminalCell[] = []
    for (let column = 0; column < this.#cols; column += 1) {
      const word = column * TERMINAL_PACKED_CELL_WORDS
      const glyph = packed.cells[word] ?? 32
      cells.push({
        ch: packed.graphemes?.get(column) ?? String.fromCodePoint(glyph),
        fg: unpackColor(packed.cells[word + 1] ?? TERMINAL_PACKED_COLOR_DEFAULT_FG),
        bg: unpackColor(packed.cells[word + 2] ?? TERMINAL_PACKED_COLOR_DEFAULT_BG),
        attrs: packed.cells[word + 3] ?? 0,
      })
    }
    const row: TerminalRow = { cells, text: rowText(cells) }
    snapshots.push({ cols: this.#cols, version, row })
    if (snapshots.length > 2) snapshots.shift()
    this.#rowSnapshots.set(source, snapshots)
    return row
  }

  #resizeBuffer(buffer: MutableRow[], cols: number, rows: number): void {
    for (let rowIndex = 0; rowIndex < buffer.length; rowIndex += 1) {
      const source = buffer[rowIndex]!
      const sourceCols = source.cells.length / TERMINAL_PACKED_CELL_WORDS
      if (sourceCols === cols) continue
      const resized = blankRow(cols)
      resized.cells.set(source.cells.subarray(0, Math.min(sourceCols, cols) * TERMINAL_PACKED_CELL_WORDS))
      if (source.graphemes) {
        for (const [column, text] of source.graphemes) {
          if (column < cols) {
            resized.graphemes ??= new Map()
            resized.graphemes.set(column, text)
          }
        }
      }
      buffer[rowIndex] = resized
    }
    if (buffer.length < rows) {
      while (buffer.length < rows) buffer.push(blankRow(cols))
    } else if (buffer.length > rows) {
      buffer.length = rows
    }
  }

  #feed(char: string): void {
    const code = char.codePointAt(0) ?? 0
    if (this.#state === 'ground') {
      if (code === 0x1b) {
        this.#state = 'escape'
        return
      }
      this.#ground(char, code)
      return
    }
    if (this.#state === 'escape') {
      this.#escape(char, code)
      return
    }
    if (this.#state === 'csi') {
      if (code >= 0x30 && code <= 0x39) {
        this.#csiValue = this.#csiValue * 10 + code - 0x30
        this.#csiHasValue = true
      } else if (code === 0x3b || code === 0x3a) {
        this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        this.#csiValue = 0
        this.#csiHasValue = false
      } else if (code === 0x3f && this.#csiParams.length === 0 && !this.#csiHasValue) {
        this.#csiPrivate = true
      } else if (code >= 0x40 && code <= 0x7e) {
        if (this.#csiHasValue || this.#csiParams.length > 0) {
          this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        }
        this.#dispatchCsi(char, this.#csiParams, this.#csiPrivate)
        this.#resetCsi()
        this.#state = 'ground'
      }
      return
    }
    if (this.#state === 'osc') {
      if (char === '\u0007') {
        this.#dispatchOsc(this.#osc)
        this.#osc = ''
        this.#state = 'ground'
        return
      }
      if (this.#osc.endsWith('\u001b') && char === '\\') {
        this.#dispatchOsc(this.#osc.slice(0, -1))
        this.#osc = ''
        this.#state = 'ground'
        return
      }
      this.#osc += char
      if (this.#osc.length > 16_384) {
        this.#osc = ''
        this.#state = 'ground'
      }
      return
    }
    if (this.#state === 'charset') {
      this.#state = 'ground'
      return
    }
    if (char === '\u001b') {
      this.#state = 'escape'
      return
    }
    if (char === '\u0007') this.#state = 'ground'
  }

  #ground(char: string, code: number): void {
    if (code === 0 || code === 0x7f) return
    if (code === 0x07) return
    if (code === 0x08) {
      this.#wrapPending = false
      this.#x = Math.max(0, this.#x - 1)
      return
    }
    if (code === 0x09) {
      this.#wrapPending = false
      this.#x = Math.min(this.#cols - 1, this.#x + (8 - (this.#x % 8)))
      return
    }
    if (code === 0x0a || code === 0x0b || code === 0x0c) {
      this.#index()
      return
    }
    if (code === 0x0d) {
      this.#wrapPending = false
      this.#x = 0
      return
    }
    if (code < 32) return
    this.#print(char, code)
  }

  #escape(char: string, code: number): void {
    if (char === '[') {
      this.#state = 'csi'
      this.#resetCsi()
      return
    }
    if (char === ']') {
      this.#state = 'osc'
      this.#osc = ''
      return
    }
    if (char === 'P' || char === 'X' || char === '^' || char === '_') {
      this.#state = 'dcs'
      return
    }
    if (char === '(' || char === ')' || char === '*' || char === '+') {
      this.#state = 'charset'
      return
    }
    this.#state = 'ground'
    if (char === '7') {
      this.#savedX = this.#x
      this.#savedY = this.#y
      return
    }
    if (char === '8') {
      this.#x = this.#savedX
      this.#y = this.#savedY
      return
    }
    if (char === 'c') {
      this.#reset()
      return
    }
    if (char === 'D') {
      this.#index()
      return
    }
    if (char === 'E') {
      this.#x = 0
      this.#index()
      return
    }
    if (char === 'M') {
      this.#reverseIndex()
      return
    }
    if (code === 0x5c) return
  }

  #print(char: string, code: number): void {
    const width = code < 0x300 ? (code < 0x7f || code >= 0xa0 ? 1 : 0) : cellWidth(code)
    if (width === 0) {
      if (this.#x > 0) {
        const row = this.#screen[this.#y]!
        const column = this.#x - 1
        const word = column * TERMINAL_PACKED_CELL_WORDS
        if (!((row.cells[word + 3] ?? 0) & CELL_SPACER)) {
          appendCellText(row, column, char)
          this.#touchRow(row)
        }
      }
      return
    }
    if (this.#wrapPending) {
      this.#index()
      this.#x = 0
      this.#wrapPending = false
    }
    if (this.#x + width > this.#cols) {
      if (this.#wrap) {
        this.#index()
        this.#x = 0
      } else {
        this.#x = Math.max(0, this.#cols - width)
      }
    }
    if (this.#insert) this.#insertBlanks(width)
    const row = this.#screen[this.#y]!
    setCellText(row, this.#x, char, this.#fg, this.#bg, this.#attrs | (width === 2 ? CELL_WIDE : 0))
    if (width === 2 && this.#x + 1 < this.#cols) {
      setCellCode(row, this.#x + 1, 32, this.#fg, this.#bg, this.#attrs | CELL_SPACER)
    }
    this.#touchRow(row)
    this.#x += width
    if (this.#x >= this.#cols) {
      this.#x = this.#cols
      this.#wrapPending = this.#wrap
    }
  }

  // OpenTUI emits synchronized changed-cell runs directly from its native framebuffer.
  // Parsing complete runs in place avoids decoding multi-megabyte frames into transient UTF-16.
  #fastFramebufferBytes(input: Uint8Array): number {
    if (this.#insert) return 0
    this.#synchronizedOutput = true
    const origin = this.#origin ? this.#scrollTop : 0
    let index = SYNCHRONIZED_OUTPUT_ENABLE.byteLength
    if (this.#bytesMatchAt(input, index, HIDE_CURSOR)) {
      this.#cursorVisible = false
      index += HIDE_CURSOR.byteLength
    }

    let matched = false
    let attrs = this.#attrs
    let touchedRow: MutableRow | undefined
    let finalX = this.#x
    let finalY = this.#y

    records: while (index < input.byteLength) {
      let scan = index
      if (input[scan] !== 0x1b || input[scan + 1] !== 0x5b) break
      scan += 2

      let byte = input[scan] ?? -1
      if (byte < 0x30 || byte > 0x39) break
      let rowNumber = 0
      do {
        rowNumber = rowNumber * 10 + byte - 0x30
        scan += 1
        byte = input[scan] ?? -1
      } while (byte >= 0x30 && byte <= 0x39)
      if (byte !== 0x3b) break

      scan += 1
      byte = input[scan] ?? -1
      if (byte < 0x30 || byte > 0x39) break
      let colNumber = 0
      do {
        colNumber = colNumber * 10 + byte - 0x30
        scan += 1
        byte = input[scan] ?? -1
      } while (byte >= 0x30 && byte <= 0x39)
      if (byte !== 0x48) break
      scan += 1

      let foreground: number
      if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x33
        && input[scan + 3] === 0x38
        && input[scan + 4] === 0x3b
        && input[scan + 5] === 0x32
        && input[scan + 6] === 0x3b) {
        scan += 7
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let red = 0
        do {
          red = red * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x3b) break

        scan += 1
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let green = 0
        do {
          green = green * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x3b) break

        scan += 1
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let blue = 0
        do {
          blue = blue * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x6d) break
        scan += 1
        red = Math.min(255, red)
        green = Math.min(255, green)
        blue = Math.min(255, blue)
        foreground = (red << 16) | (green << 8) | blue
      } else if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x33
        && input[scan + 3] === 0x38
        && input[scan + 4] === 0x3b
        && input[scan + 5] === 0x35
        && input[scan + 6] === 0x3b) {
        scan += 7
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let color = 0
        do {
          color = color * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x6d) break
        scan += 1
        foreground = TERMINAL_PACKED_COLOR_INDEXED | Math.min(255, color)
      } else if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x33
        && input[scan + 3] === 0x39
        && input[scan + 4] === 0x6d) {
        scan += 5
        foreground = DEFAULT_FG
      } else {
        break
      }

      let background: number
      if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x34
        && input[scan + 3] === 0x38
        && input[scan + 4] === 0x3b
        && input[scan + 5] === 0x32
        && input[scan + 6] === 0x3b) {
        scan += 7
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let red = 0
        do {
          red = red * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x3b) break

        scan += 1
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let green = 0
        do {
          green = green * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x3b) break

        scan += 1
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let blue = 0
        do {
          blue = blue * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x6d) break
        scan += 1
        red = Math.min(255, red)
        green = Math.min(255, green)
        blue = Math.min(255, blue)
        background = (red << 16) | (green << 8) | blue
      } else if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x34
        && input[scan + 3] === 0x38
        && input[scan + 4] === 0x3b
        && input[scan + 5] === 0x35
        && input[scan + 6] === 0x3b) {
        scan += 7
        byte = input[scan] ?? -1
        if (byte < 0x30 || byte > 0x39) break
        let color = 0
        do {
          color = color * 10 + byte - 0x30
          scan += 1
          byte = input[scan] ?? -1
        } while (byte >= 0x30 && byte <= 0x39)
        if (byte !== 0x6d) break
        scan += 1
        background = TERMINAL_PACKED_COLOR_INDEXED | Math.min(255, color)
      } else if (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && input[scan + 2] === 0x34
        && input[scan + 3] === 0x39
        && input[scan + 4] === 0x6d) {
        scan += 5
        background = DEFAULT_BG
      } else {
        break
      }

      while (input[scan] === 0x1b
        && input[scan + 1] === 0x5b
        && (input[scan + 2] ?? 0) >= 0x31
        && (input[scan + 2] ?? 0) <= 0x39
        && input[scan + 3] === 0x6d) {
        const attribute = input[scan + 2]! - 0x30
        if (attribute === 1) attrs |= CELL_BOLD
        else if (attribute === 2) attrs |= CELL_DIM
        else if (attribute === 3) attrs |= CELL_ITALIC
        else if (attribute === 4) attrs |= CELL_UNDERLINE
        else if (attribute === 5 || attribute === 6) attrs |= CELL_BLINK
        else if (attribute === 7) attrs |= CELL_INVERSE
        else if (attribute === 8) attrs |= CELL_HIDDEN
        else if (attribute === 9) attrs |= CELL_STRIKE
        scan += 4
      }

      const glyphStart = scan
      let glyphEnd = scan
      let glyphCount = 0
      let cellColumns = 0
      let singleCode = 0
      let singleWidth = 0
      while (glyphEnd < input.byteLength && input[glyphEnd] !== 0x1b) {
        const first = input[glyphEnd]!
        let code: number
        let length: number
        if (first >= 0x20 && first <= 0x7e) {
          code = first
          length = 1
        } else if (first >= 0xc2 && first <= 0xdf) {
          const second = input[glyphEnd + 1] ?? -1
          if (second < 0x80 || second > 0xbf) break records
          code = ((first & 0x1f) << 6) | (second & 0x3f)
          length = 2
        } else if (first >= 0xe0 && first <= 0xef) {
          const second = input[glyphEnd + 1] ?? -1
          const third = input[glyphEnd + 2] ?? -1
          if (second < 0x80 || second > 0xbf
            || third < 0x80 || third > 0xbf
            || (first === 0xe0 && second < 0xa0)
            || (first === 0xed && second > 0x9f)) break records
          code = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
          length = 3
        } else if (first >= 0xf0 && first <= 0xf4) {
          const second = input[glyphEnd + 1] ?? -1
          const third = input[glyphEnd + 2] ?? -1
          const fourth = input[glyphEnd + 3] ?? -1
          if (second < 0x80 || second > 0xbf
            || third < 0x80 || third > 0xbf
            || fourth < 0x80 || fourth > 0xbf
            || (first === 0xf0 && second < 0x90)
            || (first === 0xf4 && second > 0x8f)) break records
          code = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
          length = 4
        } else {
          break records
        }
        const width = (code >= 0x20 && code <= 0x7e) || (code >= 0x2580 && code <= 0x259f)
          ? 1
          : cellWidth(code)
        if (glyphCount === 0) {
          singleCode = code
          singleWidth = width
        }
        cellColumns += width
        glyphCount += 1
        glyphEnd += length
      }

      if (glyphCount === 0
        || input[glyphEnd] !== 0x1b
        || input[glyphEnd + 1] !== 0x5b
        || input[glyphEnd + 2] !== 0x30
        || input[glyphEnd + 3] !== 0x6d) break

      rowNumber ||= 1
      colNumber ||= 1
      let y = origin + rowNumber - 1
      if (y < 0) y = 0
      else if (y >= this.#rows) y = this.#rows - 1
      let x = colNumber - 1
      if (x < 0) x = 0
      else if (x >= this.#cols) x = this.#cols - 1
      if (x + cellColumns > this.#cols) break

      const row = this.#screen[y]!
      if (touchedRow && touchedRow !== row) this.#touchRow(touchedRow)
      touchedRow = row
      let writeX = x
      if (glyphCount === 1) {
        if (singleWidth === 0) {
          if (writeX > 0) {
            const column = writeX - 1
            const word = column * TERMINAL_PACKED_CELL_WORDS
            if (!((row.cells[word + 3] ?? 0) & CELL_SPACER)) {
              appendCellText(row, column, String.fromCodePoint(singleCode))
            }
          }
        } else {
          setCellCode(
            row,
            writeX,
            singleCode,
            foreground,
            background,
            attrs | (singleWidth === 2 ? CELL_WIDE : 0),
          )
          if (singleWidth === 2) {
            setCellCode(row, writeX + 1, 32, foreground, background, attrs | CELL_SPACER)
          }
          writeX += singleWidth
        }
      } else {
        let writeIndex = glyphStart
        while (writeIndex < glyphEnd) {
          const first = input[writeIndex]!
          let code: number
          let length: number
          if (first < 0x80) {
            code = first
            length = 1
          } else if (first < 0xe0) {
            code = ((first & 0x1f) << 6) | (input[writeIndex + 1]! & 0x3f)
            length = 2
          } else if (first < 0xf0) {
            code = ((first & 0x0f) << 12) | ((input[writeIndex + 1]! & 0x3f) << 6) | (input[writeIndex + 2]! & 0x3f)
            length = 3
          } else {
            code = ((first & 0x07) << 18)
              | ((input[writeIndex + 1]! & 0x3f) << 12)
              | ((input[writeIndex + 2]! & 0x3f) << 6)
              | (input[writeIndex + 3]! & 0x3f)
            length = 4
          }
          const width = (code >= 0x20 && code <= 0x7e) || (code >= 0x2580 && code <= 0x259f)
            ? 1
            : cellWidth(code)
          if (width === 0) {
            if (writeX > 0) {
              const column = writeX - 1
              const word = column * TERMINAL_PACKED_CELL_WORDS
              if (!((row.cells[word + 3] ?? 0) & CELL_SPACER)) {
                appendCellText(row, column, String.fromCodePoint(code))
              }
            }
          } else {
            setCellCode(
              row,
              writeX,
              code,
              foreground,
              background,
              attrs | (width === 2 ? CELL_WIDE : 0),
            )
            if (width === 2) {
              setCellCode(row, writeX + 1, 32, foreground, background, attrs | CELL_SPACER)
            }
            writeX += width
          }
          writeIndex += length
        }
      }

      attrs = 0
      finalY = y
      finalX = writeX
      index = glyphEnd + 4
      matched = true
    }

    if (matched) {
      if (touchedRow) this.#touchRow(touchedRow)
      this.#y = finalY
      this.#x = finalX
      this.#wrapPending = this.#wrap && finalX >= this.#cols
      this.#resetPen()
    }
    if (this.#bytesMatchAt(input, index, SYNCHRONIZED_OUTPUT_DISABLE)) {
      this.#synchronizedOutput = false
      return index + SYNCHRONIZED_OUTPUT_DISABLE.byteLength
    }
    return index
  }

  #bytesMatchAt(input: Uint8Array, index: number, expected: Uint8Array): boolean {
    if (index + expected.byteLength > input.byteLength) return false
    for (let offset = 0; offset < expected.byteLength; offset += 1) {
      if (input[index + offset] !== expected[offset]) return false
    }
    return true
  }

  #fastFramebufferRun(text: string, start: number): number {
    if (this.#insert) return -1
    const params = this.#frameParams
    const cursorEnd = scanNumericCsi(text, start + 2, params)
    if (cursorEnd === -1 || text.charCodeAt(cursorEnd - 1) !== 0x48 || params[5] !== 2) return -1
    const rowNumber = params[0] === 0 ? 1 : params[0]!
    const colNumber = params[1] === 0 ? 1 : params[1]!

    if (text.charCodeAt(cursorEnd) !== 0x1b || text.charCodeAt(cursorEnd + 1) !== 0x5b) return -1
    const foregroundEnd = scanNumericCsi(text, cursorEnd + 2, params)
    if (foregroundEnd === -1
      || text.charCodeAt(foregroundEnd - 1) !== 0x6d
      || Number(params[5]) !== 5
      || Number(params[0]) !== 38
      || Number(params[1]) !== 2) return -1
    const foreground = packRgbParams(params)

    if (text.charCodeAt(foregroundEnd) !== 0x1b || text.charCodeAt(foregroundEnd + 1) !== 0x5b) return -1
    const backgroundEnd = scanNumericCsi(text, foregroundEnd + 2, params)
    if (backgroundEnd === -1
      || text.charCodeAt(backgroundEnd - 1) !== 0x6d
      || Number(params[5]) !== 5
      || Number(params[0]) !== 48
      || Number(params[1]) !== 2) return -1
    const background = packRgbParams(params)

    let runEnd = backgroundEnd
    while (runEnd < text.length) {
      const code = text.charCodeAt(runEnd)
      if (code < 0x2580 || code > 0x259f) break
      runEnd += 1
    }
    const runLength = runEnd - backgroundEnd
    if (runLength === 0
      || text.charCodeAt(runEnd) !== 0x1b
      || text.charCodeAt(runEnd + 1) !== 0x5b
      || text.charCodeAt(runEnd + 2) !== 0x30
      || text.charCodeAt(runEnd + 3) !== 0x6d) return -1

    const origin = this.#origin ? this.#scrollTop : 0
    const y = Math.max(0, Math.min(this.#rows - 1, origin + rowNumber - 1))
    const x = Math.max(0, Math.min(this.#cols - 1, colNumber - 1))
    if (x + runLength > this.#cols) return -1
    const row = this.#screen[y]!
    for (let offset = 0; offset < runLength; offset += 1) {
      setCellCode(
        row,
        x + offset,
        text.charCodeAt(backgroundEnd + offset),
        foreground,
        background,
        this.#attrs,
      )
    }
    this.#touchRow(row)
    this.#y = y
    this.#x = x + runLength
    this.#wrapPending = this.#wrap && this.#x >= this.#cols
    this.#resetPen()
    return runEnd + 4
  }

  #fastCsi(text: string, start: number): number {
    this.#resetCsi()
    for (let index = start; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0x30 && code <= 0x39) {
        this.#csiValue = this.#csiValue * 10 + code - 0x30
        this.#csiHasValue = true
      } else if (code === 0x3b || code === 0x3a) {
        this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        this.#csiValue = 0
        this.#csiHasValue = false
      } else if (code === 0x3f && this.#csiParams.length === 0 && !this.#csiHasValue) {
        this.#csiPrivate = true
      } else if (code >= 0x40 && code <= 0x7e) {
        if (this.#csiHasValue || this.#csiParams.length > 0) {
          this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        }
        this.#dispatchCsi(text[index]!, this.#csiParams, this.#csiPrivate)
        this.#resetCsi()
        return index + 1
      }
    }
    this.#resetCsi()
    return -1
  }

  #resetCsi(): void {
    this.#csiParams.length = 0
    this.#csiValue = 0
    this.#csiHasValue = false
    this.#csiPrivate = false
  }

  #dispatchCsi(final: string, params: readonly number[], interrogate: boolean): void {
    if (final === 'A') {
      this.#wrapPending = false
      this.#y = Math.max(this.#scrollTop, this.#y - csiParam(params, 0, 1))
      return
    }
    if (final === 'B') {
      this.#wrapPending = false
      this.#y = Math.min(this.#scrollBottom, this.#y + csiParam(params, 0, 1))
      return
    }
    if (final === 'C') {
      this.#wrapPending = false
      this.#x = Math.min(this.#cols - 1, this.#x + csiParam(params, 0, 1))
      return
    }
    if (final === 'D') {
      this.#wrapPending = false
      this.#x = Math.max(0, this.#x - csiParam(params, 0, 1))
      return
    }
    if (final === 'E') {
      this.#x = 0
      this.#y = Math.min(this.#scrollBottom, this.#y + csiParam(params, 0, 1))
      return
    }
    if (final === 'F') {
      this.#x = 0
      this.#y = Math.max(this.#scrollTop, this.#y - csiParam(params, 0, 1))
      return
    }
    if (final === 'G' || final === '`') {
      this.#wrapPending = false
      this.#x = Math.max(0, Math.min(this.#cols - 1, csiParam(params, 0, 1) - 1))
      return
    }
    if (final === 'H' || final === 'f') {
      this.#wrapPending = false
      const row = csiParam(params, 0, 1) - 1
      const col = csiParam(params, 1, 1) - 1
      const origin = this.#origin ? this.#scrollTop : 0
      this.#y = Math.max(0, Math.min(this.#rows - 1, origin + row))
      this.#x = Math.max(0, Math.min(this.#cols - 1, col))
      return
    }
    if (final === 'J') this.#eraseDisplay(params[0] ?? 0)
    else if (final === 'K') this.#eraseLine(params[0] ?? 0)
    else if (final === 'L') this.#insertLines(csiParam(params, 0, 1))
    else if (final === 'M') this.#deleteLines(csiParam(params, 0, 1))
    else if (final === 'P') this.#deleteChars(csiParam(params, 0, 1))
    else if (final === '@') this.#insertBlanks(csiParam(params, 0, 1))
    else if (final === 'X') this.#eraseChars(csiParam(params, 0, 1))
    else if (final === 'S') this.#scrollUp(csiParam(params, 0, 1))
    else if (final === 'T') this.#scrollDown(csiParam(params, 0, 1))
    else if (final === 'd') this.#y = Math.max(0, Math.min(this.#rows - 1, csiParam(params, 0, 1) - 1))
    else if (final === 'm') this.#sgr(params)
    else if (final === 'n') this.#deviceStatus(params[0] ?? 0)
    else if (final === 'c') this.onOutput?.(String.fromCharCode(27) + '[?1;0c')
    else if (final === 'r') {
      const top = csiParam(params, 0, 1) - 1
      const bottom = (params[1] ? params[1] : this.#rows) - 1
      this.#scrollTop = Math.max(0, Math.min(this.#rows - 1, top))
      this.#scrollBottom = Math.max(this.#scrollTop, Math.min(this.#rows - 1, bottom))
      this.#x = 0
      this.#y = this.#origin ? this.#scrollTop : 0
    } else if (final === 'h' || final === 'l') {
      this.#setModes(params, interrogate, final === 'h')
    }
  }

  #dispatchOsc(body: string): void {
    const split = body.indexOf(';')
    const code = split === -1 ? body : body.slice(0, split)
    const value = split === -1 ? '' : body.slice(split + 1)
    if (code === '0' || code === '2' || code === '1') this.#title = value.replaceAll('\u0007', '')
  }

  #sgr(params: readonly number[]): void {
    if (params.length === 0) {
      this.#resetPen()
      return
    }
    for (let index = 0; index < params.length; index += 1) {
      const value = params[index] ?? 0
      if (value === 0) this.#resetPen()
      else if (value === 1) this.#attrs |= CELL_BOLD
      else if (value === 2) this.#attrs |= CELL_DIM
      else if (value === 3) this.#attrs |= CELL_ITALIC
      else if (value === 4) this.#attrs |= CELL_UNDERLINE
      else if (value === 5 || value === 6) this.#attrs |= CELL_BLINK
      else if (value === 7) this.#attrs |= CELL_INVERSE
      else if (value === 8) this.#attrs |= CELL_HIDDEN
      else if (value === 9) this.#attrs |= CELL_STRIKE
      else if (value === 21 || value === 22) this.#attrs &= ~(CELL_BOLD | CELL_DIM)
      else if (value === 23) this.#attrs &= ~CELL_ITALIC
      else if (value === 24) this.#attrs &= ~CELL_UNDERLINE
      else if (value === 25) this.#attrs &= ~CELL_BLINK
      else if (value === 27) this.#attrs &= ~CELL_INVERSE
      else if (value === 28) this.#attrs &= ~CELL_HIDDEN
      else if (value === 29) this.#attrs &= ~CELL_STRIKE
      else if (value === 39) this.#fg = DEFAULT_FG
      else if (value === 49) this.#bg = DEFAULT_BG
      else if (value >= 30 && value <= 37) this.#fg = TERMINAL_PACKED_COLOR_INDEXED | (value - 30)
      else if (value >= 40 && value <= 47) this.#bg = TERMINAL_PACKED_COLOR_INDEXED | (value - 40)
      else if (value >= 90 && value <= 97) this.#fg = TERMINAL_PACKED_COLOR_INDEXED | (value - 90 + 8)
      else if (value >= 100 && value <= 107) this.#bg = TERMINAL_PACKED_COLOR_INDEXED | (value - 100 + 8)
      else if (value === 38 || value === 48) {
        const target = this.#parseExtendedColor(params, index)
        if (target) {
          if (value === 38) this.#fg = target.color
          else this.#bg = target.color
          index = target.next
        }
      }
    }
  }

  #parseExtendedColor(params: readonly number[], index: number): { color: number; next: number } | undefined {
    const mode = params[index + 1]
    if (mode === 5 && params[index + 2] !== undefined) {
      return { color: TERMINAL_PACKED_COLOR_INDEXED | Math.max(0, Math.min(255, params[index + 2]!)), next: index + 2 }
    }
    if (mode === 2 && params[index + 4] !== undefined) {
      const red = Math.max(0, Math.min(255, params[index + 2] ?? 0))
      const green = Math.max(0, Math.min(255, params[index + 3] ?? 0))
      const blue = Math.max(0, Math.min(255, params[index + 4] ?? 0))
      return { color: (red << 16) | (green << 8) | blue, next: index + 4 }
    }
    return undefined
  }

  #setModes(params: readonly number[], privateMode: boolean, enable: boolean): void {
    for (const param of params.length === 0 ? [0] : params) {
      if (!privateMode) {
        if (param === 4) this.#insert = enable
        continue
      }
      if (param === 1) this.#applicationCursor = enable
      else if (param === 6) this.#origin = enable
      else if (param === 7) this.#wrap = enable
      else if (param === 25) this.#cursorVisible = enable
      else if (param === 2004) this.#bracketedPaste = enable
      else if (param === 2026) this.#synchronizedOutput = enable
      else if (param === 47 || param === 1047) this.#setAltScreen(enable, false)
      else if (param === 1048) {
        if (enable) {
          this.#savedX = this.#x
          this.#savedY = this.#y
        } else {
          this.#x = this.#savedX
          this.#y = this.#savedY
        }
      } else if (param === 1049) this.#setAltScreen(enable, true)
    }
  }

  #setAltScreen(enable: boolean, saveCursor: boolean): void {
    if (enable) {
      if (saveCursor) {
        this.#altSavedX = this.#x
        this.#altSavedY = this.#y
      }
      if (!this.#alt) this.#alt = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
      const current = this.#screen
      this.#screen = this.#alt
      this.#alt = current
      this.#eraseDisplay(2)
      this.#x = 0
      this.#y = 0
      return
    }
    if (!this.#alt) return
    const current = this.#screen
    this.#screen = this.#alt
    this.#alt = current
    if (saveCursor) {
      this.#x = this.#altSavedX
      this.#y = this.#altSavedY
    }
  }

  #deviceStatus(code: number): void {
    if (code === 5) this.onOutput?.(String.fromCharCode(27) + '[0n')
    if (code === 6) this.onOutput?.(String.fromCharCode(27) + '[' + String(this.#y + 1) + ';' + String(Math.min(this.#x, this.#cols - 1) + 1) + 'R')
  }

  #applyErase(row: MutableRow, column: number): void {
    setCellCode(
      row,
      column,
      32,
      this.#fg,
      this.#bg,
      this.#attrs & ~(CELL_WIDE | CELL_SPACER),
    )
  }

  #eraseRow(): MutableRow {
    return blankRow(
      this.#cols,
      this.#fg,
      this.#bg,
      this.#attrs & ~(CELL_WIDE | CELL_SPACER),
    )
  }

  #eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.#eraseLine(0)
      for (let row = this.#y + 1; row < this.#rows; row += 1) this.#screen[row] = this.#eraseRow()
    } else if (mode === 1) {
      for (let row = 0; row < this.#y; row += 1) this.#screen[row] = this.#eraseRow()
      this.#eraseLine(1)
    } else {
      this.#screen = Array.from({ length: this.#rows }, () => this.#eraseRow())
      if (mode === 3) this.#scrollback = []
    }
  }

  #eraseLine(mode: number): void {
    const row = this.#screen[this.#y]!
    const start = mode === 1 ? 0 : this.#x
    const end = mode === 1 ? this.#x : this.#cols - 1
    const from = mode === 2 ? 0 : start
    const to = mode === 2 ? this.#cols - 1 : end
    for (let col = from; col <= to; col += 1) this.#applyErase(row, col)
    this.#touchRow(row)
  }

  #eraseChars(count: number): void {
    const row = this.#screen[this.#y]!
    for (let index = 0; index < count && this.#x + index < this.#cols; index += 1) {
      this.#applyErase(row, this.#x + index)
    }
    this.#touchRow(row)
  }

  #insertBlanks(count: number): void {
    const row = this.#screen[this.#y]!
    const inserted = Math.min(Math.max(0, count), this.#cols - this.#x)
    if (inserted === 0) return
    const startWord = this.#x * TERMINAL_PACKED_CELL_WORDS
    const destinationWord = (this.#x + inserted) * TERMINAL_PACKED_CELL_WORDS
    const endWord = (this.#cols - inserted) * TERMINAL_PACKED_CELL_WORDS
    row.cells.copyWithin(destinationWord, startWord, endWord)
    if (row.graphemes) {
      const shifted = new Map<number, string>()
      for (const [column, text] of row.graphemes) {
        if (column < this.#x) shifted.set(column, text)
        else if (column < this.#cols - inserted) shifted.set(column + inserted, text)
      }
      row.graphemes = shifted.size ? shifted : undefined
    }
    for (let column = this.#x; column < this.#x + inserted; column += 1) this.#applyErase(row, column)
    this.#touchRow(row)
  }

  #deleteChars(count: number): void {
    const row = this.#screen[this.#y]!
    const deleted = Math.min(Math.max(0, count), this.#cols - this.#x)
    if (deleted === 0) return
    const destinationWord = this.#x * TERMINAL_PACKED_CELL_WORDS
    const sourceWord = (this.#x + deleted) * TERMINAL_PACKED_CELL_WORDS
    row.cells.copyWithin(destinationWord, sourceWord)
    if (row.graphemes) {
      const shifted = new Map<number, string>()
      for (const [column, text] of row.graphemes) {
        if (column < this.#x) shifted.set(column, text)
        else if (column >= this.#x + deleted) shifted.set(column - deleted, text)
      }
      row.graphemes = shifted.size ? shifted : undefined
    }
    for (let column = this.#cols - deleted; column < this.#cols; column += 1) this.#applyErase(row, column)
    this.#touchRow(row)
  }

  #insertLines(count: number): void {
    for (let index = 0; index < count; index += 1) this.#screen.splice(this.#y, 0, this.#eraseRow())
    this.#screen.splice(this.#scrollBottom + 1, count)
    this.#screen.length = this.#rows
  }

  #deleteLines(count: number): void {
    this.#screen.splice(this.#y, count)
    while (this.#screen.length < this.#rows) {
      this.#screen.splice(this.#scrollBottom + 1 - (this.#rows - this.#screen.length), 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #scrollUp(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const removed = this.#screen.splice(this.#scrollTop, 1)[0] ?? this.#eraseRow()
      if (this.#scrollTop === 0 && !this.#alt) this.#pushScrollback(removed)
      this.#screen.splice(this.#scrollBottom, 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #scrollDown(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.#screen.splice(this.#scrollBottom + 1, 1)
      this.#screen.splice(this.#scrollTop, 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #index(): void {
    this.#wrapPending = false
    if (this.#y === this.#scrollBottom) this.#scrollUp(1)
    else if (this.#y < this.#rows - 1) this.#y += 1
  }

  #reverseIndex(): void {
    this.#wrapPending = false
    if (this.#y === this.#scrollTop) this.#scrollDown(1)
    else if (this.#y > 0) this.#y -= 1
  }

  #pushScrollback(row: MutableRow): void {
    this.#scrollback.push(cloneRow(row))
    if (this.#scrollback.length > MAX_SCROLLBACK) this.#scrollback.splice(0, this.#scrollback.length - MAX_SCROLLBACK)
  }

  #touchRow(row: MutableRow): void {
    if (this.#lastTouchedRow === row && this.#lastTouchedVersion === this.#writeVersion) return
    this.#rowVersions.set(row, this.#writeVersion)
    this.#lastTouchedRow = row
    this.#lastTouchedVersion = this.#writeVersion
  }

  #resetPen(): void {
    this.#fg = DEFAULT_FG
    this.#bg = DEFAULT_BG
    this.#attrs = 0
  }

  #reset(): void {
    this.#screen = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
    this.#alt = undefined
    this.#x = 0
    this.#y = 0
    this.#scrollTop = 0
    this.#scrollBottom = this.#rows - 1
    this.#wrap = true
    this.#wrapPending = false
    this.#origin = false
    this.#cursorVisible = true
    this.#applicationCursor = false
    this.#bracketedPaste = false
    this.#synchronizedOutput = false
    this.#insert = false
    this.#resetPen()
    this.#state = 'ground'
  }
}
