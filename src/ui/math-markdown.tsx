import React, { memo, useEffect, useMemo, useState } from 'react'
import type { EventPayload } from '@gpuix/react'
import { containsPotentialMath, segmentMathMarkdown, type MathSegment } from './math-segment.ts'
import { formulaFallbackSource, loadFormulaRenderer, type FormulaRenderer } from './math-engine.ts'
import { markdownSourceWithNewlines } from './markdown-source.ts'
import { colors } from './theme.ts'

export interface MathMarkdownProps {
  source: string
  theme: Record<string, unknown> | undefined
  testId: string | undefined
  style: Record<string, unknown> | undefined
  onLinkClick: ((event: EventPayload) => void) | undefined
}

type InlinePart = { kind: 'text'; source: string } | { kind: 'math'; latex: string }
export type MathRow =
  | { type: 'markdown'; source: string }
  | { type: 'inline'; parts: InlinePart[] }
  | { type: 'display'; latex: string }
  | { type: 'heading'; level: number; parts: InlinePart[] }
  | { type: 'list'; ordered: boolean; items: InlinePart[][] }
  | { type: 'table'; headers: InlinePart[][]; rows: InlinePart[][][] }

interface FormulaPaint {
  renderer: FormulaRenderer | null
  ink: string
  fontSizePx: number
  lineHeight: number
  fontFamily: string | undefined
  fontWeight?: number
}

interface InlineRunStyle {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

export type InlineAtom =
  | { kind: 'text'; text: string; bold: boolean; italic: boolean; code: boolean }
  | { kind: 'math'; latex: string; bold: boolean; italic: boolean; glue: string }

const PLACEHOLDER_START = '\uE000'
const PLACEHOLDER_END = '\uE001'
const PLACEHOLDER_RE = /\uE000(\d+)\uE001/g


export const MathMarkdown = memo(function MathMarkdown(props: MathMarkdownProps) {
  const { source } = props
  if (!containsPotentialMath(source)) return <PlainMarkdown {...props} source={markdownSourceWithNewlines(source)} />
  const segments = segmentMathMarkdown(source)
  if (segments.every((segment) => segment.kind === 'text')) {
    return <PlainMarkdown {...props} source={markdownSourceWithNewlines(source)} />
  }
  return <SegmentedMarkdown {...props} segments={segments} />
}, (previous, next) => (
  previous.source === next.source
  && previous.theme === next.theme
  && previous.testId === next.testId
))

function PlainMarkdown({ source, theme, testId, style, onLinkClick }: MathMarkdownProps) {
  return React.createElement('markdown', {
    source,
    ...(testId !== undefined ? { testId } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(onLinkClick !== undefined ? { onLinkClick } : {}),
  } as never)
}

function SegmentedMarkdown({ segments, theme, testId, style, onLinkClick }: MathMarkdownProps & { segments: Array<MathSegment> }) {
  const renderer = useFormulaRenderer()
  const rows = useMemo(() => buildMathRows(segments), [segments])
  const ink = (theme as { text?: string } | undefined)?.text ?? colors.text
  const fontFamily = (theme as { fontSans?: string } | undefined)?.fontSans
  const metrics = (theme as { metrics?: {
    mdTextSize?: number
    mdLineHeight?: number
    mdTableCellPadding?: number
    mdHeadingSizes?: number[]
    mdHeadingLineHeights?: number[]
  } } | undefined)?.metrics
  const fontSizePx = metrics?.mdTextSize ?? 14
  const lineHeight = metrics?.mdLineHeight ?? Math.round(fontSizePx * 1.55)
  const cellPadding = metrics?.mdTableCellPadding ?? 8
  const paragraphGap = Math.round(fontSizePx * 1.15)
  const headingAbove = Math.round(fontSizePx * 2)
  const headingBelow = fontSizePx
  const formula: FormulaPaint = { renderer, ink, fontSizePx, lineHeight, fontFamily }
  return (
    <div
      {...(testId !== undefined ? { testId } : {})}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, overflow: 'hidden', pointerEvents: 'none', ...(style ?? {}) }}
    >
      {rows.map((row, index) => {
        const last = index === rows.length - 1
        const below = last ? 0 : paragraphGap
        if (row.type === 'display') {
          return (
            <div
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'center',
                width: '100%',
                minWidth: 0,
                paddingTop: lineHeight,
                paddingBottom: lineHeight,
              }}
            >
              <Formula latex={row.latex} display {...formula} />
            </div>
          )
        }
        if (row.type === 'markdown') {
          return (
            <PlainMarkdown
              key={index}
              source={markdownSourceWithNewlines(row.source)}
              theme={theme}
              testId={undefined}
              style={{ width: '100%', minWidth: 0, marginBottom: below, pointerEvents: 'auto' }}
              onLinkClick={onLinkClick}
            />
          )
        }
        if (row.type === 'heading') {
          const size = headingMetric(row.level, metrics?.mdHeadingSizes ?? [20, 16, 14, 14])
          const height = headingMetric(row.level, metrics?.mdHeadingLineHeights ?? [28, 24, 22, 22])
          return (
            <div key={index} style={{ width: '100%', minWidth: 0, marginTop: index === 0 ? 0 : headingAbove, marginBottom: last ? 0 : headingBelow }}>
              <InlineRun parts={row.parts} formula={{ ...formula, fontSizePx: size, lineHeight: height, fontWeight: 650 }} />
            </div>
          )
        }
        if (row.type === 'list') {
          return (
            <div key={index} style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 8, paddingLeft: 2, marginBottom: below }}>
              {row.items.map((item, itemIndex) => (
                <div key={itemIndex} style={{ display: 'flex', flexDirection: 'row', width: '100%', minWidth: 0, gap: 8 }}>
                  <text style={{ color: ink, fontSize: fontSizePx, lineHeight, flexShrink: 0, ...(fontFamily !== undefined ? { fontFamily } : {}) }}>
                    {row.ordered ? `${itemIndex + 1}.` : '•'}
                  </text>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <InlineRun parts={item} formula={formula} />
                  </div>
                </div>
              ))}
            </div>
          )
        }
        if (row.type === 'table') {
          return <MathTable key={index} headers={row.headers} rows={row.rows} theme={theme} onLinkClick={onLinkClick} cellPadding={cellPadding} formula={formula} last={last} />
        }
        return (
          <div key={index} style={{ width: '100%', minWidth: 0, marginBottom: below }}>
            <InlineRun parts={row.parts} formula={formula} />
          </div>
        )
      })}
    </div>
  )
}

