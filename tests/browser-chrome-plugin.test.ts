import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromeBrowserBackend } from '../src/browser/chrome-backend.ts'
import { findChromeExecutable } from '../src/browser/chrome-process.ts'
import { browserSessionToken, chromeBrowserToken, createBrowserPlugin } from '../src/browser/plugin.ts'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { selectBrowserEngine } from '../src/ui/browser-host.tsx'
import type { BrowserEngineStatus } from '../src/browser/types.ts'

const roots: string[] = []

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-chrome-plugin-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('managed chrome backend', () => {
  it('provides the backend with the browser service and disposes it with the plugin', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(createBrowserPlugin({ statePath: false, dataRoot: dataRoot() }))
    expect(kernel.get(browserSessionToken)).toBeDefined()
    const chrome = kernel.get(chromeBrowserToken)
    // The engine is only claimed as available when a browser really is installed.
    expect(chrome.available).toBe(Boolean(findChromeExecutable()))
    expect(chrome.engineStatus.kind).toBe(chrome.available ? 'chrome' : 'unavailable')
    expect(chrome.openTabIds).toEqual([])

    await kernel.dispose()

    expect(chrome.available).toBe(false)
    expect(chrome.engineStatus.available).toBe(false)
    expect(() => kernel.get(chromeBrowserToken)).toThrow('Missing service: chrome-browser')
  })

  it('never claims a usable engine without an installed browser', () => {
    const backend = new ChromeBrowserBackend({ dataDirectory: dataRoot() })
    const installed = Boolean(findChromeExecutable())
    const status = backend.engineStatus
    expect(status.available).toBe(installed)
    expect(status.kind).toBe(installed ? 'chrome' : 'unavailable')
    expect(status.message.length).toBeGreaterThan(0)
    // Persistent Heddlework profiles share one managed Chrome data directory, so full isolation is not claimed.
    expect(status.profileIsolation).toBe('limited')
  })

  it('stops claiming availability once disposed', async () => {
    const backend = new ChromeBrowserBackend({ dataDirectory: dataRoot() })
    expect(backend.available).toBe(Boolean(findChromeExecutable()))
    await backend.dispose()
    expect(backend.available).toBe(false)
    expect(backend.engineStatus).toEqual({ kind: 'unavailable', available: false, message: 'The managed Chrome browser has stopped.', profileIsolation: 'limited' })
    // Disposing twice is harmless: shutdown paths can overlap.
    await backend.dispose()
  })

  it('ignores commands and input for a tab it has no session for', async () => {
    const backend = new ChromeBrowserBackend({ dataDirectory: dataRoot() })
    await backend.setViewport('missing', 800, 600)
    await backend.applyCommands('missing', 1, [], 0)
    await backend.input('missing', [{ method: 'Input.insertText', params: { text: 'x' } }])
    await backend.close('missing')
    expect(backend.openTabIds).toEqual([])
    await backend.dispose()
  })
})

describe('browser engine selection', () => {
  const native: BrowserEngineStatus = { kind: 'cef', available: true, message: 'Chromium Embedded Framework', profileIsolation: 'full' }
  const unavailable: BrowserEngineStatus = { kind: 'unavailable', available: false, message: 'no surface', profileIsolation: 'limited' }
  const chrome: BrowserEngineStatus = { kind: 'chrome', available: true, message: 'Chrome', profileIsolation: 'limited' }

  it('prefers the native engine whenever it can run', () => {
    expect(selectBrowserEngine(native, chrome, true)).toBe(native)
    // A host with both must not let the managed browser take over the native surface.
    expect(selectBrowserEngine(native, chrome, false)).toBe(native)
  })

  it('falls back to managed Chrome only when no native engine exists', () => {
    expect(selectBrowserEngine(unavailable, chrome, true)).toBe(chrome)
    expect(selectBrowserEngine(unavailable, chrome, false)).toBe(unavailable)
    expect(selectBrowserEngine(unavailable, undefined, true)).toBe(unavailable)
  })

  it('reports the unavailable engine when neither backend can run', () => {
    expect(selectBrowserEngine(unavailable, { kind: 'unavailable', available: false, message: 'Chrome was not found.', profileIsolation: 'limited' }, true)).toBe(unavailable)
  })
})
