import React from 'react'
import * as reactJsxRuntime from 'react/jsx-runtime'
import { describe, expect, it, mock } from 'bun:test'

type IntervalOption = number | false | undefined

const reads: Array<{ hook: 'size' | 'insets'; intervalMs: IntervalOption }> = []
const ZERO = { top: 0, right: 0, bottom: 0, left: 0 }
const NATIVE_SIZE = { width: 1280, height: 800 }
const NATIVE_INSETS = { safeArea: ZERO, ime: ZERO, effective: ZERO, keyboardTop: 800, keyboardVisible: false, visibleHeight: 800 }

// The hooks are the only thing between this module and the native renderer, so the
// subscription they are asked for is exactly what the test needs to observe.
mock.module('@gpuix/react', () => ({
  useWindowSize: (options?: { intervalMs?: IntervalOption }) => {
    reads.push({ hook: 'size', intervalMs: options?.intervalMs })
    return NATIVE_SIZE
  },
  useWindowInsets: (options?: { intervalMs?: IntervalOption }) => {
    reads.push({ hook: 'insets', intervalMs: options?.intervalMs })
    return NATIVE_INSETS
  },
}))
mock.module('@gpuix/react/jsx-runtime', () => ({ ...reactJsxRuntime }))

const { WindowMetricsProvider, WINDOW_METRICS_INTERVAL_MS, useWindowMetrics, windowInsetsIntervalMs, windowInsetsPollInterval, windowSizeIntervalMs, windowSizePollInterval } = await import('../src/ui/window-metrics.tsx')
const { renderToStaticMarkup } = await import('react-dom/server')

function Consumer({ label }: { label: string }) {
  const metrics = useWindowMetrics()
  return React.createElement('span', null, `${label}:${metrics.size.width}x${metrics.size.height}:${metrics.insets.effective.left}`)
}

describe('window metrics', () => {
  it('serves every consumer from the provider instead of polling per consumer', () => {
    reads.length = 0
    const provided = { size: { width: 900, height: 600 }, insets: { ...NATIVE_INSETS, keyboardTop: 600, visibleHeight: 600 } }
    const markup = renderToStaticMarkup(
      React.createElement(WindowMetricsProvider, {
        metrics: provided,
        children: [
          React.createElement(Consumer, { key: 'left', label: 'left' }),
          React.createElement(Consumer, { key: 'right', label: 'right' }),
        ],
      }),
    )

    expect(markup).toContain('left:900x600:0')
    expect(markup).toContain('right:900x600:0')
    // Every consumer asks for the value without a timer of its own.
    expect(reads).toHaveLength(4)
    expect(reads.every((read) => read.intervalMs === false)).toBe(true)
  })

  it('falls back to one polled subscription outside a provider', () => {
    reads.length = 0
    const markup = renderToStaticMarkup(React.createElement(Consumer, { label: 'solo' }))

    expect(markup).toContain('solo:1280x800:0')
    expect(reads).toEqual([
      { hook: 'size', intervalMs: windowSizePollInterval() },
      { hook: 'insets', intervalMs: windowInsetsPollInterval() },
    ])
  })

  it('polls insets at the shared cadence only where they can change', () => {
    expect(windowInsetsIntervalMs('darwin')).toBe(WINDOW_METRICS_INTERVAL_MS)
    // Off macOS the native getter returns WindowInsets::default(), and the hook's internal
    // getWindowSize() call is a blocking round trip, so insets do not justify that cadence.
    expect(windowInsetsIntervalMs('linux')).toBe(1_000)
    expect(windowInsetsIntervalMs('win32')).toBe(1_000)
    expect(windowInsetsIntervalMs(undefined)).toBe(1_000)
  })

  it('slows the blocking window-size poll off macOS, and further while the UI thread is busy', () => {
    expect(windowSizeIntervalMs('darwin')).toBe(WINDOW_METRICS_INTERVAL_MS)
    expect(windowSizeIntervalMs('darwin', true)).toBe(WINDOW_METRICS_INTERVAL_MS)
    expect(windowSizeIntervalMs('linux')).toBe(300)
    expect(windowSizeIntervalMs('linux', true)).toBe(1_500)
    expect(windowSizeIntervalMs('win32')).toBe(300)
    expect(windowSizeIntervalMs('win32', true)).toBe(1_500)
    expect(windowSizeIntervalMs(undefined, true)).toBe(1_500)
  })

  it('keeps the poll in the workbench root and out of the panels', async () => {
    const [app, terminalPanel, browserPanel] = await Promise.all([
      Bun.file(new URL('../src/ui/app.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/terminal-panel.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/browser-panel.tsx', import.meta.url)).text(),
    ])

    // On Linux and Windows every extra poller is another blocking round trip to GPUI's
    // UI thread, so the root owns the only subscription and the panels read it.
    // One subscription per getter, both owned by the root: on Linux and Windows every extra
    // poller is another blocking round trip to GPUI's UI thread.
    expect([...app.matchAll(/useWindow(?:Size|Insets)\(/g)]).toHaveLength(2)
    expect(app).toContain('useWindowSize({ intervalMs: windowSizePollInterval(deferLinuxUiPolls) })')
    expect(app).toContain('useWindowInsets({ intervalMs: windowInsetsPollInterval() })')
    expect(app.match(/<WindowMetricsProvider /g)).toHaveLength(1)
    for (const source of [terminalPanel, browserPanel]) {
      expect(source).not.toContain('useWindowSize')
      expect(source).not.toContain('useWindowInsets')
    }
  })
})
