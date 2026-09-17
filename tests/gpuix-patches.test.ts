import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyRuntimePatches, fileFingerprint, listRuntimePatches, runtimePatchFingerprint, runtimePatchSets, runtimeSourceFingerprint, sourceFingerprint } from '../scripts/gpuix-patches.ts'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'heddlework-patches-'))
  directories.push(directory)
  return directory
}

function git(directory: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${directory}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

/** Exit code of a Git command, for the cases where failing is the interesting result. */
function gitCheck(directory: string, args: string[]): number {
  return Bun.spawnSync(['git', ...args], { cwd: directory, stdout: 'ignore', stderr: 'ignore' }).exitCode
}

/** Commit everything in `directory` under an explicit identity, so no global Git config is required. */
function commitAll(directory: string, message = 'initial'): void {
  git(directory, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '-A'])
  git(directory, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', message])
}

/** A minimal git repository with one committed source file. */
function scratchRepository(contents = 'initial\n'): string {
  const directory = scratchDirectory()
  mkdirSync(resolve(directory, 'src'), { recursive: true })
  writeFileSync(resolve(directory, 'src/input.rs'), contents)
  git(directory, ['init', '--quiet'])
  commitAll(directory)
  return directory
}

/** A one-line patch for `file`, written with the same a/ b/ prefixes the installer expects. */
function patchFor(_directory: string, file: string, before: string, after: string): { name: string; path: string; sha256: string } {
  const patch = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${before.trimEnd()}`,
    `+${after}`,
    '',
  ].join('\n')
  const path = join(scratchDirectory(), `0001-${file.replaceAll('/', '-')}.patch`)
  writeFileSync(path, patch)
  return { name: '0001-declared.patch', path, sha256: fileFingerprint(path) }
}

/** A patch from explicit hunk lines, for the shapes a one-line replacement cannot express. */
function patchLines(name: string, lines: readonly string[]): { name: string; path: string; sha256: string } {
  const path = join(scratchDirectory(), name)
  writeFileSync(path, [...lines, ''].join('\n'))
  return { name, path, sha256: fileFingerprint(path) }
}

/**
 * Apply a patch set that the checkout does not match and return the refusal, failing the test when the
 * installer does not refuse. The refusal is the contract: the checkout is reported with its recovery
 * instead of being rewritten.
 */
function refusalMessage(directory: string, patches: Parameters<typeof applyRuntimePatches>[1]): string {
  try {
    applyRuntimePatches(directory, patches, ['src'])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('Expected the installer to refuse this checkout')
}

/** A patch that turns `src/input.rs` into `patched`. */
function declaredPatch(directory: string, patched: string): { name: string; path: string; sha256: string } {
  return patchFor(directory, 'src/input.rs', readFileSync(resolve(directory, 'src/input.rs'), 'utf8'), patched)
}


describe('runtime source patches', () => {
  it('lists patches in name order and hashes their content', () => {
    const directory = scratchDirectory()
    writeFileSync(join(directory, '0002-second.patch'), 'b')
    writeFileSync(join(directory, '0001-first.patch'), 'a')
    writeFileSync(join(directory, 'notes.txt'), 'ignored')
    const patches = listRuntimePatches(directory)
    expect(patches.map((patch) => patch.name)).toEqual(['0001-first.patch', '0002-second.patch'])
    expect(patches[0]?.sha256).toMatch(/^[f0-9a-f]{64}$/u)
    expect(listRuntimePatches(join(directory, 'missing'))).toEqual([])
  })

  it('changes the patch-set identity when a patch changes', () => {
    const directory = scratchDirectory()
    writeFileSync(join(directory, '0001-first.patch'), 'a')
    const before = runtimePatchFingerprint(listRuntimePatches(directory))
    writeFileSync(join(directory, '0001-first.patch'), 'a changed')
    expect(runtimePatchFingerprint(listRuntimePatches(directory))).not.toBe(before)
  })

  it('applies a patch once and stays idempotent', () => {
    const directory = scratchRepository()
    const patch = declaredPatch(directory, 'patched')
    applyRuntimePatches(directory, [patch], ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('patched\n')
    applyRuntimePatches(directory, [patch], ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('patched\n')
  })

  it('refuses source no declared patch explains', () => {
    const directory = scratchRepository()
    const patch = declaredPatch(directory, 'patched')
    applyRuntimePatches(directory, [patch], ['src'])
    // A file that no patch describes is exactly the unrecorded change the old stamp hid behind a list of
    // filenames: the pinned revision plus the declared patches is not what this checkout would build.
    writeFileSync(resolve(directory, 'src/extra.rs'), 'undeclared\n')
    expect(() => applyRuntimePatches(directory, [patch], ['src'])).toThrow(/Undeclared runtime source changes/u)
  })

  it('refuses a checkout its patches do not match, without rewriting the files', () => {
    const directory = scratchRepository()
    const patch = declaredPatch(directory, 'patched')
    applyRuntimePatches(directory, [patch], ['src'])
    // Anything else in a file a patch happens to touch cannot be told apart from an older revision of that
    // patch, so the installer reports the checkout instead of resetting it: the edit here survives, and the
    // message names the recovery.
    writeFileSync(resolve(directory, 'src/input.rs'), 'patched\nand something else\n')
    const message = refusalMessage(directory, [patch])
    expect(message).toContain('0001-declared.patch does not apply in')
    expect(message).toContain(`Recovery: remove ${directory}`)
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('patched\nand something else\n')
  })

  it('rolls back a patch this run applied when the declared-source check refuses the checkout', () => {
    const directory = scratchRepository()
    // The patch itself fits, so it is applied before the final check runs - and the final check refuses the
    // checkout because of a file no patch declares. That refusal is part of applying the set, so the patch
    // this run applied is reversed rather than left behind in a half-patched checkout.
    writeFileSync(resolve(directory, 'src/extra.rs'), 'undeclared\n')
    const message = refusalMessage(directory, [declaredPatch(directory, 'patched')])
    expect(message).toContain('Undeclared runtime source changes')
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('initial\n')
  })

  it('leaves the checkout unchanged when a later patch of the set refuses', () => {
    const directory = scratchRepository()
    writeFileSync(resolve(directory, 'src/other.rs'), 'initial\n')
    commitAll(directory, 'second file')
    const first = patchLines('0001-first.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      '--- a/src/input.rs',
      '+++ b/src/input.rs',
      '@@ -1 +1 @@',
      '-initial',
      '+first applied',
    ])
    const second = patchLines('0002-second.patch', [
      'diff --git a/src/other.rs b/src/other.rs',
      '--- a/src/other.rs',
      '+++ b/src/other.rs',
      '@@ -1 +1 @@',
      '-expected',
      '+second applied',
    ])
    // The set is one unit: the first patch is rolled back, so the refusal leaves the checkout exactly as
    // this run found it instead of half-patched.
    const message = refusalMessage(directory, [first, second])
    expect(message).toContain('0002-second.patch does not apply in')
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('initial\n')
    expect(readFileSync(resolve(directory, 'src/other.rs'), 'utf8')).toBe('initial\n')
    // The rolled-back state is applicable again, which is what makes a retry meaningful.
    applyRuntimePatches(directory, [first], ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('first applied\n')
  })

  it('refuses a patch that deletes a file whose content the patch does not describe', () => {
    const directory = scratchRepository()
    applyRuntimePatches(directory, [patchLines('0001-set-older.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      '--- a/src/input.rs',
      '+++ b/src/input.rs',
      '@@ -1 +1 @@',
      '-initial',
      '+older',
    ])], ['src'])
    // The deletion describes 'current' but the file holds 'older'. The file is reported, not removed: a
    // reset that deletes first would discard content the patch never described.
    const deletion = patchLines('0002-delete.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      'deleted file mode 100644',
      '--- a/src/input.rs',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-current',
    ])
    expect(refusalMessage(directory, [deletion])).toContain('0002-delete.patch does not apply in')
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('older\n')
  })

  it('fingerprints working-tree bytes, not the index state', () => {
    const directory = scratchRepository()
    const committed = sourceFingerprint(directory, ['src'])
    // Staging must not change the identity: the build reads the working tree either way.
    writeFileSync(resolve(directory, 'src/input.rs'), 'unstaged\n')
    const unstaged = sourceFingerprint(directory, ['src'])
    git(directory, ['add', 'src/input.rs'])
    expect(sourceFingerprint(directory, ['src'])).toBe(unstaged)
    expect(unstaged).not.toBe(committed)
    // An untracked file that the build would consume is part of the identity too.
    writeFileSync(resolve(directory, 'src/extra.rs'), 'untracked\n')
    expect(sourceFingerprint(directory, ['src'])).not.toBe(unstaged)
  })

  it('covers the nested GPUI checkout as well as the runtime', () => {
    const directory = scratchRepository()
    const nested = resolve(directory, 'zed')
    mkdirSync(resolve(nested, 'crates'), { recursive: true })
    writeFileSync(resolve(nested, 'crates/lib.rs'), 'gpui\n')
    git(nested, ['init', '--quiet'])
    git(nested, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '-A'])
    git(nested, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'initial'])
    const before = runtimeSourceFingerprint(directory, ['src'])
    writeFileSync(resolve(nested, 'crates/lib.rs'), 'gpui changed\n')
    expect(runtimeSourceFingerprint(directory, ['src'])).not.toBe(before)
  })

  it('re-applies a two-patch set that touches one file without refusing the checkout', () => {
    const directory = scratchRepository('initial\n')
    const first = declaredPatch(directory, 'first\n')
    // The second patch continues from the first one's result, so it cannot be checked against the pin
    // on its own: only the set describes the checkout.
    const second = patchLines('0002-second.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      '--- a/src/input.rs',
      '+++ b/src/input.rs',
      '@@ -1 +1 @@',
      '-first',
      '+second',
    ])
    const set = [first, second]
    applyRuntimePatches(directory, set, ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('second\n')
    // A later run finds the set already applied: it must neither refuse nor apply it twice.
    applyRuntimePatches(directory, set, ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('second\n')
  })

  it('still refuses a checkout the set does not fit', () => {
    const directory = scratchRepository('initial\n')
    const set = [declaredPatch(directory, 'first\n'), patchLines('0002-second.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      '--- a/src/input.rs',
      '+++ b/src/input.rs',
      '@@ -1 +1 @@',
      '-not-first',
      '+second',
    ])]
    expect(refusalMessage(directory, set)).toContain('does not apply')
    // The refusal leaves the checkout as it was found.
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('initial\n')
  })

  it('ships one declared patch set per repository of the pinned checkout', () => {
    const expected = [
      {
        directory: 'gpuix',
        files: [{ name: '0001-linux-native-runtime.patch', targets: [
          'packages/native/src/custom_elements/input.rs',
          'packages/native/src/element_tree.rs',
          'packages/native/src/lib.rs',
          'packages/native/src/portal_file_chooser.rs',
          'packages/native/src/renderer.rs',
          'packages/native/src/system_appearance.rs',
          'packages/native/src/text/paint.rs',
          'packages/react/src/reconciler/host-config.ts',
          'packages/react/src/types/host.ts',
        ] }],
      },
      {
        directory: 'zed',
        files: [
          { name: '0001-portal-parent-and-appearance.patch', targets: [
          'crates/gpui/src/platform.rs',
          'crates/gpui/src/window.rs',
          'crates/gpui_linux/src/gpui_linux.rs',
          'crates/gpui_linux/src/linux/wayland/window.rs',
          'crates/gpui_linux/src/linux/x11/window.rs',
          'crates/gpui_linux/src/portal_file_chooser.rs',
          'crates/gpui_linux/src/system_appearance.rs',
          'crates/gpui_platform/src/gpui_platform.rs',
          ] },
          // The runtime's FileChooser call is corrected by its own patch, so re-importing the
          // primitive cannot silently bring the two-argument call back.
          { name: '0002-portal-open-file-signature.patch', targets: ['crates/gpui_linux/src/portal_file_chooser.rs'] },
        ],
      },
    ] as const
    for (const set of expected) {
      const patches = listRuntimePatches(resolve(import.meta.dir, '../patches', set.directory))
      expect(patches.map((patch) => patch.name)).toEqual(set.files.map((file) => file.name))
      for (const file of set.files) {
        const patch = patches.find((candidate) => candidate.name === file.name)!
        const text = readFileSync(patch.path, 'utf8')
        for (const target of file.targets) expect(text).toContain(`+++ b/${target}`)
      }
    }
  })

  it('rebuilds the pinned sources from the declared patches alone', () => {
    const source = pinnedSourceDirectory()
    if (!existsSync(source)) return
    // A clean clone is what a fresh machine has: the pinned revision with nothing else. Applying every
    // declared patch there has to succeed, or the runtime is only reproducible on this checkout.
    const scratch = scratchDirectory()
    for (const [setName, repository] of [['gpuix', source], ['zed', resolve(source, 'zed')]] as const) {
      if (!existsSync(resolve(repository, '.git'))) continue
      const clone = resolve(scratch, setName)
      git(scratch, ['clone', '--quiet', '--shared', repository, clone])
      for (const patch of listRuntimePatches(resolve(import.meta.dir, '../patches', setName))) {
        expect([setName, patch.name, gitCheck(clone, ['apply', '--check', patch.path])]).toEqual([setName, patch.name, 0])
        git(clone, ['apply', patch.path])
      }
    }
  })

  it('names the cache when a checkout carries an older revision of a declared patch', () => {
    // CI and a developer machine both reuse the native cache across patch edits, so the checkout can hold the
    // previous revision of the same patch. That is reported with its recovery - the cache is a derived
    // directory, and rewriting it would also rewrite a hand edit that looks identical.
    const directory = scratchRepository()
    const older = patchFor(directory, 'src/input.rs', 'initial\n', 'older revision')
    applyRuntimePatches(directory, [older], ['src'])
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('older revision\n')

    const current = patchFor(directory, 'src/input.rs', 'initial\n', 'current revision')
    expect(() => applyRuntimePatches(directory, [current], ['src'])).toThrow(new RegExp(`${directory}.*Recovery: remove ${directory}`, 'su'))
    expect(readFileSync(resolve(directory, 'src/input.rs'), 'utf8')).toBe('older revision\n')
  })

  it('stays idempotent for a patch that adds a file', () => {
    const directory = scratchRepository()
    const patch = patchLines('0001-extra.patch', [
      'diff --git a/src/extra.rs b/src/extra.rs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/extra.rs',
      '@@ -0,0 +1 @@',
      '+telemetry',
    ])
    applyRuntimePatches(directory, [patch], ['src'])
    expect(readFileSync(resolve(directory, 'src/extra.rs'), 'utf8')).toBe('telemetry\n')
    // The second run finds the file present and the patch already applied: no reset, no error.
    applyRuntimePatches(directory, [patch], ['src'])
    expect(readFileSync(resolve(directory, 'src/extra.rs'), 'utf8')).toBe('telemetry\n')
  })

  it('stays idempotent for a patch that deletes a file', () => {
    const directory = scratchRepository()
    const patch = patchLines('0001-remove.patch', [
      'diff --git a/src/input.rs b/src/input.rs',
      'deleted file mode 100644',
      '--- a/src/input.rs',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-initial',
    ])
    applyRuntimePatches(directory, [patch], ['src'])
    expect(existsSync(resolve(directory, 'src/input.rs'))).toBe(false)
    applyRuntimePatches(directory, [patch], ['src'])
    expect(existsSync(resolve(directory, 'src/input.rs'))).toBe(false)
  })

  it('re-runs on a cached checkout whose nested repository already carries its own patch', () => {
    // The nested GPUI checkout is a second repository with its own patch set. Verifying it from the outer
    // set with an empty declaration failed every re-run, because the nested tree already held its patch.
    const source = scratchRepository()
    const nested = resolve(source, 'zed')
    mkdirSync(resolve(nested, 'crates'), { recursive: true })
    writeFileSync(resolve(nested, 'crates/lib.rs'), 'gpui\n')
    git(nested, ['init', '--quiet'])
    // The identity is explicit: CI has no global Git identity, and a bare `git commit` fails there.
    commitAll(nested)
    applyRuntimePatches(nested, [patchFor(nested, 'crates/lib.rs', 'gpui\n', 'gpui patched')], ['.'])

    const outer = declaredPatch(source, 'patched')
    applyRuntimePatches(source, [outer], ['src'])
    // The second call is what a cached checkout does; it must not throw.
    applyRuntimePatches(source, [outer], ['src'])
    expect(readFileSync(resolve(nested, 'crates/lib.rs'), 'utf8')).toBe('gpui patched\n')
  })

  it('scopes each patch set to its own repository build inputs', () => {
    const source = scratchRepository()
    // A nested repository is what a patch set is scoped to, so the fixture needs one.
    const nested = resolve(source, 'zed', 'crates')
    mkdirSync(nested, { recursive: true })
    writeFileSync(resolve(nested, 'lib.rs'), 'gpui\n')
    git(resolve(source, 'zed'), ['init', '--quiet'])
    const sets = runtimePatchSets(source, resolve(import.meta.dir, '../patches'))
    expect(sets.map((set) => set.name)).toEqual(['gpuix', 'zed'])
    expect(sets[0]!.directory).toBe(source)
    expect(sets[1]!.directory).toBe(resolve(source, 'zed'))
    expect(sets[1]!.paths).toEqual(['.'])
  })
})

/** The pinned checkout, when this machine has the runtime cache; CI skips the integration check. */
function pinnedSourceDirectory(): string {
  const pin = JSON.parse(readFileSync(resolve(import.meta.dir, '../gpuix-runtime.json'), 'utf8')) as { gpuixRevision: string }
  return resolve(import.meta.dir, '../node_modules/.cache/heddlework-gpuix', pin.gpuixRevision)
}
