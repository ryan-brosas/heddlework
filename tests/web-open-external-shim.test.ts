import { describe, expect, it } from 'bun:test'
import { openExternal, openPath, pickWorkspaceDirectory } from '../src/dom/shims/open-external.ts'

/** The shim reads `window` per call, so a stub can stand in for the tab. */
async function withWindow<T>(open: (url: string, target: string) => unknown, body: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = globals.window
  globals.window = { open }
  try {
    return await body()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

describe('web external-target shim', () => {
  it('opens http links in a new tab, detaches the opener, and reports that it did', async () => {
    const calls: string[] = []
    const tab: { opener: unknown } = { opener: {} }
    const opened = await withWindow((url, target) => { calls.push(`${url}|${target}`); return tab }, () => openExternal('https://example.com/docs'))
    expect(opened).toBe(true)
    expect(calls).toEqual(['https://example.com/docs|_blank'])
    expect(tab.opener).toBeNull()
  })

  it('never asks for the noopener feature, which hides a launch that started', async () => {
    // `window.open(url, '_blank', 'noopener')` returns null even when the tab opened, so a browser
    // could not be asked for its return value and every link reported a failure.
    const source = await Bun.file(new URL('../src/dom/shims/open-external.ts', import.meta.url)).text()
    expect(/tabWindow\(\)\.open\([^)]*\)/u.exec(source)?.[0]).toBe("tabWindow().open(parsed.href, '_blank')")
    expect(source).toContain('opened.opener = null')
  })

  it('reports a blocked popup as a failure instead of claiming success', async () => {
    expect(await withWindow(() => null, () => openExternal('https://example.com'))).toBe(false)
  })

  it('refuses unsafe schemes and unparseable addresses without touching the tab', async () => {
    let called = false
    const open = () => { called = true; return {} }
    expect(await withWindow(open, () => openExternal('file:///etc/passwd'))).toBe(false)
    expect(await withWindow(open, () => openExternal('not a url at all'))).toBe(false)
    expect(called).toBe(false)
  })

  it('keeps path opening and folder picking host-only', async () => {
    expect(await openPath('/tmp/project')).toBe(false)
    expect(await pickWorkspaceDirectory()).toEqual({ error: 'Folder picking is available on the desktop app' })
  })
})
