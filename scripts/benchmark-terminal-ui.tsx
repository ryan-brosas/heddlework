import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { TerminalOutputBuffer, type TerminalBackend, type TerminalOutputMetadata, type TerminalProcess } from '../src/terminal/backend.ts'
import type { TerminalProcessStatus, TerminalSpawnRequest } from '../src/terminal/types.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import {
  TERMINAL_CELL_WIDTH,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_X,
  TERMINAL_PADDING_Y,
} from '../src/ui/terminal-metrics.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'

const ESC = '\x1b'
const COLS = positiveInteger(process.env.TERMINAL_BENCH_COLS, 160)
const ROWS = positiveInteger(process.env.TERMINAL_BENCH_ROWS, 50)
const SAMPLES = positiveInteger(process.env.TERMINAL_BENCH_SAMPLES, 20)
const REQUIRE_DIRECT = process.env.TERMINAL_BENCH_REQUIRE_DIRECT === '1'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

const GLYPHS = [' ', '▀', '▄', '█', '▌', '▐', '▖', '▗', '▘', '▙', '▛', '▜', '▝', '▟'] as const

class BufferedMemoryTerminalBackend implements TerminalBackend {
  #output: TerminalOutputBuffer | undefined
  #running = false

  emit(bytes: Uint8Array): void {
    if (!this.#running || !this.#output) return
    for (let offset = 0; offset < bytes.byteLength; offset += 1_024) {
      this.#output.write(bytes.subarray(offset, offset + 1_024))
    }
  }

  async spawn(_request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const dataListeners = new Set<(chunk: Uint8Array, metadata?: TerminalOutputMetadata) => void>()
    const output = new TerminalOutputBuffer((chunk, metadata) => {
      for (const listener of dataListeners) listener(chunk, metadata)
    })
    this.#output = output
    this.#running = true
    return {
      write: (data) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        this.emit(bytes)
      },
      resize() {},
      kill: () => {
        if (!this.#running) return
        this.#running = false
        output.close()
      },
      onData(listener) {
        dataListeners.add(listener)
        return () => { dataListeners.delete(listener) }
      },
      onExit(_listener: (status: TerminalProcessStatus) => void) { return () => {} },
    }
  }
}

function framebufferFrame(index: number): string {
  let output = ''
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const red = (column * 5 + index * 13) & 0xff
      const green = (row * 9 + column * 2 + index * 7) & 0xff
      const blue = (row * 3 + column * 7 + index * 11) & 0xff
      const background = (red + green + blue + 37) & 0xff
      const glyph = GLYPHS[(row + column + index) % GLYPHS.length]!
      output += `${ESC}[${row + 1};${column + 1}H${ESC}[38;2;${red};${green};${blue}m${ESC}[48;2;${background};${blue};${red}m${glyph}${ESC}[0m`
    }
  }
  return output
}

if (!hasNativeTestRenderer) {
  if (REQUIRE_DIRECT) throw new Error('@gpuix/native test renderer is required for the direct terminal benchmark')
  console.log('animated native frames   unavailable  @gpuix/native test renderer is not installed')
  process.exit(0)
}

const encoder = new TextEncoder()
const frames = Array.from(
  { length: 4 },
  (_, index) => encoder.encode(`${ESC}[?2026h${ESC}[?25l${framebufferFrame(index)}${ESC}[?2026l`),
)
const width = COLS * TERMINAL_CELL_WIDTH + TERMINAL_PADDING_X * 2
const height = ROWS * TERMINAL_LINE_HEIGHT + TERMINAL_PADDING_Y * 2
const backend = new BufferedMemoryTerminalBackend()
const service = new TerminalSessionService({
  cwd: '/tmp/heddlework-terminal-benchmark',
  backend,
  appearancePath: false,
})
const sessionId = await service.spawn({ cols: COLS, rows: ROWS })
const root = createTestRoot({ width: Math.ceil(width), height: Math.ceil(height) })
root.render(
  <TerminalView
    service={service}
    sessionId={sessionId}
    placement="bottom"
    width={width}
    height={height}
    appearance="dark"
  />,
)
root.renderer.flush()