function headingMetric(level: number, values: number[]): number {
  const index = Math.min(Math.max(level, 1), 6) - 1
  return values[Math.min(index, values.length - 1)] ?? values[0] ?? 16
}

function MathTable({ headers, rows, theme, onLinkClick, cellPadding, formula, last }: {
  headers: InlinePart[][]
  rows: InlinePart[][][]
  theme: Record<string, unknown> | undefined
  onLinkClick: ((event: EventPayload) => void) | undefined
  cellPadding: number
  formula: FormulaPaint
  last: boolean
}) {
  const columns = Math.max(headers.length, ...rows.map((row) => row.length), 1)
  const grid = [headers, ...rows]
  const gap = Math.round(formula.fontSizePx * 1.15)
  return (
    <div testId="math-table" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, marginTop: gap, marginBottom: last ? 0 : gap, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 8, overflow: 'hidden' }}>
      {grid.map((row, rowIndex) => (
        <div
          key={rowIndex}
          style={{
            display: 'flex',
            flexDirection: 'row',
            width: '100%',
            minWidth: 0,
            backgroundColor: rowIndex === 0 ? colors.raised : colors.transparent,
            borderBottomWidth: rowIndex === grid.length - 1 ? 0 : 1,
            borderColor: colors.border,
          }}
        >
          {Array.from({ length: columns }, (_, column) => {
            const parts = row[column] ?? [{ kind: 'text', source: '' }]
            return (
              <div
                key={column}
                style={{
                  flexGrow: 1,
                  flexBasis: 0,
                  minWidth: 0,
                  paddingTop: cellPadding,
                  paddingBottom: cellPadding,
                  paddingLeft: cellPadding,
                  paddingRight: cellPadding,
                  borderRightWidth: column === columns - 1 ? 0 : 1,
                  borderColor: colors.border,
                }}
              >
                <TableCell parts={parts} header={rowIndex === 0} theme={theme} onLinkClick={onLinkClick} formula={formula} />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function TableCell({ parts, header, theme, onLinkClick, formula }: {
  parts: InlinePart[]
  header: boolean
  theme: Record<string, unknown> | undefined
  onLinkClick: ((event: EventPayload) => void) | undefined
  formula: FormulaPaint
}) {
  const hasMath = parts.some((part) => part.kind === 'math')
  if (!hasMath) {
    const source = parts.map((part) => (part.kind === 'text' ? part.source : '')).join('')
    const heading = header ? `**${source}**` : source
    return (
      <PlainMarkdown
        source={markdownSourceWithNewlines(heading)}
        theme={theme}
        testId={undefined}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={onLinkClick}
      />
    )
  }
  return <InlineRun parts={parts} formula={header ? { ...formula, fontWeight: 650 } : formula} />
}

function InlineRun({ parts, formula }: { parts: InlinePart[]; formula: FormulaPaint }) {
  const atoms = styledAtomsFromParts(parts)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', width: '100%', minWidth: 0 }}>
      {atoms.flatMap((atom, atomIndex) => {
        if (atom.kind === 'math') {
          const formulaNode = <Formula key={`${atomIndex}-math`} latex={atom.latex} display={false} {...formula} {...(atom.bold ? { fontWeight: 700 } : {})} />
          if (!atom.glue) return [formulaNode]
          return [
            <div key={`${atomIndex}-math`} style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, alignItems: 'center' }}>
              {formulaNode}
              <text style={inlineTextStyle({ text: atom.glue, bold: atom.bold, italic: atom.italic, code: false }, formula)}>{atom.glue}</text>
            </div>,
          ]
        }
        return tokenizeInlineText(atom.text).map((token, tokenIndex) => {
          if (token.kind === 'break') {
            return <div key={`${atomIndex}-br-${tokenIndex}`} style={{ width: '100%', height: 0 }} />
          }
          return (
            <text
              key={`${atomIndex}-w-${tokenIndex}`}
              style={inlineTextStyle(atom, formula)}
            >
              {token.value}
            </text>
          )
        })
      })}
    </div>
  )
}

function styledAtomsFromParts(parts: InlinePart[]): InlineAtom[] {
  const formulas: string[] = []
  let source = ''
  for (const part of parts) {
    if (part.kind === 'text') {
      source += part.source
      continue
    }
    source += `${PLACEHOLDER_START}${formulas.length}${PLACEHOLDER_END}`
    formulas.push(part.latex)
  }
  return attachMathPunctuation(parseInlineWithMath(source, formulas))
}

function leadingMathGlue(text: string): string {
  let end = 0
  while (end < text.length && ',.;:!?)]'.includes(text[end]!)) end++
  return text.slice(0, end)
}

export function attachMathPunctuation(atoms: InlineAtom[]): InlineAtom[] {
  const output: InlineAtom[] = []
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index]!
    if (atom.kind !== 'math') {
      output.push(atom)
      continue
    }
    const next = atoms[index + 1]
    const glue = next?.kind === 'text' ? leadingMathGlue(next.text) : ''
    output.push({ kind: 'math', latex: atom.latex, bold: atom.bold, italic: atom.italic, glue })
    if (glue && next?.kind === 'text') {
      atoms[index + 1] = { ...next, text: next.text.slice(glue.length) }
    }
  }
  return output.filter((atom) => atom.kind === 'math' || atom.text.length > 0)
}

function inlineTextStyle(run: InlineRunStyle, formula: FormulaPaint): Record<string, unknown> {
  const italicFace = formula.fontFamily ? `${formula.fontFamily} Italic` : 'Helvetica Neue Italic'
  return {
    color: run.code ? colors.textMuted : formula.ink,
    fontSize: run.code ? Math.max(10, Math.round(formula.fontSizePx * 0.85)) : formula.fontSizePx,
    lineHeight: formula.lineHeight,
    flexShrink: 0,
    fontWeight: run.bold ? 700 : formula.fontWeight ?? 400,
    fontFamily: run.code ? 'Menlo' : run.italic ? italicFace : formula.fontFamily,
  }
}

const Formula = memo(function Formula({ latex, display, renderer, ink, fontSizePx, lineHeight }: {
  latex: string
  display: boolean
  renderer: FormulaRenderer | null
  ink: string
  fontSizePx: number
  lineHeight: number
  fontFamily: string | undefined
  fontWeight?: number
}) {
  const rendered = renderer ? renderer(latex, display, undefined, fontSizePx) : null
  if (!rendered) {
    if (display) {
      return React.createElement('markdown', {
        source: formulaFallbackSource(latex, true),
        style: { width: '100%', minWidth: 0 },
      } as never)
    }
    return <text style={{ color: ink, fontSize: fontSizePx, lineHeight, fontFamily: 'Menlo', flexShrink: 0 }}>{latex}</text>
  }
  return (
    <div
      testId={display ? 'math-display' : 'math-inline'}
      style={{ width: rendered.widthPx, height: rendered.heightPx, maxWidth: '100%', flexShrink: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {React.createElement('svg', {
        src: `data:image/svg+xml,${encodeURIComponent(rendered.svg)}`,
        style: { width: '100%', height: '100%', color: ink, pointerEvents: 'none' },
      } as never)}
    </div>
  )
})

export function parseInlineMarkdown(source: string): InlineRunStyle[] {
  return parseInlineWithMath(source, []).flatMap((atom) => (
    atom.kind === 'text' ? [{ text: atom.text, bold: atom.bold, italic: atom.italic, code: atom.code }] : []
  ))
}

export function parseInlineWithMath(source: string, formulas: string[]): InlineAtom[] {
  return parseAtoms(source, formulas, { bold: false, italic: false, code: false })
}

function parseAtoms(source: string, formulas: string[], style: { bold: boolean; italic: boolean; code: boolean }): InlineAtom[] {
  const atoms: InlineAtom[] = []
  let index = 0
  const emitText = (text: string): void => {
    if (!text) return
    atoms.push({ kind: 'text', text, bold: style.bold, italic: style.italic, code: style.code })
  }
  while (index < source.length) {
    if (source.startsWith(PLACEHOLDER_START, index)) {
      const end = source.indexOf(PLACEHOLDER_END, index + 1)
      if (end > index) {
        const latex = formulas[Number(source.slice(index + PLACEHOLDER_START.length, end))]
        if (latex !== undefined) atoms.push({ kind: 'math', latex, bold: style.bold, italic: style.italic, glue: '' })
        index = end + PLACEHOLDER_END.length
        continue
      }
    }
    if (!style.code && source[index] === '`') {
      const closing = source.indexOf('`', index + 1)
      if (closing > index + 1) {
        atoms.push(...parseAtoms(source.slice(index + 1, closing), formulas, { ...style, code: true }))
        index = closing + 1
        continue
      }
    }
    if (!style.code && source.startsWith('**', index)) {
      const closing = source.indexOf('**', index + 2)
      if (closing > index + 1) {
        atoms.push(...parseAtoms(source.slice(index + 2, closing), formulas, { ...style, bold: true }))
        index = closing + 2
        continue
      }
    }
    if (!style.code && source.startsWith('~~', index)) {
      const closing = source.indexOf('~~', index + 2)
      if (closing > index + 1) {
        atoms.push(...parseAtoms(source.slice(index + 2, closing), formulas, style))
        index = closing + 2
        continue
      }
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(source.slice(index))
    if (link) {
      emitText(link[1]!)
      index += link[0].length
      continue
    }
    if (!style.code && source[index] === '*' && source[index + 1] && source[index + 1] !== '*' && source[index + 1] !== ' ') {
      const closing = findEmphasisClose(source, index + 1, '*')
      if (closing > index + 1) {
        atoms.push(...parseAtoms(source.slice(index + 1, closing), formulas, { ...style, italic: true }))
        index = closing + 1
        continue
      }
    }
    const next = nextMarkup(source, index + 1)
    emitText(source.slice(index, next))
    index = next
  }
  return atoms
}

function findEmphasisClose(source: string, from: number, marker: string): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] !== marker) continue
    if (source[index - 1] === ' ') continue
    if (source[index + 1] === marker) {
      index++
      continue
    }
    return index
  }
  return -1
}

function nextMarkup(source: string, from: number): number {
  for (let index = from; index < source.length; index++) {
    const character = source[index]!
    if (character === PLACEHOLDER_START || character === '`' || character === '[') return index
    if (character === '*' || character === '~') return index
  }
  return source.length
}

export function buildMathRows(segments: Array<MathSegment>): Array<MathRow> {
  const { text, formulas } = materialize(segments)
  const rows: Array<MathRow> = []
  for (const block of splitSourceBlocks(text)) {
    const row = rowFromBlock(block, formulas)
    if (row) rows.push(row)
  }
  return rows
}

function materialize(segments: Array<MathSegment>): { text: string; formulas: Array<{ latex: string; display: boolean }> } {
  const formulas: Array<{ latex: string; display: boolean }> = []
  let text = ''
  for (const segment of segments) {
    if (segment.kind === 'text') {
      text += segment.text
      continue
    }
    text += `${PLACEHOLDER_START}${formulas.length}${PLACEHOLDER_END}`
    formulas.push({ latex: segment.latex, display: segment.display })
  }
  return { text, formulas }
}

function hasPlaceholder(source: string): boolean {
  return source.includes(PLACEHOLDER_START)
}

function rowFromBlock(block: { type: 'markdown' | 'paragraph' | 'table'; source: string }, formulas: Array<{ latex: string; display: boolean }>): MathRow | undefined {
  const source = block.source.replace(/^\n+|\n+$/g, '')
  if (!source) return undefined
  if (block.type === 'table') {
    const table = parseGfmTable(source, formulas)
    if (table) return table
  }
  if (!hasPlaceholder(source)) return { type: 'markdown', source }
  const solo = soloDisplay(source, formulas)
  if (solo !== undefined) return { type: 'display', latex: solo }
  if (block.type === 'markdown') {
    const heading = parseHeadingBlock(source, formulas)
    if (heading) return heading
    const list = parseListBlock(source, formulas)
    if (list) return list
  }
  return { type: 'inline', parts: partsFrom(source, formulas) }
}

function parseHeadingBlock(source: string, formulas: Array<{ latex: string; display: boolean }>): MathRow | undefined {
  const match = /^(#{1,6}) (.+)$/.exec(source.split('\n')[0] ?? '')
  if (!match) return undefined
  return { type: 'heading', level: match[1]!.length, parts: partsFrom(match[2]!, formulas) }
}

function parseListBlock(source: string, formulas: Array<{ latex: string; display: boolean }>): MathRow | undefined {
  const items: InlinePart[][] = []
  let ordered = false
  let found = false
  for (const line of source.split('\n')) {
    const match = /^ {0,3}([-+*]|(\d+)[.)]) (.*)$/.exec(line)
    if (match) {
      found = true
      ordered = match[2] !== undefined
      items.push(partsFrom(match[3]!, formulas))
      continue
    }
    if (items.length === 0) return undefined
    const last = items[items.length - 1]!
    last.push(...partsFrom(` ${line.trim()}`, formulas))
  }
  if (!found) return undefined
  return { type: 'list', ordered, items }
}

function soloDisplay(source: string, formulas: Array<{ latex: string; display: boolean }>): string | undefined {
  const match = /^\uE000(\d+)\uE001$/.exec(source.trim())
  if (!match) return undefined
  const formula = formulas[Number(match[1])]
  return formula?.display ? formula.latex : undefined
}

function partsFrom(source: string, formulas: Array<{ latex: string; display: boolean }>): InlinePart[] {
  const parts: InlinePart[] = []
  const matcher = new RegExp(PLACEHOLDER_RE.source, 'g')
  let last = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(source))) {
    if (match.index > last) parts.push({ kind: 'text', source: source.slice(last, match.index) })
    const formula = formulas[Number(match[1])]
    if (formula) parts.push({ kind: 'math', latex: formula.latex })
    last = match.index + match[0].length
  }
  if (last < source.length) parts.push({ kind: 'text', source: source.slice(last) })
  return parts.filter((part) => part.kind === 'math' || part.source.length > 0)
}

