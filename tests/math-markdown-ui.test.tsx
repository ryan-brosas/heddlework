import React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createTestRoot } from '@gpuix/react/testing'
import { attachMathPunctuation, buildMathRows, MathMarkdown, parseInlineMarkdown, parseInlineWithMath } from '../src/ui/math-markdown.tsx'
import { loadFormulaRenderer } from '../src/ui/math-engine.ts'
import { segmentMathMarkdown } from '../src/ui/math-segment.ts'
import { Transcript } from '../src/ui/transcript.tsx'
import { createInitialState } from '../src/workbench/state.ts'
import { describeNative } from './helpers/native-renderer.ts'

beforeAll(async () => {
  await loadFormulaRenderer()
})

function box(root: ReturnType<typeof createTestRoot>, element: { id: number }) {
  const bounds = root.renderer.getElementBounds(element.id)
  if (!bounds) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: bounds[0]!, y: bounds[1]!, w: bounds[2]!, h: bounds[3]! }
}

async function renderMath(source: string) {
  const root = createTestRoot({ width: 900, height: 400 })
  root.render(React.createElement(MathMarkdown, {
    source,
    theme: undefined,
    testId: undefined,
    style: undefined,
    onLinkClick: undefined,
  }))
  let svgCount = 0
  for (let attempt = 0; attempt < 120; attempt++) {
    await Bun.sleep(25)
    root.renderer.flush()
    svgCount = root.renderer.findByType('svg').length
    if (svgCount > 0) break
  }
  return { root, svgCount }
}

describe('math rows', () => {
  it('keeps inline dollar math in the same row as surrounding text', () => {
    expect(buildMathRows(segmentMathMarkdown('Energy $E = mc^2$ inline'))).toEqual([
      {
        type: 'inline',
        parts: [
          { kind: 'text', source: 'Energy ' },
          { kind: 'math', latex: 'E = mc^2' },
          { kind: 'text', source: ' inline' },
        ],
      },
    ])
  })

  it('puts display math on its own row between markdown paragraphs', () => {
    expect(buildMathRows(segmentMathMarkdown('Before\n\n$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$\n\nAfter'))).toEqual([
      { type: 'markdown', source: 'Before' },
      { type: 'display', latex: '\\int_0^\\infty e^{-x}\\,dx = 1' },
      { type: 'markdown', source: 'After' },
    ])
  })

  it('keeps headings as markdown even when a later paragraph has inline math', () => {
    expect(buildMathRows(segmentMathMarkdown('## 4. Formulas\n\nEnergy $E = mc^2$ inline'))).toEqual([
      { type: 'markdown', source: '## 4. Formulas' },
      {
        type: 'inline',
        parts: [
          { kind: 'text', source: 'Energy ' },
          { kind: 'math', latex: 'E = mc^2' },
          { kind: 'text', source: ' inline' },
        ],
      },
    ])
  })

  it('keeps bold wrapping a formula inside the markers', () => {
    expect(parseInlineWithMath('**small \uE0000\uE001**:', ['t'])).toEqual([
      { kind: 'text', text: 'small ', bold: true, italic: false, code: false },
      { kind: 'math', latex: 't', bold: true, italic: false, glue: '' },
      { kind: 'text', text: ':', bold: false, italic: false, code: false },
    ])
  })

  it('keeps a comma after a formula attached to that formula', () => {
    expect(attachMathPunctuation(parseInlineWithMath('at \uE0000\uE001, and more', ['CR = 3']))).toEqual([
      { kind: 'text', text: 'at ', bold: false, italic: false, code: false },
      { kind: 'math', latex: 'CR = 3', bold: false, italic: false, glue: ',' },
      { kind: 'text', text: ' and more', bold: false, italic: false, code: false },
    ])
  })

  it('parses bold, italic, and inline code around formulas', () => {
    expect(parseInlineMarkdown('is the *symmetric* form and `contains` plus **small t**')).toEqual([
      { text: 'is the ', bold: false, italic: false, code: false },
      { text: 'symmetric', bold: false, italic: true, code: false },
      { text: ' form and ', bold: false, italic: false, code: false },
      { text: 'contains', bold: false, italic: false, code: true },
      { text: ' plus ', bold: false, italic: false, code: false },
      { text: 'small t', bold: true, italic: false, code: false },
    ])
  })

  it('keeps headings with math as headings, not raw hashes', () => {
    expect(buildMathRows(segmentMathMarkdown('## 2. What $v(t)$ means'))).toEqual([
      {
        type: 'heading',
        level: 2,
        parts: [
          { kind: 'text', source: '2. What ' },
          { kind: 'math', latex: 'v(t)' },
          { kind: 'text', source: ' means' },
        ],
      },
    ])
  })

  it('keeps lists with math as list items, not raw dashes', () => {
    expect(buildMathRows(segmentMathMarkdown('- **small t**: $x$ decays\n- **large t**: rest'))).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [
            { kind: 'text', source: '**small t**: ' },
            { kind: 'math', latex: 'x' },
            { kind: 'text', source: ' decays' },
          ],
          [{ kind: 'text', source: '**large t**: rest' }],
        ],
      },
    ])
  })

  it('reconstructs markdown tables with math in cells', () => {
    expect(buildMathRows(segmentMathMarkdown('| Feature | Formula |\n| --- | --- |\n| seed | $s$ |'))).toEqual([
      {
        type: 'table',
        headers: [[{ kind: 'text', source: 'Feature' }], [{ kind: 'text', source: 'Formula' }]],
        rows: [[[{ kind: 'text', source: 'seed' }], [{ kind: 'math', latex: 's' }]]],
      },
    ])
  })
})

