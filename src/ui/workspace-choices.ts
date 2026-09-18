import { basename, resolve } from 'node:path'
import type { WorkbenchState } from '../workbench/state.ts'

/** Selection value for every project, as opposed to one folder path. */
export const ALL_PROJECTS_SCOPE = '__all-projects__'

/**
 * The folder filter is user-owned: browsing starts on every project and only a pick moves it.
 * Opening a session from another folder changes the workspace, never this selection.
 */
export function resolveProjectScope(selected: string, options: readonly { value: string }[]): string {
  return options.some((option) => option.value === selected) ? selected : ALL_PROJECTS_SCOPE
}

export interface WorkspaceChoice {
  path: string
  name: string
  current: boolean
}

/**
 * Every folder the app can open, deduplicated by resolved path with the current workspace first.
 *
 * The workspace itself counts even before it has a session - an empty folder is exactly what
 * "New project" produces - so this projection cannot be derived from persisted sessions alone.
 */
export function workspaceChoices(state: Pick<WorkbenchState, 'workspacePath' | 'sessions'>): WorkspaceChoice[] {
  const currentPath = resolve(state.workspacePath)
  const paths = new Map<string, string>([[currentPath, basename(currentPath) || currentPath]])
  for (const session of state.sessions) {
    const path = resolve(session.cwd)
    if (!paths.has(path)) paths.set(path, basename(path) || path)
  }
  return [...paths].map(([path, name]) => ({ path, name, current: path === currentPath })).sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

/**
 * The project filter's options: every project, including the current workspace before its first
 * message, plus the "All projects" selection. Both pickers read projects through this function.
 */
export function projectChoices(state: Pick<WorkbenchState, 'workspacePath' | 'sessions'>): Array<{ value: string; label: string }> {
  return [
    { value: ALL_PROJECTS_SCOPE, label: 'All projects' },
    ...workspaceChoices(state).map((choice) => ({ value: choice.path, label: choice.name })),
  ]
}
