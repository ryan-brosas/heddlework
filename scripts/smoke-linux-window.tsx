import { useEffect, useMemo, useState } from 'react'
import { createRenderer, createRoot, flushSync, startFrameLoop } from '@gpuix/react'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { copyTextToClipboard } from '../src/ui/clipboard-media.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'
import { sameWindowState, type NativeWindowState } from '../src/ui/window-controls.ts'
import { TERMINAL_COPY_SOURCE, TERMINAL_EVIDENCE_TEST_ID, TERMINAL_SMOKE_SHELL } from './linux-terminal-smoke-contract.ts'

const decorations = process.env.HEDDLEWORK_SMOKE_DECORATIONS
if (process.platform !== 'linux') throw new Error(`Linux smoke app cannot run on ${process.platform}`)
if (decorations !== 'client' && decorations !== 'server') {
  throw new Error('HEDDLEWORK_SMOKE_DECORATIONS must be client or server')
}

const title = process.env.HEDDLEWORK_SMOKE_TITLE ?? 'Heddlework Linux Window Smoke'
const appId = process.env.HEDDLEWORK_SMOKE_APP_ID ?? 'io.github.monotykamary.heddlework.smoke'

type WindowRenderer = ReturnType<typeof createRenderer> & {
  getWindowState(): NativeWindowState
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
}

const renderer = createRenderer() as WindowRenderer
for (const method of ['getWindowState', 'minimizeWindow', 'toggleMaximizeWindow', 'closeWindow'] as const) {
  if (typeof renderer[method] !== 'function') throw new Error(`Missing native window API: ${method}`)
}

renderer.init({
  title,
  appId,
  windowDecorations: decorations,
  width: 900,
  height: 620,
  resizable: true,
  fullscreen: process.env.HEDDLEWORK_SMOKE_START_FULLSCREEN === '1',
  focus: true,
  show: true,
} as Parameters<typeof renderer.init>[0])

const dragRegionProps = { testId: 'window-drag-region', windowDragRegion: true }
const resizeEdges = ['top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left', 'topLeft'] as const
type ResizeEdge = (typeof resizeEdges)[number]

function resizeStyle(edge: ResizeEdge): Record<string, unknown> {
  const style: Record<string, unknown> = { position: 'absolute' }
  if (edge === 'right' || edge === 'left') Object.assign(style, { top: 8, bottom: 8, width: 8, [edge]: 0 })
  else if (edge === 'top' || edge === 'bottom') Object.assign(style, { left: 8, right: 8, height: 8, [edge]: 0 })
  else {
    Object.assign(style, { width: 8, height: 8 })
    style[edge.startsWith('top') ? 'top' : 'bottom'] = 0
    style[edge.endsWith('Right') ? 'right' : 'left'] = 0
  }
  return style
}

// Matches the workbench's own Linux window-state cadence (src/ui/linux-window-chrome.tsx):
// every read is a blocking round trip to GPUI's UI thread, and the actions below re-read the
// state directly instead of waiting for the next tick.
const STATE_POLL_INTERVAL_MS = 200

let statePollingEnabled = true

function readState(): NativeWindowState | undefined {
  try {
    return renderer.getWindowState() as NativeWindowState
  } catch {
    return undefined
  }
}

function requestClose(): void {
  statePollingEnabled = false
  setTimeout(() => renderer.closeWindow(), 100)
}

// Terminal shortcut lane. The fixture hosts the production `TerminalView` over a real PTY and the
// production clipboard writer, and republishes a small evidence document that `linux-window-smoke.ts`
// asserts on. Copy is recorded from the view's injectable `copy` prop so the smoke can prove the
// clipboard write happened while the PTY received zero bytes; paste and interrupt are read from the
// PTY itself.
const terminalCopy = { calls: 0, wroteClipboard: false, text: '' }
const TERMINAL_SMOKE_WIDTH = 860
const TERMINAL_SMOKE_HEIGHT = 560

async function recordCopyToSystemClipboard(text: string): Promise<boolean> {
  terminalCopy.calls += 1
  terminalCopy.text = text
  const wrote = await copyTextToClipboard(text)
  terminalCopy.wroteClipboard = wrote
  return wrote
}

