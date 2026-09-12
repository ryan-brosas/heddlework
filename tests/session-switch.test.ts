import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const sessions: PiSessionSummary[] = [
  { id: 'one', path: '/tmp/one.jsonl', cwd: '/tmp/project', title: 'First thread', firstMessage: 'First', messageCount: 1, createdAt: 1, modifiedAt: 1 },
  { id: 'two', path: '/tmp/two.jsonl', cwd: '/tmp/project-two', title: 'Second thread', firstMessage: 'Second', messageCount: 1, createdAt: 2, modifiedAt: 2 },
]
const workspaceSession: PiSessionSummary = { id: 'three', path: '/tmp/three.jsonl', cwd: '/tmp/project-three', title: '(no messages)', firstMessage: '', messageCount: 0, createdAt: 3, modifiedAt: 3 }

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}

async function writePersistedSession(directory: string, id: string, prompts: readonly string[]): Promise<string> {
  const sessionPath = join(directory, `${id}.jsonl`)
  const records: Record<string, unknown>[] = [{ type: 'session', version: 3, id, timestamp: new Date(0).toISOString(), cwd: directory }]
  let parentId: string | null = null
  for (const [index, prompt] of prompts.entries()) {
    const entryId = `${id}-entry-${index}`
    records.push({ type: 'message', id: entryId, parentId, timestamp: new Date(index + 1).toISOString(), message: { role: 'user', content: prompt, timestamp: index + 1 } })
    parentId = entryId
  }
  await writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return sessionPath
}

class StaticCatalog extends PiSessionCatalog {
  override async list(): Promise<PiSessionSummary[]> {
    return sessions
  }

  override async createWorkspaceSession(cwd: string): Promise<PiSessionSummary> {
    expect(cwd).toBe('/tmp/project-three')
    return workspaceSession
  }
}

class SwitchingTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []
  readonly requests: RpcCommand[] = []
  active: PiSessionSummary
  extras: PiSessionSummary[] = []
  startCalls = 0
  #notifyDuringBootstrap = false
  #switchBarrier: Promise<void> | undefined
  #newSessionBarrier: Promise<void> | undefined
  #switchFailure: string | undefined
  #startBarrier: Promise<void> | undefined
  #startFailure: string | undefined
  #getStateBarrier: Promise<void> | undefined

  constructor(active: PiSessionSummary = sessions[0]!) {
    this.active = active
  }

  async start(): Promise<void> {
    this.startCalls += 1
    const barrier = this.#startBarrier
    this.#startBarrier = undefined
    if (barrier) await barrier
    if (this.#startFailure) {
      const message = this.#startFailure
      this.#startFailure = undefined
      throw new Error(message)
    }
    this.emitStatus({ state: 'running', pid: 1 })
  }

  holdStart(): () => void {
    let release = () => {}
    this.#startBarrier = new Promise<void>((resolve) => { release = resolve })
    return release
  }

  holdNextGetState(): () => void {
    let release = () => {}
    this.#getStateBarrier = new Promise<void>((resolve) => { release = resolve })
    return release
  }

  failStart(message: string): void { this.#startFailure = message }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  send(record: RpcRecord): void { this.sent.push(record) }
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  holdNextSwitch(): () => void {
    let release = () => {}
    this.#switchBarrier = new Promise<void>((resolve) => { release = resolve })
    return release
  }

  holdNextNewSession(): () => void {
    let release = () => {}
    this.#newSessionBarrier = new Promise<void>((resolve) => { release = resolve })
    return release
  }

  failNextSwitch(message: string): void { this.#switchFailure = message }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    this.requests.push(command)
    if (command.type === 'abort') return undefined as T
    if (command.type === 'new_session') {
      const barrier = this.#newSessionBarrier
      this.#newSessionBarrier = undefined
      if (barrier) await barrier
      return {} as T
    }
    if (command.type === 'switch_session') {
      const barrier = this.#switchBarrier
      this.#switchBarrier = undefined
      if (barrier) await barrier
      // Pi keeps the previous session when a switch fails, so active must stay put here.
      if (this.#switchFailure) {
        const message = this.#switchFailure
        this.#switchFailure = undefined
        throw new Error(message)
      }
      this.active = [...sessions, workspaceSession, ...this.extras].find((session) => session.path === command.sessionPath) ?? this.active
      this.emitEvent({ type: 'extension_ui_request', id: 'switch-wizard', method: 'notify', message: 'Session wizard' })
      this.#notifyDuringBootstrap = true
      return { cancelled: false } as T
    }
    if (command.type === 'get_state') {
      const getStateBarrier = this.#getStateBarrier
      this.#getStateBarrier = undefined
      if (getStateBarrier) await getStateBarrier
      if (this.#notifyDuringBootstrap) {
        this.#notifyDuringBootstrap = false
        this.emitEvent({ type: 'extension_ui_request', id: 'bootstrap-wizard', method: 'notify', message: 'Bootstrap wizard' })
      }
      return {
        model: null,
        thinkingLevel: 'off',
        isStreaming: false,
        sessionFile: this.active.path,
        sessionId: this.active.id,
        sessionName: this.active.title,
      } as T
    }
    if (command.type === 'get_messages') {
      const messages: PiMessage[] = this.active.messageCount > 0 ? [{ role: 'user', content: this.active.firstMessage, timestamp: this.active.modifiedAt }] : []
      return { messages } as T
    }
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { sessionFile: this.active.path, sessionId: this.active.id, totalMessages: 1 } as T
    return undefined as T
  }

  emitEvent(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }

  private emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

/** Per-session harness pool: one fake transport per session path, spawned on first open. */
function createTransportPool(initial?: { extras?: PiSessionSummary[] } | undefined) {
  const spawned = new Map<string, SwitchingTransport>()
  const prepared = new Map<string, SwitchingTransport>()
  const factory = (sessionPath: string): AgentTransport => {
    const ready = prepared.get(sessionPath) ?? spawned.get(sessionPath)
    if (ready) return ready
    const all = [...sessions, workspaceSession, ...(initial?.extras ?? [])]
    const transport = new SwitchingTransport(all.find((session) => session.path === sessionPath) ?? {
      id: sessionPath, path: sessionPath, cwd: '/tmp/unknown', title: sessionPath, firstMessage: '', messageCount: 0, createdAt: 0, modifiedAt: 0,
    })
    spawned.set(sessionPath, transport)
    return transport
  }
  return {
    spawned,
    prepared,
    factory,
    deps: () => ({ ...testControllerDependencies(new StaticCatalog()), createSessionTransport: factory }),
  }
}

class NavigatingTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly requests: RpcCommand[] = []
  treeRequests = 0
  cloneTarget: string | undefined
  sessionFile: string

  constructor(sessionFile: string, private readonly tree: unknown) {
    this.sessionFile = sessionFile
  }

  async start(): Promise<void> { this.emitStatus({ state: 'running', pid: 1 }) }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  send(): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    this.requests.push(command)
    if (command.type === 'get_tree') {
      this.treeRequests += 1
      return this.tree as T
    }
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false, sessionFile: this.sessionFile, sessionId: 'branching' } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'get_session_stats') return { sessionFile: this.sessionFile, sessionId: 'branching' } as T
    if (command.type === 'get_messages') throw new Error('NavigatingTransport requires the persisted transcript fixture')
    if ((command.type === 'clone' || command.type === 'fork') && this.cloneTarget) {
      this.sessionFile = this.cloneTarget
      return { cancelled: false } as T
    }
    if (command.type === 'navigate_tree') return { cancelled: false } as T
    if (command.type === 'switch_session') {
      this.sessionFile = String(command.sessionPath)
      return { cancelled: false } as T
    }
    return undefined as T
  }

  emitEvent(event: RpcRecord): void { for (const listener of this.events) listener(event) }

  private emitStatus(status: TransportStatus): void { for (const listener of this.statuses) listener(status) }
}