describeNative('math markdown', () => {
  it('renders plain markdown untouched', () => {
    const root = createTestRoot({ width: 900, height: 400 })
    root.render(React.createElement(MathMarkdown, { source: 'plain **bold** text', theme: undefined, testId: undefined, style: undefined, onLinkClick: undefined }))
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).toContain('plain bold text')
    expect(root.renderer.findByType('svg')).toHaveLength(0)
    root.unmount()
  })

  it('wraps after a formula at word boundaries instead of a whole clause', async () => {
    const { root, svgCount } = await renderMath('Enforced floors in the harness: $CR \\ge 4.5$ for normal text, low-contrast threshold at $CR = 3$, and contrast adjustments capped at a 9% pixel-delta.')
    expect(svgCount).toBeGreaterThan(0)
    const formula = root.renderer.findByTestId('math-inline')
    const andWord = root.renderer.findByType('text').find((node) => node.text?.includes('and'))
    expect(formula).toBeTruthy()
    expect(andWord).toBeTruthy()
    const formulaBox = box(root, formula!)
    const andBox = box(root, andWord!)
    expect(Math.abs(andBox.y - formulaBox.y)).toBeLessThan(20)
    expect(andBox.x).toBeGreaterThan(formulaBox.x)
    root.unmount()
  })

  it('keeps a comma on the same line as the formula before it', async () => {
    const { root, svgCount } = await renderMath('threshold at $CR = 3$, and contrast')
    expect(svgCount).toBeGreaterThan(0)
    const formula = root.renderer.findByTestId('math-inline')
    const comma = root.renderer.findByType('text').find((node) => node.text === ',')
    expect(formula).toBeTruthy()
    expect(comma).toBeTruthy()
    const formulaBox = box(root, formula!)
    const commaBox = box(root, comma!)
    expect(Math.abs(commaBox.y - formulaBox.y)).toBeLessThan(20)
    expect(commaBox.x).toBeGreaterThan(formulaBox.x)
    root.unmount()
  })

  it('renders inline math on the same line as surrounding words', async () => {
    const { root, svgCount } = await renderMath('Energy $E = mc^2$ inline and display:')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('Energy')
    expect(painted).toContain('inline')
    expect(painted).not.toContain('mc^2')
    const energy = root.renderer.findByType('text').find((node) => node.text?.includes('Energy'))
    const formula = root.renderer.findByTestId('math-inline')
    expect(energy).toBeTruthy()
    expect(formula).toBeTruthy()
    const energyBox = box(root, energy!)
    const formulaBox = box(root, formula!)
    expect(Math.abs(formulaBox.y - energyBox.y)).toBeLessThan(20)
    expect(formulaBox.x).toBeGreaterThan(energyBox.x)
    root.unmount()
  })

  it('keeps short table formulas on the same line as surrounding words', async () => {
    const { root, svgCount } = await renderMath('| Feature | Insight |\n| --- | --- |\n| x | Beta($n$) prior |')
    expect(svgCount).toBeGreaterThan(0)
    const beta = root.renderer.findByType('text').find((node) => node.text?.includes('Beta'))
    const formula = root.renderer.findByTestId('math-inline')
    expect(beta).toBeTruthy()
    expect(formula).toBeTruthy()
    const betaBox = box(root, beta!)
    const formulaBox = box(root, formula!)
    expect(Math.abs(formulaBox.y - betaBox.y)).toBeLessThan(20)
    expect(formulaBox.x).toBeGreaterThan(betaBox.x)
    root.unmount()
  })

  it('scales wide table formulas to the cell instead of clipping them', async () => {
    const latex = 'w = B(0.25 + 0.75\\mathrm{spec}) / \\max(1, \\mathrm{df}/6)'
    const source = ['| Feature | Formula | Insight |', '| --- | --- | --- |', `| x | y | edge $${latex}$ leftover |`].join('\n')
    const root = createTestRoot({ width: 540, height: 400 })
    root.render(React.createElement(MathMarkdown, { source, theme: undefined, testId: undefined, style: undefined, onLinkClick: undefined }))
    let formula = root.renderer.findByTestId('math-inline')
    for (let attempt = 0; attempt < 120 && !formula; attempt++) {
      await Bun.sleep(25)
      root.renderer.flush()
      formula = root.renderer.findByTestId('math-inline')
    }
    expect(formula).toBeTruthy()
    const bounds = box(root, formula!)
    expect(bounds.w).toBeGreaterThan(40)
    expect(bounds.w).toBeLessThanOrEqual(200)
    root.unmount()
  })

  it('renders math inside markdown tables instead of raw pipes', async () => {
    const { root, svgCount } = await renderMath('| Feature | Formula |\n| --- | --- |\n| seed | $s$ |')
    expect(svgCount).toBeGreaterThan(0)
    expect(root.renderer.findByTestId('math-table')).toBeTruthy()
    expect(root.renderer.findByTestId('math-inline')).toBeTruthy()
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('Feature')
    expect(painted).toContain('seed')
    expect(painted).not.toContain('$s$')
    root.unmount()
  })

  it('keeps headings out of the inline word-split path', async () => {
    const { root, svgCount } = await renderMath('## 4. Formulas\n\nEnergy $E = mc^2$ inline')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('4. Formulas')
    expect(painted).not.toContain('##')
    expect(painted).toContain('Energy')
    root.unmount()
  })

  it('boldens text on both sides of an inline formula', async () => {
    const { root, svgCount } = await renderMath('- **small $t$**: high-$\\lambda$ modes')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('small')
    expect(painted).toContain('high-')
    expect(painted).not.toContain('**')
    root.unmount()
  })

  it('strips emphasis markers when math is mixed into the paragraph', async () => {
    const { root, svgCount } = await renderMath('is the *symmetric* Laplacian $L$ and a `contains` edge')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('symmetric')
    expect(painted).toContain('contains')
    expect(painted).not.toContain('*symmetric*')
    expect(painted).not.toContain('`contains`')
    root.unmount()
  })

  it('renders a heading that itself contains math without hash marks', async () => {
    const { root, svgCount } = await renderMath('## 2. What $v(t)$ means\n\nNext')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('2.')
    expect(painted).toContain('What')
    expect(painted).toContain('means')
    expect(painted).not.toContain('##')
    root.unmount()
  })

  it('clicks tree navigation on a math assistant message', async () => {
    let navigations = 0
    const source = 'Threshold at $CR = 3$, and $\\mu_v$ decays.\n\n$$E = mc^2$$\n\nDone.'
    const root = createTestRoot({ width: 900, height: 700 })
    const fade = ['08', '18', '2C', '45', '65', '88', 'AC', 'CE', 'E8', 'F8']
    root.render(
      React.createElement('div', { style: { position: 'relative', width: 900, height: 700, display: 'flex', flexDirection: 'column' } },
        React.createElement(Transcript, {
          state: {
            ...createInitialState('/tmp/math-fork'),
            session: { model: null, thinkingLevel: 'off', isStreaming: false, sessionFile: '/tmp/math-fork.jsonl', sessionId: 'math-fork' },
            messages: [
              { role: 'user', content: 'Explain', timestamp: 1, workbenchEntryId: 'u1' },
              { role: 'assistant', content: [{ type: 'text', text: source }], timestamp: 2, workbenchEntryId: 'a1' },
            ],
            forkMessages: [{ entryId: 'u1', text: 'Explain' }],
          },
          presenters: new Map(),
          onOpenDiff: () => undefined,
          onRevert: () => { navigations += 1 },
        }),
        React.createElement('div', { testId: 'transcript-bottom-fade', style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, display: 'flex', flexDirection: 'column', pointerEvents: 'none' } },
          fade.map((alpha) => React.createElement('div', { key: alpha, style: { height: 24, flexShrink: 0, backgroundColor: `#09090B${alpha}`, pointerEvents: 'none' } })),
        ),
      ),
    )
    let treeAction
    for (let attempt = 0; attempt < 80; attempt++) {
      await Bun.sleep(25)
      root.renderer.flush()
      const found = root.renderer.findByType('div').filter((node) => node.testId === 'tree-message')
      if (found.length >= 2 && root.renderer.findByType('svg').length > 0) {
        treeAction = found.at(-1)
        break
      }
    }
    expect(treeAction).toBeTruthy()
    const treeActionBox = box(root, treeAction!)
    root.renderer.nativeSimulateClick(treeActionBox.x + 8, treeActionBox.y + 8)
    root.renderer.dispatchNativeEvents()
    expect(navigations).toBe(1)
    root.unmount()
  })

  it('does not let formula hit targets swallow clicks below the message', async () => {
    let clicks = 0
    const root = createTestRoot({ width: 900, height: 500 })
    root.render(
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', width: 900 } },
        React.createElement(MathMarkdown, {
          source: 'Ledger $\\mu_v$ decays and $S \\ge \\theta$ holds. Final note $n$.',
          theme: undefined,
          testId: undefined,
          style: undefined,
          onLinkClick: undefined,
        }),
        React.createElement('div', {
          testId: 'after-math',
          style: { width: 120, height: 24, background: '#333333' },
          onClick: () => { clicks += 1 },
        }),
      ),
    )
    for (let attempt = 0; attempt < 80; attempt++) {
      await Bun.sleep(25)
      root.renderer.flush()
      if (root.renderer.findByType('svg').length > 0) break
    }
    const target = root.renderer.findByTestId('after-math')
    expect(target).toBeTruthy()
    const bounds = box(root, target!)
    root.renderer.nativeSimulateClick(bounds.x + 8, bounds.y + 8)
    root.renderer.dispatchNativeEvents()
    expect(clicks).toBe(1)
    const formula = root.renderer.findByTestId('math-inline')
    expect(formula?.style.overflow).toBe('hidden')
    expect(formula?.style.pointerEvents).toBe('none')
    root.unmount()
  })

  it('renders display math centered with a line of space above and below', async () => {
    const { root, svgCount } = await renderMath('Before\n\n$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$\n\nAfter')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join('\n')
    expect(painted).toContain('Before')
    expect(painted).toContain('After')
    expect(painted).not.toContain('\\int_0')
    const formula = root.renderer.findByTestId('math-display')
    expect(formula).toBeTruthy()
    const markdowns = root.renderer.findByType('markdown')
    const before = markdowns[0]!
    const after = markdowns[markdowns.length - 1]!
    const formulaBox = box(root, formula!)
    const beforeBox = box(root, before)
    const afterBox = box(root, after)
    expect(Math.abs(formulaBox.x - (900 - formulaBox.w) / 2)).toBeLessThan(8)
    expect(formulaBox.y).toBeGreaterThan(beforeBox.y + beforeBox.h + 14)
    expect(afterBox.y).toBeGreaterThan(formulaBox.y + formulaBox.h + 14)
    root.unmount()
  })
})
