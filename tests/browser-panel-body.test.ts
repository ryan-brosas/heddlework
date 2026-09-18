import { describe, expect, it } from 'bun:test'
import { browserPanelBody, browserPanelChrome } from '../src/ui/browser-panel.tsx'

describe('browser panel body', () => {
  it('shows the unavailable state instead of an address surface when no engine can run', () => {
    // The Linux desktop case: a tab with a URL must not read as a browser that failed to load.
    expect(browserPanelBody({ available: false, hasTab: true, hasUrl: true })).toBe('unavailable')
    expect(browserPanelBody({ available: false, hasTab: true, hasUrl: false })).toBe('unavailable')
    expect(browserPanelBody({ available: false, hasTab: false, hasUrl: false })).toBe('unavailable')
  })

  it('offers no embedded navigation or profile chrome without an engine', () => {
    // The Linux case: an address bar and a profile menu for a browser that cannot run. The
    // unavailable surface owns the system-browser action instead.
    expect(browserPanelChrome({ available: false, hasTab: true, profileMenuOpen: true })).toEqual({ toolbar: false, profileMenu: false })
    expect(browserPanelChrome({ available: true, hasTab: true, profileMenuOpen: true })).toEqual({ toolbar: true, profileMenu: true })
    expect(browserPanelChrome({ available: true, hasTab: false, profileMenuOpen: true })).toEqual({ toolbar: true, profileMenu: false })
  })

  it('renders a launch failure after the opaque unavailable surface', async () => {
    // The unavailable surface covers the body, so an earlier sibling notice is painted over. Paint
    // order cannot be observed without a native renderer, so the source order is the assertion.
    const source = await Bun.file(new URL('../src/ui/browser-panel.tsx', import.meta.url)).text()
    const body = source.slice(source.indexOf('testId="browser-panel-body"'))
    expect(body.indexOf('browser-external-error')).toBeGreaterThan(body.indexOf('<BrowserUnavailable'))
  })

  it('shows the surface, the empty state, or nothing once an engine is available', () => {
    expect(browserPanelBody({ available: true, hasTab: true, hasUrl: true })).toBe('surface')
    expect(browserPanelBody({ available: true, hasTab: true, hasUrl: false })).toBe('empty')
    expect(browserPanelBody({ available: true, hasTab: false, hasUrl: false })).toBe('none')
  })
})
