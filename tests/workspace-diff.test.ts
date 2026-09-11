import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspaceDiff } from '../src/workspace/git-diff.ts'
import type { WorkspaceDiff } from '../src/workbench/state.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('loadWorkspaceDiff', () => {
  it('loads tracked and untracked working tree patches without a shell', async () => {
    expectFixtureDiff(await loadWorkspaceDiff(await createFixture()))
  })

  // git applies the developer's own diff.* configuration to every invocation, and both of
  // these settings change or drop the a/ and b/ prefixes the patch parser reads. The loader
  // must pin the prefixes rather than inherit whatever the invoking machine configured.
  for (const [key, value] of [
    ['diff.mnemonicprefix', 'true'],
    ['diff.noprefix', 'true'],
  ] as const) {
    it(`reads file paths while ${key}=${value} is set`, async () => {
      expectFixtureDiff(await loadWorkspaceDiff(await createFixture([[key, value]])))
    })
  }
})

async function createFixture(config: readonly (readonly [string, string])[] = []): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'heddlework-diff-'))
  directories.push(directory)
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'README.md'), '# Fixture\n')
  await run(directory, ['git', 'init', '-q'])
  for (const [key, value] of config) await run(directory, ['git', 'config', key, value])
  await run(directory, ['git', 'add', '.'])
  await run(directory, ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'test: seed fixture'])
  await run(directory, ['git', 'branch', '-M', 'main'])
  writeFileSync(join(directory, 'README.md'), '# Fixture\n\nUpdated.\n')
  writeFileSync(join(directory, 'src', 'new.ts'), 'export const ready = true\n')
  return directory
}

function expectFixtureDiff(diff: WorkspaceDiff): void {
  expect(diff.status).toBe('ready')
  expect(diff.branch).toBe('main')
  expect(diff.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/new.ts'])
  expect(diff.additions).toBeGreaterThanOrEqual(3)
  expect(diff.deletions).toBe(0)
  expect(diff.files.find((file) => file.path === 'src/new.ts')?.patch).toContain('export const ready')
}

async function run(cwd: string, command: string[]): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited])
  if (exitCode !== 0) throw new Error(stderr)
}
