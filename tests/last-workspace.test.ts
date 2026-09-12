import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastWorkspacePath, persistLastWorkspace } from '../src/workbench/last-workspace.ts'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('last workspace persistence', () => {
  it('no-ops off Linux so other platforms keep their launch cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-workspace-'))
    fixtures.push(root)
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = root
    try {
      await persistLastWorkspace('/tmp/project', 'darwin')
      const file = lastWorkspacePath('linux', process.env)
      await expect(readFile(file, 'utf8')).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })

  it('writes a one-line directory for the Linux desktop launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-workspace-'))
    fixtures.push(root)
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = root
    try {
      await persistLastWorkspace('/tmp/project', 'linux')
      const file = lastWorkspacePath('linux', process.env)
      expect(await readFile(file, 'utf8')).toBe('/tmp/project\n')
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })
})