describe('clickable session switching', () => {
  it('switches to a dedicated harness and rehydrates the selected transcript', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      expect(controller.getSnapshot().sessions.map((session) => session.title)).toEqual(['First thread', 'Second thread'])
      const observedNoticeCounts: number[] = []
      const unsubscribe = controller.subscribe(() => { observedNoticeCounts.push(controller.getSnapshot().notices.length) })
      const settledRequests = transport.requests.length
      await controller.switchSession(sessions[1]!)
      unsubscribe()
      await waitFor(() => controller.getSnapshot().messages[0]?.content === 'Second')
      expect(observedNoticeCounts).not.toContain(1)
      expect(controller.getSnapshot().notices).toEqual([])
      expect(controller.getSnapshot().session.sessionId).toBe('two')
      expect(controller.getSnapshot().workspacePath).toBe('/tmp/project-two')
      expect(controller.getSnapshot().messages[0]?.content).toBe('Second')
      // The old harness was left untouched: no abort, no switch_session after the click.
      expect(transport.requests.slice(settledRequests)).toEqual([])
      expect(pool.spawned.has('/tmp/two.jsonl')).toBe(true)
    } finally {
      await controller.dispose()
    }
  })

  it('opens a blank workspace on a dedicated harness and window', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      await controller.switchWorkspace('/tmp/project-three')
      expect(transport.startCalls).toBe(1)
      expect(pool.spawned.has('/tmp/three.jsonl')).toBe(true)
      expect(controller.getSnapshot()).toMatchObject({ workspacePath: '/tmp/project-three', messages: [] })
      expect(controller.getSnapshot().session).toMatchObject({ sessionId: 'three', sessionFile: '/tmp/three.jsonl' })
    } finally {
      await controller.dispose()
    }
  })

  it('keeps an in-flight turn running on its own harness when switching threads', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      transport.emitEvent({ type: 'agent_start' })
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      const settledRequests = transport.requests.length
      await controller.switchSession(sessions[1]!)
      // The previous harness keeps its turn: the controller must not abort or switch it.
      expect(transport.requests.slice(settledRequests)).toEqual([])
      expect(controller.getSnapshot().session.sessionId).toBe('two')
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      // Events still flow only from the active harness.
      const target = pool.spawned.get('/tmp/two.jsonl')!
      target.emitEvent({ type: 'agent_start' })
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
    } finally {
      await controller.dispose()
    }
  })

  it('switches by session file when two threads share an id', async () => {
    const forked: PiSessionSummary = { id: 'one', path: '/tmp/one-fork.jsonl', cwd: '/tmp/project-fork', title: 'Forked thread', firstMessage: 'Forked', messageCount: 1, createdAt: 4, modifiedAt: 4 }
    const transport = new SwitchingTransport()
    transport.extras = [forked]
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      await controller.switchSession(forked)
      expect(pool.spawned.has('/tmp/one-fork.jsonl')).toBe(true)
      expect(controller.getSnapshot().session).toMatchObject({ sessionId: 'one', sessionFile: '/tmp/one-fork.jsonl' })
      expect(controller.getSnapshot().workspacePath).toBe('/tmp/project-fork')
    } finally {
      await controller.dispose()
    }
  })

  it('does not spawn a second harness for the already open thread', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const settledRequests = transport.requests.length
      await controller.switchSession(sessions[0]!)
      expect(pool.spawned.size).toBe(0)
      expect(transport.requests.slice(settledRequests)).toEqual([])
    } finally {
      await controller.dispose()
    }
  })

  it('tracks a background harness turn in sessionActivity', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      transport.emitEvent({ type: 'agent_start' })
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      await controller.switchSession(sessions[1]!)
      // Switching away mid-turn seeds the sidebar signal for the thread just left.
      expect(controller.getSnapshot().sessionActivity).toEqual({ '/tmp/one.jsonl': true })
      const target = pool.spawned.get('/tmp/two.jsonl')!
      // The thread just left settles in its background harness.
      transport.emitEvent({ type: 'agent_settled' })
      expect(controller.getSnapshot().sessionActivity).toEqual({ '/tmp/one.jsonl': false })
      // The active thread's turn lives on session.isStreaming, not the background map.
      target.emitEvent({ type: 'agent_start' })
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      expect(controller.getSnapshot().sessionActivity).toEqual({ '/tmp/one.jsonl': false })
      // Leaving a streaming thread seeds it; settling in the background clears it.
      await controller.switchSession(sessions[0]!)
      expect(controller.getSnapshot().sessionActivity).toEqual({ '/tmp/one.jsonl': false, '/tmp/two.jsonl': true })
      target.emitEvent({ type: 'agent_settled' })
      expect(controller.getSnapshot().sessionActivity).toEqual({ '/tmp/one.jsonl': false, '/tmp/two.jsonl': false })
    } finally {
      await controller.dispose()
    }
  })

  it('reuses the pooled harness when returning to an open thread', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      await controller.switchSession(sessions[1]!)
      const target = pool.spawned.get('/tmp/two.jsonl')!
      await controller.switchSession(sessions[0]!)
      await controller.switchSession(sessions[1]!)
      expect(pool.spawned.size).toBe(1)
      expect(target.startCalls).toBe(1)
      expect(controller.getSnapshot().session.sessionId).toBe('two')
    } finally {
      await controller.dispose()
    }
  })

  it('explains why a disconnected workbench cannot switch threads', async () => {
    const transport = new SwitchingTransport()
    const controller = new WorkbenchController(transport, '/tmp/project', testControllerDependencies(new StaticCatalog()))
    try {
      await controller.switchSession(sessions[1]!)
      expect(transport.requests).toEqual([])
      expect(controller.getSnapshot().notices.map((notice) => notice.message)).toContain('Reconnect Pi before switching sessions')
    } finally {
      await controller.dispose()
    }
  })

  it('removes stale dialogs before an asynchronous session switch can paint', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      transport.emitEvent({ type: 'extension_ui_request', id: 'stale-dialog', method: 'select', title: 'Old session action', options: ['Continue'] })
      expect(controller.getSnapshot().dialog?.id).toBe('stale-dialog')

      const target = new SwitchingTransport(sessions[1]!)
      pool.prepared.set('/tmp/two.jsonl', target)
      const release = target.holdStart()
      const observedDialogIds: Array<string | undefined> = []
      const unsubscribe = controller.subscribe(() => { observedDialogIds.push(controller.getSnapshot().dialog?.id) })
      const switching = controller.switchSession(sessions[1]!)
      try {
        expect(controller.getSnapshot().dialog).toBeUndefined()
        expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'stale-dialog', cancelled: true })

        transport.emitEvent({ type: 'extension_ui_request', id: 'transition-dialog', method: 'confirm', title: 'Transition action' })
        expect(controller.getSnapshot().dialog).toBeUndefined()
        expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'transition-dialog', cancelled: true })
      } finally {
        release()
        await switching
        unsubscribe()
      }

      expect(observedDialogIds).not.toContain('stale-dialog')
      expect(observedDialogIds).not.toContain('transition-dialog')
      expect(controller.getSnapshot().session.sessionId).toBe('two')
    } finally {
      await controller.dispose()
    }
  })

  it('paints the selected thread before the slow Pi switch finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-switch-preview-'))
    fixtures.push(directory)
    const sessionPath = await writePersistedSession(directory, 'preview', ['Previewed prompt'])
    const previewed: PiSessionSummary = { id: 'preview', path: sessionPath, cwd: directory, title: 'Previewed thread', firstMessage: 'Previewed prompt', messageCount: 1, createdAt: 1, modifiedAt: 1 }
    const transport = new SwitchingTransport()
    transport.extras = [previewed]
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(previewed)
    pool.prepared.set(sessionPath, target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = target.holdStart()
      const switching = controller.switchSession(previewed)
      try {
        // The harness is still starting, yet the persisted tail is already on screen.
        await waitFor(() => controller.getSnapshot().messages[0]?.content === 'Previewed prompt')
        expect(controller.getSnapshot().session.sessionFile).toBe(sessionPath)
        expect(controller.getSnapshot().activity).toBe('Opening thread')
      } finally {
        release()
        await switching
      }
      expect(controller.getSnapshot().session.sessionId).toBe('preview')
      expect(controller.getSnapshot().messages[0]?.content).toBe('Previewed prompt')
    } finally {
      await controller.dispose()
    }
  })

  it('does not hold the click lock while Pi parses the session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-switch-get-state-'))
    fixtures.push(directory)
    const sessionPath = await writePersistedSession(directory, 'ready', ['Ready prompt'])
    const previewed: PiSessionSummary = { id: 'ready', path: sessionPath, cwd: directory, title: 'Ready thread', firstMessage: 'Ready prompt', messageCount: 1, createdAt: 1, modifiedAt: 1 }
    const transport = new SwitchingTransport()
    transport.extras = [previewed]
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(previewed)
    pool.prepared.set(sessionPath, target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = target.holdNextGetState()
      const switching = controller.switchSession(previewed)
      await waitFor(() => controller.getSnapshot().messages[0]?.content === 'Ready prompt')
      expect(controller.getSnapshot().activity).toBe('Ready')
      // switchSession must not wait for get_state: that is Pi parsing the JSONL.
      await switching
      expect(controller.getSnapshot().session.sessionFile).toBe(sessionPath)
      release()
    } finally {
      await controller.dispose()
    }
  })

  it('opens the newest clicked thread once a slow transition finishes', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(sessions[1]!)
    pool.prepared.set('/tmp/two.jsonl', target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = target.holdStart()
      const first = controller.switchSession(sessions[1]!)
      // This click lands while the first transition is still in flight.
      void controller.switchSession(workspaceSession)
      release()
      await first
      await waitFor(() => controller.getSnapshot().session.sessionId === 'three')
      expect(pool.spawned.has('/tmp/three.jsonl')).toBe(true)
    } finally {
      await controller.dispose()
    }
  })

  it('restores the previous thread when the target harness fails to open', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(sessions[1]!)
    target.failStart('Pi refused the switch')
    pool.prepared.set('/tmp/two.jsonl', target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const before = controller.getSnapshot()
      await controller.switchSession(sessions[1]!)
      const after = controller.getSnapshot()
      // Showing thread two while its harness never opened would take the next prompt into
      // the previous thread under the clicked header.
      expect(after.session).toMatchObject({ sessionId: 'one', sessionFile: '/tmp/one.jsonl' })
      expect(after.workspacePath).toBe(before.workspacePath)
      expect(after.messages).toEqual(before.messages)
      expect(transport.active.id).toBe('one')
      expect(after.notices.map((notice) => notice.message)).toContain('Pi refused the switch')
    } finally {
      await controller.dispose()
    }
  })

  it('preserves concurrent queue, lifecycle and notice updates after a rejected switch', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(sessions[1]!)
    pool.prepared.set('/tmp/two.jsonl', target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = target.holdStart()
      target.failStart('Rejected delayed switch')
      const switching = controller.switchSession({ ...sessions[1]!, cwd: '/tmp/project' })
      const queued = controller.queueInput('Keep this queued input', [], { paused: true })!
      controller.settleThread('/tmp/background.jsonl')
      release()
      await switching
      const state = controller.getSnapshot()
      expect(state.session.sessionId).toBe('one')
      expect(state.queue.items.some((item) => item.id === queued.id)).toBe(true)
      expect(state.threadLifecycle['/tmp/background.jsonl']?.settledAt).toBeDefined()
      expect(state.notices.map((notice) => notice.message)).toContain('Thread moved to Settled')
    } finally {
      await controller.dispose()
    }
  })

  for (const operation of ['clone', 'fork'] as const) {
    it(`keeps the authoritative leaf after ${operation} changes the session file`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'heddlework-clone-leaf-'))
      fixtures.push(directory)
      const original = await writePersistedSession(directory, 'original', ['original'])
      const target = await writePersistedSession(directory, 'forked', ['selected', 'abandoned'])
      const tree = { leafId: 'forked-entry-0', tree: [{ entry: { type: 'message', id: 'forked-entry-0', parentId: null, message: { role: 'user', content: 'selected' } }, children: [] }] }
      const transport = new NavigatingTransport(original, tree)
      transport.cloneTarget = target
      const controller = new WorkbenchController(transport, directory, testControllerDependencies(new StaticCatalog()))
      try {
        await controller.start()
        if (operation === 'clone') await controller.cloneSession()
        else await controller.forkFrom('original-entry-0')
        expect(controller.getSnapshot().session.sessionFile).toBe(target)
        expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['selected'])
      } finally {
        await controller.dispose()
      }
    })
  }

  it('opens a click that landed during a new-session transition', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = transport.holdNextNewSession()
      const creating = controller.newSession()
      // The click lands while /new is still running, so it has no transition to join yet.
      const clicked = controller.switchSession(sessions[1]!)
      release()
      await creating
      await clicked
      expect(controller.getSnapshot().session.sessionId).toBe('two')
      expect(pool.spawned.has('/tmp/two.jsonl')).toBe(true)
    } finally {
      await controller.dispose()
    }
  })

  it('settles a deferred switch only after its thread is open', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const target = new SwitchingTransport(sessions[1]!)
    pool.prepared.set('/tmp/two.jsonl', target)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      const release = target.holdStart()
      const first = controller.switchSession(sessions[1]!)
      let settledWith: string | undefined
      const deferred = controller.switchSession(workspaceSession).then(() => {
        settledWith = controller.getSnapshot().session.sessionFile
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // Resolving here would tell a caller the clicked thread is open while Pi holds another.
      expect(settledWith).toBeUndefined()
      release()
      await first
      await deferred
      expect(settledWith).toBe('/tmp/three.jsonl')
    } finally {
      await controller.dispose()
    }
  })

  it('never rebuilds the Pi session tree on the switch or refresh path', async () => {
    const transport = new SwitchingTransport()
    const pool = createTransportPool(transport)
    const controller = new WorkbenchController(transport, '/tmp/project', pool.deps())
    try {
      await controller.start()
      await controller.switchSession(sessions[1]!)
      const target = pool.spawned.get('/tmp/two.jsonl')!
      target.emitEvent({ type: 'agent_start' })
      target.emitEvent({ type: 'message_end', message: { role: 'assistant', content: 'reply' } })
      target.emitEvent({ type: 'agent_settled' })
      await new Promise((resolve) => setTimeout(resolve, 120))
      // get_tree parses the whole session in Pi and stalls its serial command loop.
      expect(transport.requests.some((command) => command.type === 'get_tree')).toBe(false)
      expect(target.requests.some((command) => command.type === 'get_tree')).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('hydrates Pi\'s in-memory leaf after tree navigation, then follows appends again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-switch-leaf-'))
    fixtures.push(directory)
    const sessionPath = join(directory, 'branching.jsonl')
    const entries = [
      { type: 'message', id: 'entry-u1', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'user', content: 'first', timestamp: 1 } },
      { type: 'message', id: 'entry-a1', parentId: 'entry-u1', timestamp: new Date(2).toISOString(), message: { role: 'assistant', content: 'reply one', timestamp: 2 } },
      { type: 'message', id: 'entry-u2', parentId: 'entry-a1', timestamp: new Date(3).toISOString(), message: { role: 'user', content: 'second', timestamp: 3 } },
      { type: 'message', id: 'entry-a2', parentId: 'entry-u2', timestamp: new Date(4).toISOString(), message: { role: 'assistant', content: 'reply two', timestamp: 4 } },
    ]
    const writeEntries = (records: ReadonlyArray<Record<string, unknown>>) => writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    await writeEntries(entries)
    // Pi moved the leaf to the assistant turn without appending, so the file still ends on the abandoned branch.
    const tree = {
      leafId: 'entry-a1',
      tree: [{
        entry: entries[0], children: [{
          entry: entries[1], children: [{
            entry: entries[2], children: [{ entry: entries[3], children: [] }],
          }],
        }],
      }],
    }
    const transport = new NavigatingTransport(sessionPath, tree)
    const controller = new WorkbenchController(transport, directory, testControllerDependencies(new StaticCatalog()))
    try {
      await controller.start()
      await controller.navigateTree('entry-a1')
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['first', 'reply one'])
      expect(transport.treeRequests).toBe(1)

      // Continuing on the selected branch appends under it, so the file tip is the leaf again.
      await writeEntries([...entries, { type: 'message', id: 'entry-u3', parentId: 'entry-a1', timestamp: new Date(5).toISOString(), message: { role: 'user', content: 'third', timestamp: 5 } }])
      transport.emitEvent({ type: 'message_end', message: { role: 'assistant', content: 'reply' } })
      await waitFor(() => controller.getSnapshot().messages.some((message) => message.content === 'third'))
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['first', 'reply one', 'third'])
      expect(transport.treeRequests).toBe(1)
    } finally {
      await controller.dispose()
    }
  })

  it('does not leak a navigation anchor across a session switch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-switch-anchor-'))
    fixtures.push(directory)
    const sessionPath = join(directory, 'branching.jsonl')
    const entries = [
      { type: 'message', id: 'entry-u1', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'user', content: 'first', timestamp: 1 } },
      { type: 'message', id: 'entry-a1', parentId: 'entry-u1', timestamp: new Date(2).toISOString(), message: { role: 'assistant', content: 'reply one', timestamp: 2 } },
      { type: 'message', id: 'entry-u2', parentId: 'entry-a1', timestamp: new Date(3).toISOString(), message: { role: 'user', content: 'second', timestamp: 3 } },
      { type: 'message', id: 'entry-a2', parentId: 'entry-u2', timestamp: new Date(4).toISOString(), message: { role: 'assistant', content: 'reply two', timestamp: 4 } },
    ]
    await writeFile(sessionPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const otherPath = join(directory, 'other.jsonl')
    await writeFile(otherPath, [JSON.stringify({ type: 'message', id: 'other-1', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'user', content: 'elsewhere', timestamp: 1 } })].join('\n') + '\n')
    const tree = {
      leafId: 'entry-a1',
      tree: [{
        entry: entries[0], children: [{
          entry: entries[1], children: [{
            entry: entries[2], children: [{ entry: entries[3], children: [] }],
          }],
        }],
      }],
    }
    const transport = new NavigatingTransport(sessionPath, tree)
    const pool = createTransportPool()
    const controller = new WorkbenchController(transport, directory, pool.deps())
    try {
      await controller.start()
      await controller.navigateTree('entry-a1')
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['first', 'reply one'])

      const other: PiSessionSummary = { id: 'other', path: otherPath, cwd: directory, title: 'Other thread', firstMessage: 'elsewhere', messageCount: 1, createdAt: 1, modifiedAt: 1 }
      await controller.switchSession(other)
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['elsewhere'])

      // Pi reloaded the first file, so its leaf is the persisted tip, not the abandoned anchor.
      const back: PiSessionSummary = { id: 'branching', path: sessionPath, cwd: directory, title: 'Branching', firstMessage: 'first', messageCount: 4, createdAt: 1, modifiedAt: 4 }
      await controller.switchSession(back)
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['first', 'reply one', 'second', 'reply two'])
    } finally {
      await controller.dispose()
    }
  })
})