function splitSourceBlocks(text: string): Array<{ type: 'markdown' | 'paragraph' | 'table'; source: string }> {
  const lines = text.split('\n')
  const blocks: Array<{ type: 'markdown' | 'paragraph' | 'table'; source: string }> = []
  let index = 0
  while (index < lines.length) {
    if (lines[index]!.trim() === '') {
      index++
      continue
    }
    const fenceEnd = consumeFence(lines, index)
    if (fenceEnd !== undefined) {
      blocks.push({ type: 'markdown', source: lines.slice(index, fenceEnd).join('\n') })
      index = fenceEnd
      continue
    }
    if (isTableStart(lines, index)) {
      const end = consumeTable(lines, index)
      blocks.push({ type: 'table', source: lines.slice(index, end).join('\n') })
      index = end
      continue
    }
    if (isHeadingLine(lines[index]!) || isListLine(lines[index]!)) {
      const end = consumeMarkdownRun(lines, index, (line, offset) => (
        offset === index ? true : isListLine(line) || isIndentedContinuation(line)
      ))
      blocks.push({ type: 'markdown', source: lines.slice(index, end).join('\n') })
      index = end
      continue
    }
    const end = consumeParagraph(lines, index)
    blocks.push({ type: 'paragraph', source: lines.slice(index, end).join('\n') })
    index = end
  }
  return blocks
}

