import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { REQUIRED_NATIVE_METHODS } from '../src/native-runtime.ts'
import { nativeBuildCommand, parseGpuixSourcePin } from './gpuix-source.ts'
import { installNativeAddon, nativeAddonFilename } from './gpuix-artifacts.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetAddon = nativeAddonFilename(process.platform, process.arch)
const pin = parseGpuixSourcePin(JSON.parse(readFileSync(resolve(root, 'gpuix-runtime.json'), 'utf8')))
const source = process.env.HEDDLEWORK_GPUIX_SOURCE
  ? resolve(process.env.HEDDLEWORK_GPUIX_SOURCE)
  : resolve(root, 'node_modules/.cache/heddlework-gpuix', pin.gpuixRevision)
const environment = {
  ...process.env,
  CARGO_INCREMENTAL: '0',
  CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
  CARGO_TARGET_DIR: resolve(source, 'packages/native/target'),
  CARGO_PROFILE_RELEASE_DEBUG: '0',
  CARGO_PROFILE_DEV_DEBUG: '0',
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2',
}

await checkout(source, pin.gpuixRepository, pin.gpuixRevision, 'heddlework-runtime')
await checkout(resolve(source, 'zed'), pin.zedRepository, pin.zedRevision, 'gpuix')
await run(['bun', 'install', '--frozen-lockfile'], source)
const stampPath = resolve(source, '.heddlework-build.json')
// The app asserts the same list at startup, so the installer cannot drift from it.
const NATIVE_API_CHECK = `const { GpuixRenderer } = await import("@gpuix/react"); for (const name of ${JSON.stringify([...REQUIRED_NATIVE_METHODS])}) if (typeof GpuixRenderer.prototype[name] !== "function") throw new Error("Missing native API: " + name)`
const stamp = JSON.stringify({ ...pin, platform: process.platform, arch: process.arch, cef: process.platform === 'darwin' && process.env.HEDDLEWORK_WITHOUT_CEF !== '1' })
// @gpuix/native loads the binary sitting in its own directory before falling back to the
// published platform package, so the pinned build has to be installed under its napi name to
// be the one the app - and the API check below - actually runs.
const builtAddon = resolve(source, 'packages/native', targetAddon)
const installedPackage = resolve(root, 'node_modules/@gpuix/native')

const buildRuntime = async (): Promise<void> => {
  await run(nativeBuildCommand(process.platform, process.env.HEDDLEWORK_WITHOUT_CEF === '1'), resolve(source, 'packages/native'))
  await run(['bun', 'run', 'build'], resolve(source, 'packages/react'))
}

/** Copy the complete pinned artifacts or fail before checking the installed runtime. */
const installAddon = (): void => installNativeAddon(resolve(source, 'packages/native'), installedPackage, targetAddon)

const runtimeResponds = async (): Promise<boolean> => {
  try {
    await run(['bun', '-e', NATIVE_API_CHECK], root)
    return true
  } catch {
    return false
  }
}

let alreadyBuilt = false
try { alreadyBuilt = !process.env.HEDDLEWORK_GPUIX_SOURCE && process.env.HEDDLEWORK_KEEP_BUILD_CACHE !== '1' && readFileSync(stampPath, 'utf8') === stamp } catch {}
// A restored cache can carry the stamp without the artifacts it describes.
if (alreadyBuilt && !existsSync(builtAddon)) {
  console.warn(`[heddlework] cached runtime has no ${targetAddon}; rebuilding`)
  alreadyBuilt = false
}
if (!alreadyBuilt) await buildRuntime()

// React hooks and the reconciler must share the application's one React instance.
// Source workspaces otherwise resolve their own devDependency copy.
const appRequire = createRequire(resolve(root, 'package.json'))
const packageRequire = createRequire(resolve(source, 'packages/react/package.json'))
const reactDirectory = dirname(appRequire.resolve('react/package.json'))
const reconcilerDirectory = dirname(packageRequire.resolve('react-reconciler/package.json'))
for (const link of [resolve(source, 'packages/react/node_modules/react'), resolve(dirname(reconcilerDirectory), 'react')]) {
  mkdirSync(dirname(link), { recursive: true })
  let entry
  try { entry = lstatSync(link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (entry && !entry.isSymbolicLink()) throw new Error(`Refusing to replace a real React directory: ${link}`)
  if (entry) unlinkSync(link)
  symlinkSync(reactDirectory, link, process.platform === 'win32' ? 'junction' : 'dir')
}

// Replace only the dependency symlink, never a real package directory or shared Bun cache.
const dependency = resolve(root, 'node_modules/@gpuix/react')
mkdirSync(dirname(dependency), { recursive: true })
let existing
try { existing = lstatSync(dependency) } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
// `bun install` materializes a declared dependency as a real directory, and the next
// install restores it, so that copy is safe to replace. Anything else is not.
if (existing?.isSymbolicLink()) {
  unlinkSync(dependency)
} else if (existing) {
  if (!isPublishedDependency(dependency, '@gpuix/react')) throw new Error(`Refusing to replace a real directory: ${dependency}`)
  rmSync(dependency, { recursive: true, force: true })
}
symlinkSync(resolve(source, 'packages/react'), dependency, process.platform === 'win32' ? 'junction' : 'dir')

installAddon()
console.log(`[heddlework] installed ${targetAddon} into node_modules/@gpuix/native`)

// The stamp says a build happened; only the runtime can say it still answers the pinned API.
if (alreadyBuilt && !(await runtimeResponds())) {
  console.warn('[heddlework] cached runtime did not answer the pinned API check; rebuilding')
  await buildRuntime()
  installAddon()
}

await run(['bun', '-e', NATIVE_API_CHECK], root)

writeFileSync(stampPath, stamp)
if (!alreadyBuilt && process.env.HEDDLEWORK_KEEP_BUILD_CACHE !== '1') {
  await run(['cargo', 'clean', '--manifest-path', 'packages/native/Cargo.toml'], source)
}
console.log(`[heddlework] installed GPUix ${pin.gpuixRevision} / Zed ${pin.zedRevision}`)

// A directory is only replaceable when it is the package manager's own copy of the
// dependency this script is about to shadow. A source checkout or a cache is never touched.
function isPublishedDependency(directory: string, name: string): boolean {
  try {
    return JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).name === name
  } catch {
    return false
  }
}

async function checkout(directory: string, repository: string, revision: string, branch: string) {
  if (!existsSync(resolve(directory, '.git'))) {
    mkdirSync(directory, { recursive: true })
    await run(['git', 'init', '--quiet'], directory)
    await run(['git', 'fetch', '--depth=1', repository, revision], directory)
    await run(['git', 'checkout', '-b', branch, 'FETCH_HEAD'], directory)
  }
  const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: directory, stdout: 'pipe', stderr: 'inherit' })
  const actual = (await new Response(child.stdout).text()).trim()
  if (await child.exited !== 0 || actual !== revision) throw new Error(`GPUix source revision mismatch at ${directory}: ${actual}; expected ${revision}`)
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, env: environment, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`Failed: ${command.join(' ')}`)
}