const renderer = root.renderer as typeof root.renderer & {
  supportsNativeTerminal?: () => boolean
  setTerminalFrame?: (...args: unknown[]) => void
}
const native = renderer.supportsNativeTerminal?.() === true
const direct = typeof renderer.setTerminalFrame === 'function'
if (REQUIRE_DIRECT && (!native || !direct)) {
  root.unmount()
  await service.dispose()
  throw new Error('patched GPUIX native terminal with setTerminalFrame() is required')
}
let nativeFrameCount = 0
let latestNativeFrame: readonly [number, string, Uint8Array] | undefined
let stageNativeFrame: ((...args: unknown[]) => void) | undefined
if (direct) {
  stageNativeFrame = renderer.setTerminalFrame!.bind(renderer)
  renderer.setTerminalFrame = (...args: unknown[]) => {
    stageNativeFrame!(...args)
    latestNativeFrame = args as unknown as [number, string, Uint8Array]
    nativeFrameCount += 1
  }
}
for (let index = 0; index < 3; index += 1) {
  backend.emit(frames[index % frames.length]!)
  await Bun.sleep(0)
  root.renderer.flush()
}
root.renderer.resetDebugFrameOverlayStats()

const parses: number[] = []
const projections: number[] = []
const paints: number[] = []
const totals: number[] = []
for (let index = 0; index < SAMPLES; index += 1) {
  const startedAt = performance.now()
  backend.emit(frames[(index + 3) % frames.length]!)
  const parsedAt = performance.now()
  await Bun.sleep(0)
  const projectedAt = performance.now()
  root.renderer.flush()
  const paintedAt = performance.now()
  parses.push(parsedAt - startedAt)
  projections.push(projectedAt - parsedAt)
  paints.push(paintedAt - projectedAt)
  totals.push(paintedAt - startedAt)
}

const stats = root.renderer.getDebugFrameOverlayStats()
const retained = root.renderer.getRetainedElementCount()
const mailboxPaints: number[] = []
if (latestNativeFrame && stageNativeFrame) {
  for (let sample = 0; sample < 6; sample += 1) {
    const startedAt = performance.now()
    for (let frame = 0; frame < 8; frame += 1) stageNativeFrame(...latestNativeFrame)
    root.renderer.flush()
    if (sample > 0) mailboxPaints.push(performance.now() - startedAt)
  }
}
console.log(`framebuffer median      ${percentile(totals, 0.5).toFixed(2).padStart(9)} ms  OpenTUI sync + hidden cursor + changed-cell truecolor at ${COLS}×${ROWS}`)
console.log(`framebuffer p95         ${percentile(totals, 0.95).toFixed(2).padStart(9)} ms  VT + direct NAPI stage + GPUI`)
console.log(`frame delivery median   ${percentile(parses, 0.5).toFixed(2).padStart(9)} ms  ingress + packed VT + native stage`)
console.log(`event-loop handoff      ${percentile(projections, 0.5).toFixed(2).padStart(9)} ms  direct frame is already staged`)
console.log(`frame flush median      ${percentile(paints, 0.5).toFixed(2).padStart(9)} ms  GPUI rasterization + layout + paint`)
console.log(`native paint p90        ${(stats.p90Ms ?? 0).toFixed(2).padStart(9)} ms  renderer frame instrumentation`)
if (mailboxPaints.length > 0) {
  console.log(`mailbox 8→1 median      ${percentile(mailboxPaints, 0.5).toFixed(2).padStart(9)} ms  eight raw arrivals + one raster/upload`)
}
console.log(`retained terminal nodes ${String(retained).padStart(9)}     ${native ? direct ? 'direct binary native surface' : 'base64 native surface' : 'React fallback'}`)

root.unmount()
await service.dispose()

if (native && retained > 5) throw new Error(`native terminal retained ${retained} nodes instead of one compact surface`)
if (direct && nativeFrameCount !== SAMPLES + 3) {
  throw new Error(`direct terminal projected ${nativeFrameCount} of ${SAMPLES + 3} frames`)
}
