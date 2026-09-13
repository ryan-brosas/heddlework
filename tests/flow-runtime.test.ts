import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowRuntime, type FlowRuntimeHost } from '../src/flows/runtime.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import { queueHasFlow, type QueueInputDraft } from '../src/workbench/queue.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

class RuntimeHost implements FlowRuntimeHost {
  state: WorkbenchState
  readonly notifications: string[] = []
  readonly listeners = new Set<() => void>()
  #next = 0

  constructor(workspacePath = '/tmp/flows-runtime') {
    this.state = { ...createInitialState(workspacePath), connection: 'connected' }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot(): WorkbenchState { return this.state }
  hasQueuedFlow(runId: string): boolean { return queueHasFlow(this.state.queue.items, runId) }
  notify(_kind: 'info' | 'warning' | 'error', message: string): void { this.notifications.push(message) }
  enqueueQueueInputs(inputs: readonly QueueInputDraft[]): void {
    this.state = {
      ...this.state,
      queue: {
        ...this.state.queue,
        items: [...this.state.queue.items, ...inputs.map((input, index) => ({
          id: `row-${++this.#next}`,
          text: input.text,
          images: [],
          createdAt: index,
          ...(input.lane ? { lane: input.lane } : {}),
          ...(input.flow ? { flow: input.flow } : {}),
        }))],
      },
    }
    for (const listener of this.listeners) listener()
  }
}

describe('FlowRuntime', () => {
  it('persists schedule intent and enqueues a due occurrence through queue primitives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-flow-runtime-'))
    roots.push(root)
    const path = join(root, 'flows.json')
    const host = new RuntimeHost()
    let now = 1_000
    let sequence = 0
    const createId = (prefix: 'HW' | 'SCH') => `${prefix}-TEST${++sequence}`
    const runtime = new FlowRuntime(host, { path, now: () => now, createId })
    const schedule = runtime.createSchedule({
      title: 'Nightly audit',
      prompts: ['Audit the workspace'],
      mode: 'parallel',
      model: 'provider/model',
      workspacePath: host.state.workspacePath,
      timing: { kind: 'once', at: 2_000 },
    })
    expect(schedule.nextRunAt).toBe(2_000)
    await runtime.tick(1_999)
    expect(host.state.queue.items).toEqual([])

    now = 2_000
    await runtime.tick()
    expect(host.state.queue.items.map((item) => item.text).slice(0, 3)).toEqual([
      '/new',
      '/model provider/model',
      expect.stringContaining(`Scheduled ${schedule.id}@HW-TEST2/1:1`),
    ])
    expect(host.state.queue.items.at(-1)?.text).toContain('workflow.parallel')
    expect(runtime.getSnapshot().schedules[0]).toMatchObject({ enabled: false, lastRunAt: 2_000 })
    expect(runtime.getSnapshot().pending).toEqual([])
    expect(host.notifications).toEqual(['Scheduled flow HW-TEST2 queued'])

    const restored = new FlowRuntime(new RuntimeHost(), { path, now: () => now, createId })
    expect(restored.getSnapshot().schedules[0]).toMatchObject({ id: schedule.id, title: 'Nightly audit', enabled: false })
  })

  it('holds a due job durably until its workspace runtime is active', async () => {
    const host = new RuntimeHost('/tmp/current-project')
    let sequence = 0
    const runtime = new FlowRuntime(host, { path: false, now: () => 10_000, createId: (prefix) => `${prefix}-${++sequence}` })
    runtime.createSchedule({
      title: 'Other workspace',
      prompts: ['Run elsewhere'],
      mode: 'sequential',
      workspacePath: '/tmp/other-project',
      timing: { kind: 'once', at: 10_001 },
    })
    await runtime.tick(10_001)
    expect(host.state.queue.items).toEqual([])
    expect(runtime.getSnapshot().pending).toHaveLength(1)

    host.state = { ...host.state, workspacePath: '/tmp/other-project' }
    await runtime.flushPending()
    expect(runtime.getSnapshot().pending).toEqual([])
    expect(host.state.queue.items.map((item) => item.text)).toContain('Run elsewhere')
  })
})
