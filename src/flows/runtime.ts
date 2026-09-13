import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { WorkbenchState } from '../workbench/state.ts'
import type { QueueInputDraft } from '../workbench/queue.ts'
import { compileFlowQueue } from './compiler.ts'
import {
  createFlowId,
  initialScheduleRun,
  nextScheduleRun,
  normalizeFlowTemplate,
  type FlowLaunch,
  type FlowRuntimeSnapshot,
  type FlowSchedule,
  type FlowScheduleInput,
} from './types.ts'

export interface FlowRuntimeHost {
  subscribe(listener: () => void): () => void
  getSnapshot(): WorkbenchState
  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options?: { start?: boolean }): void
  hasQueuedFlow(runId: string): boolean
  notify(kind: 'info' | 'warning' | 'error', message: string): void
}

export interface FlowRuntimeOptions {
  path?: string | false | undefined
  now?: (() => number) | undefined
  createId?: ((prefix: 'HW' | 'SCH', now: number) => string) | undefined
  tickIntervalMs?: number | undefined
}

interface FlowRuntimeDocument {
  version: 1
  schedules: FlowSchedule[]
  pending: FlowLaunch[]
}

export class FlowRuntime {
  readonly #host: FlowRuntimeHost
  readonly #path: string | false
  readonly #now: () => number
  readonly #createId: (prefix: 'HW' | 'SCH', now: number) => string
  readonly #tickIntervalMs: number
  readonly #listeners = new Set<() => void>()
  readonly #document: FlowRuntimeDocument
  #snapshot: FlowRuntimeSnapshot
  #timer: ReturnType<typeof setInterval> | undefined
  #unsubscribeHost: (() => void) | undefined
  #flushing = false

