import { describe, expect, test } from 'bun:test'
import { createWindowOptions } from '../src/window-options.ts'

describe('createWindowOptions', () => {
  test('uses transparent custom chrome only on macOS', () => {
    expect(createWindowOptions('darwin', 'minimal', '/profiles')).toEqual({
      title: 'Heddlework',
      width: 1240,
      height: 820,
      debugFrameOverlay: 'minimal',
      browserRootCachePath: '/profiles',
      nativeBrowserEnabled: true,
      titlebarTransparent: true,
      windowBackground: 'blurred',
      trafficLightX: 16,
      trafficLightY: 17,
    })
  })

  test('can disable native browser initialization before the renderer starts', () => {
    expect(createWindowOptions('darwin', 'hidden', '/profiles', false)).toMatchObject({
      browserRootCachePath: '/profiles',
      nativeBrowserEnabled: false,
    })
  })

  test('leaves native titlebars available on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const options = createWindowOptions(platform, 'hidden', '/profiles')
      expect(options).toEqual({
        title: 'Heddlework',
        width: 1240,
        height: 820,
        debugFrameOverlay: 'hidden',
        browserRootCachePath: '/profiles',
        nativeBrowserEnabled: true,
        windowBackground: 'opaque',
        ...(platform === 'linux' ? { appId: 'io.github.monotykamary.heddlework', windowDecorations: 'auto' } : {}),
      })
      expect('titlebarTransparent' in options).toBeFalse()
      expect('trafficLightX' in options).toBeFalse()
      expect('trafficLightY' in options).toBeFalse()
    }
  })
})
