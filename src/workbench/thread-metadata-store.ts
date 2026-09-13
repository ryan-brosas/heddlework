import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ThreadLifecycle, ThreadPriority } from './state.ts'

export interface ThreadMetadataStoreService {
  load(): Record<string, ThreadLifecycle>
  save(threads: Record<string, ThreadLifecycle>): void
}

interface ThreadMetadataDocument {
  version: 1
  threads: Record<string, ThreadLifecycle>
}

export class FileThreadMetadataStore implements ThreadMetadataStoreService {
  readonly #path: string | false
  #threads: Record<string, ThreadLifecycle>

  constructor(path: string | false = threadMetadataStorePath()) {
    this.#path = path
    this.#threads = readDocument(path).threads
  }

  load(): Record<string, ThreadLifecycle> {
    return structuredClone(this.#threads)
  }

  save(threads: Record<string, ThreadLifecycle>): void {
    this.#threads = restoreThreadMetadata(threads)
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, threads: this.#threads }, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#path)
    } catch {
      // Projection preferences remain usable in memory when local persistence is unavailable.
    }
  }
}

export function threadMetadataStorePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'threads.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'threads.json')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'threads.json')
}

export function normalizeThreadLabels(labels: readonly string[]): string[] {
  const normalized = new Map<string, string>()
  for (const value of labels) {
    const label = value.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!label) continue
    const key = label.toLowerCase()
    if (!normalized.has(key)) normalized.set(key, label)
    if (normalized.size === 12) break
  }
  return [...normalized.values()]
}

export function restoreThreadMetadata(value: unknown): Record<string, ThreadLifecycle> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const restored: Record<string, ThreadLifecycle> = {}
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const source = candidate as Record<string, unknown>
    const thread: ThreadLifecycle = {}
    const settledAt = finiteNumber(source.settledAt)
    const snoozedUntil = finiteNumber(source.snoozedUntil)
    const unsettledAt = finiteNumber(source.unsettledAt)
    const readAt = finiteNumber(source.readAt)
    const priority = threadPriority(source.priority)
    const labels = Array.isArray(source.labels) ? normalizeThreadLabels(source.labels.filter((label): label is string => typeof label === 'string')) : []
    if (settledAt !== undefined) thread.settledAt = settledAt
    if (snoozedUntil !== undefined) thread.snoozedUntil = snoozedUntil
    if (unsettledAt !== undefined) thread.unsettledAt = unsettledAt
    if (readAt !== undefined) thread.readAt = readAt
    if (priority !== undefined) thread.priority = priority
    if (labels.length > 0) thread.labels = labels
    if (Object.keys(thread).length > 0) restored[key] = thread
  }
  return restored
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function threadPriority(value: unknown): ThreadPriority | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4 ? value as ThreadPriority : undefined
}

function readDocument(path: string | false): ThreadMetadataDocument {
  if (!path) return { version: 1, threads: {} }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; threads?: unknown }
    return value.version === 1 ? { version: 1, threads: restoreThreadMetadata(value.threads) } : { version: 1, threads: {} }
  } catch {
    return { version: 1, threads: {} }
  }
}