  constructor(host: FlowRuntimeHost, options: FlowRuntimeOptions = {}) {
    this.#host = host
    this.#path = options.path === undefined ? flowRuntimePath() : options.path
    this.#now = options.now ?? (() => Date.now())
    this.#createId = options.createId ?? createFlowId
    this.#tickIntervalMs = options.tickIntervalMs ?? 1_000
    this.#document = readRuntimeDocument(this.#path)
    this.#snapshot = snapshotFrom(this.#document)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): FlowRuntimeSnapshot => this.#snapshot

  start(): void {
    if (this.#timer) return
    this.#unsubscribeHost = this.#host.subscribe(() => { void this.flushPending() })
    this.#timer = setInterval(() => { void this.tick() }, this.#tickIntervalMs)
    this.#timer.unref?.()
    void this.tick()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#unsubscribeHost?.()
    this.#unsubscribeHost = undefined
    this.#listeners.clear()
  }

  createSchedule(input: FlowScheduleInput): FlowSchedule {
    const now = this.#now()
    const template = normalizeFlowTemplate(input)
    const schedule: FlowSchedule = {
      ...template,
      id: this.#createId('SCH', now),
      timing: input.timing,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      ...(input.enabled === false ? {} : { nextRunAt: initialScheduleRun(input.timing, now) }),
    }
    if (schedule.enabled && schedule.nextRunAt === undefined) throw new Error('The schedule must run in the future')
    this.#document.schedules.push(schedule)
    this.#commit()
    return schedule
  }

  setScheduleEnabled(id: string, enabled: boolean): void {
    const schedule = this.#document.schedules.find((candidate) => candidate.id === id)
    if (!schedule || schedule.enabled === enabled) return
    const now = this.#now()
    const nextRunAt = enabled ? initialScheduleRun(schedule.timing, now) : undefined
    if (enabled && nextRunAt === undefined) throw new Error('This one-time schedule is already in the past')
    schedule.enabled = enabled
    schedule.updatedAt = now
    schedule.nextRunAt = nextRunAt
    this.#commit()
  }

  removeSchedule(id: string): void {
    const next = this.#document.schedules.filter((schedule) => schedule.id !== id)
    if (next.length === this.#document.schedules.length) return
    this.#document.schedules = next
    this.#document.pending = this.#document.pending.filter((launch) => launch.scheduleId !== id)
    this.#commit()
  }

  runScheduleNow(id: string): FlowLaunch | undefined {
    const schedule = this.#document.schedules.find((candidate) => candidate.id === id)
    if (!schedule) return undefined
    const now = this.#now()
    const launch = this.#launchFromSchedule(schedule, now)
    schedule.lastRunAt = now
    schedule.updatedAt = now
    this.#document.pending.push(launch)
    this.#commit()
    void this.flushPending()
    return launch
  }

  async tick(now = this.#now()): Promise<void> {
    let changed = false
    for (const schedule of this.#document.schedules) {
      if (!schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      const dueAt = schedule.nextRunAt
      const launch = this.#launchFromSchedule(schedule, dueAt)
      if (!this.#document.pending.some((candidate) => candidate.id === launch.id)) this.#document.pending.push(launch)
      schedule.lastRunAt = dueAt
      schedule.updatedAt = now
      schedule.nextRunAt = nextScheduleRun(schedule.timing, now)
      if (schedule.nextRunAt === undefined) schedule.enabled = false
      changed = true
    }
    if (changed) this.#commit()
    await this.flushPending()
  }

  async flushPending(): Promise<void> {
    if (this.#flushing || this.#document.pending.length === 0) return
    const state = this.#host.getSnapshot()
    if (state.connection !== 'connected') return
    this.#flushing = true
    try {
      let changed = false
      for (const launch of [...this.#document.pending]) {
        if (resolve(launch.workspacePath) !== resolve(this.#host.getSnapshot().workspacePath)) continue
        if (!this.#host.hasQueuedFlow(launch.id)) this.#host.enqueueQueueInputs(compileFlowQueue(launch), { start: true })
        this.#document.pending = this.#document.pending.filter((candidate) => candidate.id !== launch.id)
        this.#host.notify('info', `Scheduled flow ${launch.id} queued`)
        changed = true
      }
      if (changed) this.#commit()
    } catch (error) {
      this.#snapshot = { ...snapshotFrom(this.#document), lastError: error instanceof Error ? error.message : String(error) }
      this.#emit()
    } finally {
      this.#flushing = false
    }
  }

  #launchFromSchedule(schedule: FlowSchedule, now: number): FlowLaunch {
    return {
      id: this.#createId('HW', now),
      title: schedule.title,
      prompts: [...schedule.prompts],
      mode: schedule.mode,
      ...(schedule.model ? { model: schedule.model } : {}),
      workspacePath: schedule.workspacePath,
      source: 'scheduled',
      scheduleId: schedule.id,
      createdAt: now,
    }
  }

  #commit(): void {
    writeRuntimeDocument(this.#path, this.#document)
    this.#snapshot = snapshotFrom(this.#document)
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function flowRuntimePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'flows.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'flows.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'flows.json')
}

function snapshotFrom(document: FlowRuntimeDocument): FlowRuntimeSnapshot {
  return {
    schedules: document.schedules.map((schedule) => ({ ...schedule, prompts: [...schedule.prompts] })).toSorted((left, right) => (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER)),
    pending: document.pending.map((launch) => ({ ...launch, prompts: [...launch.prompts] })),
  }
}

function readRuntimeDocument(path: string | false): FlowRuntimeDocument {
  if (!path) return { version: 1, schedules: [], pending: [] }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; schedules?: unknown; pending?: unknown }
    return {
      version: 1,
      schedules: Array.isArray(value.schedules) ? value.schedules.filter(isFlowSchedule) : [],
      pending: Array.isArray(value.pending) ? value.pending.filter(isFlowLaunch) : [],
    }
  } catch {
    return { version: 1, schedules: [], pending: [] }
  }
}

function writeRuntimeDocument(path: string | false, document: FlowRuntimeDocument): void {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function isFlowLaunch(value: unknown): value is FlowLaunch {
  if (!value || typeof value !== 'object') return false
  const launch = value as Record<string, unknown>
  return typeof launch.id === 'string' && typeof launch.title === 'string' && Array.isArray(launch.prompts) && launch.prompts.every((prompt) => typeof prompt === 'string') && (launch.mode === 'sequential' || launch.mode === 'parallel') && (launch.source === 'manual' || launch.source === 'scheduled') && typeof launch.workspacePath === 'string' && typeof launch.createdAt === 'number'
}

function isFlowSchedule(value: unknown): value is FlowSchedule {
  if (!value || typeof value !== 'object') return false
  const schedule = value as Record<string, unknown>
  return typeof schedule.id === 'string' && typeof schedule.title === 'string' && Array.isArray(schedule.prompts) && schedule.prompts.every((prompt) => typeof prompt === 'string') && (schedule.mode === 'sequential' || schedule.mode === 'parallel') && typeof schedule.workspacePath === 'string' && typeof schedule.enabled === 'boolean' && typeof schedule.createdAt === 'number' && typeof schedule.updatedAt === 'number' && Boolean(schedule.timing) && typeof schedule.timing === 'object'
}
