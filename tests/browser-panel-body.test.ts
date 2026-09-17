import { describe, expect, it } from 'bun:test'
import { browserPanelBody } from '../src/ui/browser-panel.tsx'

describe('browser panel body', () => {
  it('shows the unavailable state instead of an address surface when no engine can run', () => {
    // The Linux desktop case: a tab with a URL must not read as a browser that failed to load.
    expect(browserPanelBody({ available: false, hasTab: true, hasUrl: true })).toBe('unavailable')
    expect(browserPanelBody({ available: false, hasTab: true, hasUrl: false })).toBe('unavailable')
    expect(browserPanelBody({ available: false, hasTab: false, hasUrl: false })).toBe('unavailable')
  })

  it('shows the surface, the empty state, or nothing once an engine is available', () => {
    expect(browserPanelBody({ available: true, hasTab: true, hasUrl: true })).toBe('surface')
    expect(browserPanelBody({ available: true, hasTab: true, hasUrl: false })).toBe('empty')
    expect(browserPanelBody({ available: true, hasTab: false, hasUrl: false })).toBe('none')
  })
})
