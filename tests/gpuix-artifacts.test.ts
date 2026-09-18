import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installNativeAddon, nativeAddonFilename } from '../scripts/gpuix-artifacts.ts'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('pinned native artifacts', () => {
  it('selects only host triples supported by the pinned package', () => {
    expect(nativeAddonFilename('darwin', 'arm64')).toBe('gpuix-native.darwin-arm64.node')
    expect(nativeAddonFilename('linux', 'x64')).toBe('gpuix-native.linux-x64-gnu.node')
    expect(nativeAddonFilename('win32', 'x64')).toBe('gpuix-native.win32-x64-msvc.node')
    for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64'], ['freebsd', 'x64']] as const) {
      expect(() => nativeAddonFilename(platform, arch)).toThrow('Unsupported GPUix native host')
    }
  })

  for (const missing of ['addon', 'declarations', 'package', undefined] as const) {
    it(`requires a complete install (${missing ?? 'success'})`, () => {
      const root = mkdtempSync(join(tmpdir(), 'heddlework-native-artifacts-'))
      directories.push(root)
      const source = join(root, 'source')
      const target = join(root, 'installed')
      const name = nativeAddonFilename('linux', 'x64')
      mkdirSync(source)
      if (missing !== 'addon') writeFileSync(join(source, name), 'pinned binary')
      if (missing !== 'declarations') writeFileSync(join(source, 'index.d.ts'), 'pinned declarations')
      if (missing !== 'package') {
        mkdirSync(target)
        writeFileSync(join(target, name), 'stale binary')
      }
      if (missing) {
        expect(() => installNativeAddon(source, target, name)).toThrow('Cannot install pinned GPUix native artifacts')
        if (missing !== 'package') expect(readFileSync(join(target, name), 'utf8')).toBe('stale binary')
      } else {
        installNativeAddon(source, target, name)
        expect(readFileSync(join(target, name), 'utf8')).toBe('pinned binary')
        expect(readFileSync(join(target, 'index.d.ts'), 'utf8')).toBe('pinned declarations')
      }
    })
  }
})
