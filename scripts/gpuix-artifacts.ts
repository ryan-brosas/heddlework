import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Host triples published by the pinned GPUix native package. */
export function nativeAddonFilename(platform: string, arch: string): string {
  const names: Record<string, string> = {
    'darwin-arm64': 'gpuix-native.darwin-arm64.node',
    'linux-x64': 'gpuix-native.linux-x64-gnu.node',
    'win32-x64': 'gpuix-native.win32-x64-msvc.node',
  }
  const name = names[`${platform}-${arch}`]
  if (!name) throw new Error(`Unsupported GPUix native host: ${platform}-${arch}`)
  return name
}

/** Never validate a stale installed binary when the pinned artifacts are missing. */
export function installNativeAddon(source: string, installedPackage: string, addonName: string): void {
  const addon = resolve(source, addonName)
  const declarations = resolve(source, 'index.d.ts')
  for (const path of [addon, declarations, installedPackage]) {
    if (!existsSync(path)) throw new Error(`Cannot install pinned GPUix native artifacts: missing ${path}`)
  }
  copyFileSync(addon, resolve(installedPackage, addonName))
  copyFileSync(declarations, resolve(installedPackage, 'index.d.ts'))
}
