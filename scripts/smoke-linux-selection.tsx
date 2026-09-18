import { createRenderer, createRoot, flushSync, startFrameLoop } from '@gpuix/react'
import { codeSurfaceStyle } from '../src/ui/transcript-tools.tsx'
import { transcriptRowShellStyle } from '../src/ui/transcript.tsx'
import { SELECTION_CHROME_MARKER, SELECTION_CODE_MARKER, SELECTION_CONTENT_MARKER } from './linux-selection-lane.ts'

const title = process.env.HEDDLEWORK_SELECTION_TITLE ?? 'Heddlework selection smoke'
const appId = process.env.HEDDLEWORK_SELECTION_APP_ID ?? 'io.github.monotykamary.heddlework.selection-smoke'

const renderer = createRenderer()
renderer.init({
  title,
  appId,
  width: 900,
  height: 620,
  resizable: true,
  fullscreen: false,
  focus: true,
  show: true,
} as Parameters<typeof renderer.init>[0])

const codeTheme = { metrics: { codeTextSize: 14, codeLineHeight: 22 } } as never

function SelectionWindow() {
  return (
    <div testId="selection-root" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: 24, gap: 16, backgroundColor: '#101014' }}>
      <code testId="selection-code" code={SELECTION_CODE_MARKER} theme={codeTheme} style={codeSurfaceStyle()} />
      <div testId="selection-content" style={transcriptRowShellStyle({ user: false, compact: false, noSelect: false, contentGutter: 0 })}>
        <text style={{ color: '#e6e6ef', fontSize: 20 }}>{SELECTION_CONTENT_MARKER}</text>
      </div>
      <div testId="selection-chrome" style={transcriptRowShellStyle({ user: false, compact: false, noSelect: true, contentGutter: 0 })}>
        <text style={{ color: '#e6e6ef', fontSize: 20 }}>{SELECTION_CHROME_MARKER}</text>
      </div>
    </div>
  )
}

const root = createRoot(renderer)
flushSync(() => root.render(<SelectionWindow />))

const loop = startFrameLoop(renderer, { onTerminated: () => process.exit(0) })
const safety = setTimeout(() => { console.error('HEDDLEWORK_SELECTION_TIMEOUT'); process.exit(124) }, 60_000)
process.once('SIGTERM', () => {
  clearTimeout(safety)
  loop.stop()
  try { root.unmount() } catch { /* the compositor may already have destroyed the surface */ }
  try { renderer.shutdown() } catch { /* preserve the signal exit path */ }
  process.exit(143)
})
