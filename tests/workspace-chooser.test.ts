import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { workspaceChoices } from '../src/ui/workspace-choices.ts'

function session(id: string, cwd: string): PiSessionSummary {
  return { id, path: `/sessions/${id}.jsonl`, cwd, title: id, firstMessage: '', messageCount: 1, createdAt: 1, modifiedAt: 1 }
}

describe('workspace choices', () => {
  it('keeps the current workspace first and deduplicates persisted project paths', () => {
    const choices = workspaceChoices({
      workspacePath: '/tmp/current-project',
      sessions: [
        session('other-a', '/tmp/other-project'),
        session('current', '/tmp/current-project'),
        session('other-b', '/tmp/other-project/.'),
        session('alpha', '/tmp/alpha-project'),
      ],
    })

    expect(choices).toEqual([
      { path: resolve('/tmp/current-project'), name: 'current-project', current: true },
      { path: resolve('/tmp/alpha-project'), name: 'alpha-project', current: false },
      { path: resolve('/tmp/other-project'), name: 'other-project', current: false },
    ])
  })
})
