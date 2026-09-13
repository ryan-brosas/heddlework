import { describe, expect, it } from 'bun:test'
import { ALL_PROJECTS_SCOPE, resolveProjectScope } from '../src/ui/sidebar.tsx'

const projects = [
  { value: ALL_PROJECTS_SCOPE },
  { value: '/tmp/project-one' },
  { value: '/tmp/project-two' },
]

describe('sidebar project scope', () => {
  it('keeps the selected scope while its project still exists', () => {
    expect(resolveProjectScope(ALL_PROJECTS_SCOPE, projects)).toBe(ALL_PROJECTS_SCOPE)
    expect(resolveProjectScope('/tmp/project-two', projects)).toBe('/tmp/project-two')
  })

  it('falls back to All projects only when the selected project is gone', () => {
    expect(resolveProjectScope('/tmp/project-gone', projects)).toBe(ALL_PROJECTS_SCOPE)
  })

  it('starts at All projects and never lets the active session move the filter', async () => {
    const sidebar = await Bun.file(new URL('../src/ui/sidebar.tsx', import.meta.url)).text()
    // The original design: browsing defaults to every project in the list.
    expect(sidebar).toContain('useState(ALL_PROJECTS_SCOPE)')
    expect(sidebar).toContain('onChange={setProjectScope}')
    // Choosing a session changes state.workspacePath. The only thing allowed to write the
    // filter is a missing option, so an active session can never move it.
    const scopeWrites = sidebar.slice(sidebar.indexOf('setProjectScope'), sidebar.indexOf('const matchingSessions'))
    expect(scopeWrites).toContain('resolveProjectScope')
    expect(scopeWrites).not.toContain('workspacePath')
    expect(sidebar).not.toContain('useState(() => resolve(state.workspacePath))')
    expect(sidebar).not.toContain('projectScopePinned')
    expect(sidebar).not.toContain('onChange={selectProjectScope}')
  })
})
