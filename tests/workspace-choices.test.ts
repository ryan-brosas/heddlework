import { describe, expect, it } from 'bun:test'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { ALL_PROJECTS_SCOPE, projectChoices, workspaceChoices } from '../src/ui/workspace-choices.ts'

function session(id: string, cwd: string, messageCount = 1): PiSessionSummary {
  return { id, path: `/sessions/${id}.jsonl`, cwd, title: id, firstMessage: '', messageCount, createdAt: 1, modifiedAt: 1 }
}

describe('project choices', () => {
  it('lists the current workspace before it has any session, so a freshly added folder is a project', () => {
    expect(projectChoices({ workspacePath: '/tmp/brand-new-project', sessions: [] })).toEqual([
      { value: ALL_PROJECTS_SCOPE, label: 'All projects' },
      { value: '/tmp/brand-new-project', label: 'brand-new-project' },
    ])
  })

  it('keeps a blank session project listed next to projects that already have messages', () => {
    const choices = projectChoices({
      workspacePath: '/tmp/blank-project',
      sessions: [session('blank', '/tmp/blank-project', 0), session('other', '/tmp/other-project')],
    })
    expect(choices.map((choice) => choice.value)).toEqual([ALL_PROJECTS_SCOPE, '/tmp/blank-project', '/tmp/other-project'])
  })

  it('deduplicates by resolved path and keeps the current workspace first', () => {
    const choices = workspaceChoices({
      workspacePath: '/tmp/current-project',
      sessions: [session('other-a', '/tmp/other-project'), session('current', '/tmp/current-project'), session('other-b', '/tmp/other-project/.')],
    })
    expect(choices).toEqual([
      { path: '/tmp/current-project', name: 'current-project', current: true },
      { path: '/tmp/other-project', name: 'other-project', current: false },
    ])
  })
})
