import { expect, it } from 'bun:test'
import React from 'react'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { TerminalSmokeView } from '../scripts/linux-terminal-smoke-view.tsx'
import { runTerminalShortcutLane } from '../scripts/linux-terminal-smoke-lane.ts'
import { TERMINAL_COPY_SOURCE, TERMINAL_INTERRUPT_MARKER, TERMINAL_PASTE_ECHO } from '../scripts/linux-terminal-smoke-contract.ts'
import { bunTerminalAvailable } from '../src/terminal/backend.ts'
import { describeNative } from './helpers/native-renderer.ts'

/**
 * Executes the compositor lane's assertion sequence locally, against the local GPUIX test renderer and a
 * real PTY but with clipboard I/O injected. `scripts/linux-window-smoke.ts` runs the same
 * `runTerminalShortcutLane` on real compositors, so this test is what keeps that lane honest between
 * manual compositor runs.
 */
// Two independent gates: the local test renderer only exists on macOS/Windows, and this lane also
// needs a real Bun PTY. Both are structural skips on Linux, not failures.
describeNative('linux terminal compositor lane', () => {
  const itPty = bunTerminalAvailable() ? it : it.skip
  itPty('passes every lane assertion through the production view over a real PTY', async () => {
    const root = createTestRoot({ width: 1_000, height: 900 })
    const copied: string[] = []
    let wroteClipboard = false
    root.render(React.createElement(TerminalSmokeView, {
      copy: async (text: string) => {
        copied.push(text)
        wroteClipboard = true
        return true
      },
      readPaste: async () => copied.at(-1),
    }))
    const automation = await connectTest(root.renderer)
    const waitFor = async <T,>(read: () => Promise<T | undefined>, timeoutMs: number, description: string): Promise<T> => {
      const started = Date.now()
      let lastError: unknown
      while (Date.now() - started < timeoutMs) {
        root.renderer.flush()
        try {
          const value = await read()
          if (value !== undefined) return value
        } catch (error) {
          // A missing element or unparsed evidence simply means the surface is not ready yet.
          lastError = error
        }
        await Bun.sleep(20)
      }
      throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`)
    }
    try {
      const checks = await runTerminalShortcutLane(automation, {
        compositor: 'local test renderer',
        backend: 'wayland',
        waitFor,
      })
      expect(checks.map((check) => check.name)).toEqual([
        'terminal-session-ready',
        'terminal-copy-shortcut',
        'terminal-paste-shortcut',
        'terminal-interrupt-shortcut',
      ])
      // The lane asserted on the view; these assertions confirm it was inspecting real work.
      expect(copied).toHaveLength(1)
      expect(copied[0]).toContain(TERMINAL_COPY_SOURCE)
      expect(wroteClipboard).toBe(true)
      expect(checks[0]!.evidence).toContain("local test renderer")
      expect(checks[2]!.evidence).toContain(TERMINAL_PASTE_ECHO + TERMINAL_COPY_SOURCE)
      expect(checks[3]!.evidence).toContain(TERMINAL_INTERRUPT_MARKER)
    } finally {
      await automation.close()
      root.unmount()
    }
  }, 20_000)
})