function TerminalSmoke() {
  const service = useMemo(() => new TerminalSessionService({ cwd: process.cwd() }), [])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [evidence, setEvidence] = useState('pending')

  useEffect(() => {
    let cancelled = false
    void service
      .spawn({ name: 'smoke', shell: '/bin/sh', args: ['-c', TERMINAL_SMOKE_SHELL] })
      .then((id) => { if (!cancelled) setSessionId(id) })
      .catch(() => undefined)
    return () => {
      cancelled = true
      void service.dispose()
    }
  }, [service])

  useEffect(() => {
    if (!sessionId) return
    const publish = () => {
      const session = service.getStateSnapshot().sessions.find((entry) => entry.id === sessionId)
      const next = JSON.stringify({
        text: service.grid(sessionId)?.viewport.map((row) => row.text).join('\n') ?? '',
        status: session?.status.kind ?? 'running',
        ...(session?.status.kind === 'exited' ? { exitCode: session.status.exitCode } : {}),
        copyCalls: terminalCopy.calls,
        wroteClipboard: terminalCopy.wroteClipboard,
        copiedMarker: terminalCopy.text.includes(TERMINAL_COPY_SOURCE),
      })
      setEvidence((current) => (current === next ? current : next))
    }
    publish()
    const timer = setInterval(publish, 100)
    return () => clearInterval(timer)
  }, [service, sessionId])

  if (!sessionId) return null
  return (
    <div style={{ paddingLeft: 24, width: '100%' }}>
      <div style={{ width: TERMINAL_SMOKE_WIDTH, height: TERMINAL_SMOKE_HEIGHT }}>
        <TerminalView
          service={service}
          sessionId={sessionId}
          placement="bottom"
          width={TERMINAL_SMOKE_WIDTH}
          height={TERMINAL_SMOKE_HEIGHT}
          appearance="dark"
          copy={recordCopyToSystemClipboard}
        />
      </div>
      <div testId={TERMINAL_EVIDENCE_TEST_ID} style={{ width: TERMINAL_SMOKE_WIDTH, height: 14, overflow: 'hidden' }}>
        <text style={{ color: '#94a3b8', fontSize: 9 }}>{evidence}</text>
      </div>
    </div>
  )
}

function SmokeWindow() {
  const [state, setState] = useState<NativeWindowState | undefined>(readState)

  useEffect(() => {
    const timer = setInterval(() => setState((current) => {
      if (!statePollingEnabled) return current
      const next = readState()
      return sameWindowState(current, next) ? current : next
    }), STATE_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const action = (invoke: () => void) => () => {
    invoke()
    setState(readState())
  }
  const maximizeEnabled = Boolean(state && (state.fullscreen || (state.canMaximize && state.resizable)))

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#111827', position: 'relative' }}>
      <div
        {...dragRegionProps}
        style={{ height: 48, backgroundColor: decorations === 'client' ? '#1f2937' : '#374151', padding: 12 }}
      >
        <text style={{ color: '#f9fafb', fontSize: 16 }}>Heddlework compositor smoke</text>
      </div>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div testId="smoke-state">
          <text style={{ color: '#d1d5db' }}>{state ? JSON.stringify(state) : 'pending'}</text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 12 }}>
          <div testId="action-minimize" onClick={action(() => renderer.minimizeWindow())} style={{ padding: 12, backgroundColor: '#334155' }}>
            <text style={{ color: '#f8fafc' }}>Minimize</text>
          </div>
          <div
            testId="action-maximize"
            {...(maximizeEnabled ? { onClick: action(() => renderer.toggleMaximizeWindow()) } : {})}
            style={{ padding: 12, backgroundColor: '#334155' }}
          >
            <text style={{ color: '#f8fafc' }}>Toggle maximize</text>
          </div>
          <div testId="maximize-enabled">
            <text>{String(maximizeEnabled)}</text>
          </div>
          <div testId="action-close" onClick={requestClose} style={{ padding: 12, backgroundColor: '#7f1d1d' }}>
            <text style={{ color: '#fef2f2' }}>Close</text>
          </div>
        </div>
      </div>
      <TerminalSmoke />
      {resizeEdges.map((edge) => (
        <div key={edge} testId={`window-resize-${edge}`} windowResizeEdge={edge} style={resizeStyle(edge) as never} />
      ))}
    </div>
  )
}

const root = createRoot(renderer)
flushSync(() => root.render(<SmokeWindow />))
const loop = startFrameLoop(renderer, {
  onTerminated: () => {
    console.error('HEDDLEWORK_SMOKE_TERMINATED')
    process.exit(0)
  },
})

const safetyTimer = setTimeout(() => {
  console.error('HEDDLEWORK_SMOKE_TIMEOUT')
  process.exit(124)
}, 105_000)

process.on('SIGUSR1', requestClose)

process.once('SIGTERM', () => {
  clearTimeout(safetyTimer)
  loop.stop()
  try { root.unmount() } catch { /* The compositor may already have destroyed the surface. */ }
  try { renderer.shutdown() } catch { /* Preserve the signal exit path. */ }
  process.exit(143)
})

console.error(`HEDDLEWORK_SMOKE_READY ${JSON.stringify({ title, appId, decorations })}`)
