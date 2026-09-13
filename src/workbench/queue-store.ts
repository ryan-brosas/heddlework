import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { restoreQueueState, serializeQueueState, type WorkbenchQueueState } from './queue.ts'

export interface QueueStoreService {
  load(workspacePath: string): WorkbenchQueueState
  save(workspacePath: string, queue: WorkbenchQueueState): void
}

interface QueueStoreDocument {
  version: 1
  workspaces: Record<string, unknown>
}

export class FileQueueStore implements QueueStoreService {
  readonly #path: string | false
  readonly #document: QueueStoreDocument

  constructor(path: string | false = queueStorePath()) {
    this.#path = path
    this.#document = readDocument(path)
  }

  load(workspacePath: string): WorkbenchQueueState {
    return restoreQueueState(this.#document.workspaces[resolve(workspacePath)])
  }

  save(workspacePath: string, queue: WorkbenchQueueState): void {
    if (!this.#path) return
    this.#document.workspaces[resolve(workspacePath)] = serializeQueueState(queue)
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.#document, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#path)
    } catch {
      // Queue execution continues in memory if local persistence is unavailable.
    }
  }
}

export function queueStorePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'queue.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'queue.json')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'queue.json')
}

function readDocument(path: string | false): QueueStoreDocument {
  if (!path) return { version: 1, workspaces: {} }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; workspaces?: unknown }
    return value.version === 1 && value.workspaces && typeof value.workspaces === 'object' && !Array.isArray(value.workspaces)
      ? { version: 1, workspaces: value.workspaces as Record<string, unknown> }
      : { version: 1, workspaces: {} }
  } catch {
    return { version: 1, workspaces: {} }
  }
}

