import { describe, expect, it } from 'bun:test'

describe('icon button hit target', () => {
  it('uses an opaque fill so the top-bar download control is clickable off the glyph', async () => {
    const source = await Bun.file(new URL('../src/ui/primitives.tsx', import.meta.url)).text()
    const iconButton = source.slice(source.indexOf('export function IconButton'), source.indexOf('export function', source.indexOf('export function IconButton') + 1))
    expect(iconButton).toContain('backgroundColor: active ? colors.sidebarActive : colors.background')
    expect(iconButton).not.toContain('colors.transparent')
  })
})