function consumeFence(lines: string[], start: number): number | undefined {
  const opening = /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(```+|~~~+)/.exec(lines[start]!)
  if (!opening) return undefined
  const marker = opening[1]!
  for (let index = start + 1; index < lines.length; index++) {
    const closing = /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`+|~+)[ \t]*$/.exec(lines[index]!)
    if (closing && closing[1]![0] === marker[0] && closing[1]!.length >= marker.length) return index + 1
  }
  return lines.length
}

function isHeadingLine(line: string): boolean {
  return /^ {0,3}#{1,6} /.test(line)
}

function isListLine(line: string): boolean {
  return /^ {0,3}(?:[-+*]|\d+[.)]) /.test(line)
}

function isIndentedContinuation(line: string): boolean {
  return /^ {2,}\S/.test(line)
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index]!.includes('|') && isSeparatorRow(lines[index + 1]!)
}

function consumeTable(lines: string[], start: number): number {
  let index = start + 2
  while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim() !== '') index++
  return index
}

function consumeMarkdownRun(lines: string[], start: number, take: (line: string, index: number) => boolean): number {
  let index = start + 1
  while (index < lines.length && lines[index]!.trim() !== '' && take(lines[index]!, index) && !isTableStart(lines, index) && consumeFence(lines, index) === undefined) {
    index++
  }
  return index
}

