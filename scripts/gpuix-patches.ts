import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface RuntimeSourcePatch {
  readonly name: string
  readonly path: string
  readonly sha256: string
}

/** Build inputs only; generated NAPI declarations, binaries and Cargo targets are excluded. */
export const RUNTIME_SOURCE_PATHS = [
  'Cargo.toml', 'Cargo.lock', 'bun.lock', 'package.json', '.cargo', 'rust-toolchain.toml',
  'scripts', 'packages/native/src', 'packages/native/scripts', 'packages/native/build.rs',
  'packages/native/Cargo.toml', 'packages/native/Cargo.lock', 'packages/native/package.json',
  'packages/react/src', 'packages/react/package.json', 'packages/react/tsconfig.json',
] as const

export function listRuntimePatches(directory: string): RuntimeSourcePatch[] {
  let names: string[]
  try { names = readdirSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => name.endsWith('.patch')).sort().map((name) => {
    const path = resolve(directory, name)
    return { name, path, sha256: fileFingerprint(path) }
  })
}

export function patchTargets(patch: string): string[] {
  return [...new Set(patch.split('\n').flatMap((line) => {
    const path = /^\+\+\+ b\/(.+)$/u.exec(line)?.[1]
    return path === undefined ? [] : [path]
  }))]
}

export function runtimePatchFingerprint(patches: readonly RuntimeSourcePatch[]): string {
  return digest(patches.map((patch) => `${patch.name}:${patch.sha256}`).join('\n'))
}

/**
 * One repository's slice of the local native work, with the directory the patches apply inside.
 *
 * The pinned checkout is two Git repositories - the GPUix runtime and the nested GPUI it links against - so
 * a patch set is per repository. Keeping them separate is what lets the installer verify each checkout
 * against its own index instead of treating one repository's cleanliness as the other's.
 */
export interface RuntimePatchSet {
  /** Human-readable location, e.g. `gpuix` or `zed`. */
  readonly name: string
  /** Repository the patches apply inside. */
  readonly directory: string
  /** Build inputs of that repository that a patch set has to explain. */
  readonly paths: readonly string[]
  readonly patches: readonly RuntimeSourcePatch[]
}

/** Every declared patch set for a pinned checkout, in application order. */
export function runtimePatchSets(source: string, patchesRoot: string): RuntimePatchSet[] {
  return [
    { name: 'gpuix', directory: source, paths: RUNTIME_SOURCE_PATHS, patches: listRuntimePatches(resolve(patchesRoot, 'gpuix')) },
    { name: 'zed', directory: resolve(source, 'zed'), paths: ['.'], patches: listRuntimePatches(resolve(patchesRoot, 'zed')) },
  ].filter((set) => existsSync(resolve(set.directory, '.git')))
}

/** Identity of the whole declared patch set: a changed patch in either repository invalidates a cache. */
export function runtimePatchSetFingerprint(sets: readonly RuntimePatchSet[]): string {
  return digest(sets.map((set) => `${set.name}:${runtimePatchFingerprint(set.patches)}`).join('\n'))
}

/** Apply and verify every declared set, then refuse a checkout carrying anything they do not explain. */
export function applyRuntimePatchSets(sets: readonly RuntimePatchSet[]): void {
  for (const set of sets) applyRuntimePatches(set.directory, set.patches, set.paths)
}

export function fileFingerprint(path: string): string {
  return digest(readFileSync(path))
}

