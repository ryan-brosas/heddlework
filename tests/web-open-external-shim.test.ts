import { describe, expect, it } from 'bun:test'
import { openExternal, openPath, pickWorkspaceDirectory } from '../src/dom/shims/open-external.ts'

/** The shim reads `window` per call, so a stub can stand in for the tab. */
async function withWindow<T>(open: (url: string, target: string, features: string) => unknown, body: () => Promise<T>): Promise<T> {
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
  it('opens http links in a new tab and reports that it did', async () => {
    const calls: string[] = []
    const opened = await withWindow((url, target, features) => { calls.push(`${url}|${target}|${features}`); return {} }, () => openExternal('https://example.com/docs'))
    expect(opened).toBe(true)
    expect(calls).toEqual(['https://example.com/docs|_blank|noopener,noreferrer'])
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