function consumeParagraph(lines: string[], start: number): number {
  let index = start + 1
  while (
    index < lines.length
    && lines[index]!.trim() !== ''
    && !isHeadingLine(lines[index]!)
    && !isListLine(lines[index]!)
    && !isTableStart(lines, index)
    && consumeFence(lines, index) === undefined
  ) {
    index++
  }
  return index
}

function parseGfmTable(source: string, formulas: Array<{ latex: string; display: boolean }>): MathRow | undefined {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2 || !isSeparatorRow(lines[1]!)) return undefined
  const headers = splitTableRow(lines[0]!).map((cell) => partsFrom(cell, formulas))
  const rows = lines.slice(2).map((line) => splitTableRow(line).map((cell) => partsFrom(cell, formulas)))
  if (headers.length === 0) return undefined
  return { type: 'table', headers, rows }
}

function splitTableRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map((cell) => cell.trim())
}

function tokenizeInlineText(text: string): Array<{ kind: 'word'; value: string } | { kind: 'break' }> {
  const tokens: Array<{ kind: 'word'; value: string } | { kind: 'break' }> = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) tokens.push({ kind: 'break' })
    const words = lines[index]!.match(/\S+\s*|\s+/gu)
    if (!words) continue
    for (const word of words) tokens.push({ kind: 'word', value: word })
  }
  return tokens
}

let cachedRenderer: FormulaRenderer | null | undefined

function useFormulaRenderer(): FormulaRenderer | null {
  const [renderer, setRenderer] = useState<FormulaRenderer | null>(() => (cachedRenderer === undefined ? null : cachedRenderer))
  useEffect(() => {
    if (cachedRenderer !== undefined) return
    let alive = true
    void loadFormulaRenderer().then((loaded) => {
      cachedRenderer = loaded
      if (alive) setRenderer(() => loaded)
    })
    return () => {
      alive = false
    }
  }, [])
  return renderer
}
