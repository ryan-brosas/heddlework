import React, { createContext, useContext } from 'react'
import { useWindowInsets, useWindowSize } from '@gpuix/react'

/**
 * Poll interval for the tree's single window-metrics subscription.
 *
 * `getWindowSize()` answers on the calling thread on macOS, but on Linux and Windows
 * it is a blocking round trip to the dedicated GPUI UI thread: the napi getter sends a
 * `UiCommand` over a `sync_channel` and waits in `recv_ui_response`
 * (gpuix `packages/native/src/renderer.rs`, 2s timeout). Each read therefore waits for
 * that thread to reach the command - up to two seconds while it is painting a session
 * switch - on the same thread that runs React. One poller for the whole tree keeps that
 * cost independent of how many panels need the numbers; this interval is the macOS knob.
 */
export const WINDOW_METRICS_INTERVAL_MS = 100
/** Linux/Windows idle size poll. Matches the titlebar chrome idle cadence. */
export const WINDOW_SIZE_IDLE_POLL_MS = 300
/** Streaming or an in-flight thread switch backs the blocking size poll off. */
export const WINDOW_SIZE_STREAMING_POLL_MS = 1_500

/** Size poll: macOS can afford 100ms; Linux/Windows must not pile 2s UI-thread waits. */
export function windowSizeIntervalMs(platform: string | undefined, heavyUi = false): number {
  if (platform === 'darwin') return WINDOW_METRICS_INTERVAL_MS
  return heavyUi ? WINDOW_SIZE_STREAMING_POLL_MS : WINDOW_SIZE_IDLE_POLL_MS
}

/** `windowSizeIntervalMs` for the platform this code is running on. */
export function windowSizePollInterval(heavyUi = false): number {
  return windowSizeIntervalMs(hostPlatform(), heavyUi)
}

/**
 * How often window insets are re-read.
 *
 * Off macOS the native getter cannot change: `get_window_insets` returns
 * `WindowInsets::default()` for every other platform (gpuix `packages/native/src/renderer.rs`),
 * while the hook still calls `getWindowSize()` internally to derive `keyboardTop` and
 * `visibleHeight` - a second blocking round trip per tick on Linux and Windows for a constant.
 * Polling them once a second there keeps whatever the platform reports without paying a
 * per-interval round trip for it; macOS keeps the shared cadence because its insets do change.
 */
export function windowInsetsIntervalMs(platform: string | undefined): number {
  return platform === 'darwin' ? WINDOW_METRICS_INTERVAL_MS : 1_000
}

function hostPlatform(): string | undefined {
  return typeof process === 'undefined' ? undefined : process.platform
}

/** `windowInsetsIntervalMs` for the platform this code is running on. */
export function windowInsetsPollInterval(): number {
  return windowInsetsIntervalMs(hostPlatform())
}

export interface WindowMetrics {
  size: ReturnType<typeof useWindowSize>
  insets: ReturnType<typeof useWindowInsets>
}

const WindowMetricsContext = createContext<WindowMetrics | undefined>(undefined)

export function WindowMetricsProvider({ metrics, children }: { metrics: WindowMetrics; children: React.ReactNode }) {
  return <WindowMetricsContext.Provider value={metrics}>{children}</WindowMetricsContext.Provider>
}

/**
 * Window size and insets for the workbench and its panels.
 *
 * Inside `WindowMetricsProvider` this adds no subscription of its own: the provider
 * already owns the poll, so a panel that needs the numbers costs nothing. Standalone
 * (a panel under test, an embed) it reads once instead of starting a timer, which is
 * what those panels used to poll for themselves.
 */
export function useWindowMetrics(): WindowMetrics {
  const shared = useContext(WindowMetricsContext)
  const size = useWindowSize({ intervalMs: shared ? false : windowSizePollInterval() })
  const insets = useWindowInsets({ intervalMs: shared ? false : windowInsetsPollInterval() })
  return shared ?? { size, insets }
}