function git(directory: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Buffer {
  const result = Bun.spawnSync(['git', ...args], { cwd: directory, env: environment, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${directory}: ${result.stderr.toString().trim()}`)
  return Buffer.from(result.stdout)
}

/** Hash actual working-tree bytes, including staged and untracked input, independent of index staging. */
export function sourceFingerprint(directory: string, paths: readonly string[] = RUNTIME_SOURCE_PATHS): string {
  const files = [...new Set(git(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths]).toString().split('\0').filter(Boolean))].sort()
  const hash = createHash('sha256')
  for (const file of files) {
    const path = resolve(directory, file)
    hash.update(file + '\0')
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      hash.update('deleted\0')
      continue
    }
    if (stat.isSymbolicLink()) hash.update('link\0' + readlinkSync(path) + '\0')
    else if (stat.isFile()) hash.update(`${stat.mode & 0o111}\0${fileFingerprint(path)}\0`)
    else throw new Error(`Unsupported runtime source entry: ${path}`)
  }
  return hash.digest('hex')
}

/** The nested GPUI checkout has its own Git index and must be fingerprinted independently. */
export function runtimeSourceFingerprint(directory: string, paths: readonly string[] = RUNTIME_SOURCE_PATHS): string {
  const nested = resolve(directory, 'zed')
  // The pinned GPUI checkout is optional: a cache without it builds from the runtime sources alone.
  const nestedIdentity = existsSync(resolve(nested, '.git')) ? sourceFingerprint(nested, ['.']) : 'absent'
  return digest(sourceFingerprint(directory, paths) + '\0' + nestedIdentity)
}

/**
 * Reverse declared patches in a temporary index of the actual build inputs. Any remaining delta is
 * unexplained, even if it shares a file with a legitimate patch. The user's index/files are untouched.
 */
export function assertDeclaredSource(directory: string, patches: readonly RuntimeSourcePatch[], paths: readonly string[] = RUNTIME_SOURCE_PATHS): void {
  const scratch = mkdtempSync(join(tmpdir(), 'heddlework-source-index-'))
  const environment = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    git(directory, ['read-tree', 'HEAD'], environment)
    const existingPaths = paths.filter((path) => existsSync(resolve(directory, path)) || git(directory, ['ls-files', '--', path]).length > 0)
    if (existingPaths.length > 0) git(directory, ['add', '-A', '--', ...existingPaths], environment)
    for (const patch of [...patches].reverse()) git(directory, ['apply', '--cached', '--reverse', patch.path], environment)
    const changed = git(directory, ['diff', '--cached', '--name-only', 'HEAD', '--', ...paths], environment).toString().trim()
    if (changed) throw new Error(`Undeclared runtime source changes in ${directory}:\n${changed}\nPreserve these changes and declare a patch, or use a separate clean source checkout.`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function applyRuntimePatches(directory: string, patches: readonly RuntimeSourcePatch[], paths: readonly string[] = RUNTIME_SOURCE_PATHS): void {
  for (const patch of patches) {
    const applied = Bun.spawnSync(['git', 'apply', '--reverse', '--check', patch.path], { cwd: directory, stdout: 'ignore', stderr: 'ignore' })
    if (applied.exitCode === 0) continue
    // A cached checkout carries the patch revision it was built from, and both CI and a developer machine
    // reuse that cache after the patch changes. Repairing the files this patch owns is what turns that into a
    // rebuild; anything the patch does not declare still fails the check below, so this cannot bury real work.
    resetDeclaredTargets(directory, patch)
    git(directory, ['apply', patch.path])
  }
  // Only this repository's own index is checked here. A nested checkout has its own patch set
  // (`runtimePatchSets`), and checking it against an empty declaration from the outer set failed every
  // re-run: the nested tree already carries its applied patch, so the reverse-apply diff is never empty.
  assertDeclaredSource(directory, patches, paths)
}

/**
 * Restore the files a patch declares to the pinned revision, naming them: a stale checkout is repaired
 * loudly, never silently. Untracked declared targets are removed, tracked ones are checked out from HEAD.
 */
function resetDeclaredTargets(directory: string, patch: RuntimeSourcePatch): void {
  const targets = patchTargets(readFileSync(patch.path, 'utf8'))
  const status = git(directory, ['status', '--porcelain', '--untracked-files=all', '--', ...targets]).toString()
  const dirty = [...new Set(status.split('\n').flatMap((line) => {
    const entry = line.trimEnd()
    if (entry === '') return []
    return [entry.slice(3).split(' -> ').pop()?.trim() ?? '']
  }))].filter((path) => path !== '')
  if (dirty.length === 0) return
  console.warn(`[heddlework] ${patch.name} does not match ${directory}; restoring its declared files to the pinned revision:\n  ${dirty.join('\n  ')}`)
  const untracked = dirty.filter((path) => status.includes(`?? ${path}`))
  for (const path of untracked) rmSync(resolve(directory, path), { force: true })
  const tracked = dirty.filter((path) => !untracked.includes(path))
  if (tracked.length > 0) git(directory, ['checkout', 'HEAD', '--', ...tracked])
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
