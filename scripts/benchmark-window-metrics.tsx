/**
 * Counts the native window-metrics reads the workbench pattern issues on a real
 * window. On Linux and Windows each `getWindowSize()` is a blocking round trip to
 * GPUix's dedicated GPUI UI thread (gpuix `packages/native/src/renderer.rs`: the
 * getter sends a `UiCommand` over a `sync_channel` and waits in `recv_ui_response`),
 * so the number of polls per second is JS-thread time spent waiting.
 *
 * Phase A reproduces the pollers the app used to run (root size + root insets,
 * terminal panel, browser panel). Phase B runs the single shared subscription the
 * app runs now. Both phases are measured in the same live window.
 *
 *   bun run benchmark:window-metrics
 */
import React, { useMemo } from 'react'
import { createRenderer, createRoot, flushSync, startFrameLoop, useWindowInsets, useWindowSize } from '@gpuix/react'
import { WINDOW_METRICS_INTERVAL_MS, WindowMetricsProvider, useWindowMetrics, windowInsetsPollInterval } from '../src/ui/window-metrics.tsx'

const PHASE_MS = Number(process.env.HEDDLEWORK_METRICS_PHASE_MS ?? 3_000)

const renderer = createRenderer()
let reads = 0
const counted = () => {
  reads += 1
  return nativeGetWindowSize()
}
const nativeGetWindowSize = renderer.getWindowSize.bind(renderer)
try {
  renderer.getWindowSize = counted
} catch {
  Object.defineProperty(renderer, 'getWindowSize', { value: counted, configurable: true })
}
if (renderer.getWindowSize !== counted) throw new Error('Could not intercept renderer.getWindowSize()')

renderer.init({
  title: 'Heddlework window-metrics benchmark',
  appId: 'io.github.monotykamary.heddlework.metrics',
  windowDecorations: 'client',
  width: 1240,
  height: 820,
  resizable: true,
  focus: false,
  show: true,
} as Parameters<typeof renderer.init>[0])

function LegacyRoot() {
  useWindowSize({ intervalMs: 50 })
  useWindowInsets({ intervalMs: 50 })
  return null
}

function LegacyPanel() {
  useWindowSize({ intervalMs: 50 })
  return null
}

function LegacyWidePanel() {
  useWindowSize({ intervalMs: 100 })
  return null
}

function SharedPhase() {
  // Mirrors src/ui/app.tsx, which owns the tree's only window-metrics subscription.
  const size = useWindowSize({ intervalMs: WINDOW_METRICS_INTERVAL_MS })
  const insets = useWindowInsets({ intervalMs: windowInsetsPollInterval() })
  const metrics = useMemo(() => ({ size, insets }), [size, insets])
  return (
    <WindowMetricsProvider metrics={metrics}>
      <SharedConsumer />
      <SharedConsumer />
      <SharedConsumer />
    </WindowMetricsProvider>
  )
}

function SharedConsumer() {
  useWindowMetrics()
  return null
}

const root = createRoot(renderer)
let finished = false
const loop = startFrameLoop(renderer, { onTerminated: () => finish('window terminated') })

async function measure(label: string, element: React.ReactElement) {
  flushSync(() => root.render(element))
  // Let the mount reads land before sampling, so the number is the steady-state poll rate.
  await Bun.sleep(250)
  reads = 0
  await Bun.sleep(PHASE_MS)
  return { label, reads, readsPerSecond: Number((reads / (PHASE_MS / 1000)).toFixed(1)) }
}

async function main() {
  const before = await measure('before - root size+insets 50ms, terminal 50ms, browser 100ms', (
    <>
      <LegacyRoot />
      <LegacyPanel />
      <LegacyWidePanel />
    </>
  ))
  const after = await measure(`after - one shared subscription at ${WINDOW_METRICS_INTERVAL_MS}ms (insets ${windowInsetsPollInterval()}ms)`, <SharedPhase />)
  console.log(JSON.stringify({ phaseMs: PHASE_MS, before, after }, null, 2))
  finish(undefined)
}

function finish(reason: string | undefined) {
  if (finished) return
  finished = true
  if (reason) console.error(`HEDDLEWORK_METRICS_BENCHMARK ${reason}`)
  loop.stop()
  try { root.unmount() } catch { /* The compositor may already have destroyed the surface. */ }
  try { renderer.shutdown() } catch { /* Preserve the exit path. */ }
  process.exit(reason ? 1 : 0)
}

setTimeout(() => finish('timeout'), PHASE_MS * 4 + 20_000)
await main()
