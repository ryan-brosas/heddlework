import { randomUUID } from 'node:crypto'
import { DEFAULT_TERMINAL_APPEARANCE, readTerminalAppearance, resolveTerminalAppearance, writeTerminalAppearance } from './appearance.ts'
import { BunPtyBackend, MemoryTerminalBackend, type TerminalBackend, type TerminalProcess } from './backend.ts'
import type {
  TerminalAppearance,
  TerminalCleanup,
  TerminalGridSnapshot,
  TerminalPlacement,
  TerminalServiceSnapshot,
  TerminalSessionId,
  TerminalSessionInfo,
  TerminalSpawnRequest,
} from './types.ts'
import { VtEmulator } from './vt.ts'

interface LiveSession {
  info: TerminalSessionInfo
  process: TerminalProcess
  vt: VtEmulator
  scrollOffset: number
  sizeOwner: TerminalPlacement | undefined
  cachedGrid: TerminalGridSnapshot | undefined
  gridDirty: boolean
  synchronizedHold: boolean
  synchronizedTimer: ReturnType<typeof setTimeout> | undefined
  lastInputAt: number
  cleanups: TerminalCleanup[]
}

const TERMINAL_FRAME_MS = 8
const SYNCHRONIZED_OUTPUT_STALE_MS = 1_000
const INTERACTIVE_OUTPUT_WINDOW_MS = 500
const INTERACTIVE_OUTPUT_MAX_BYTES = 8 * 1024

export class TerminalSessionService {
  readonly #backend: TerminalBackend
  readonly #cwd: string
  readonly #sessions = new Map<TerminalSessionId, LiveSession>()
  readonly #listeners = new Set<() => void>()
  readonly #stateListeners = new Set<() => void>()
  readonly #frameListeners = new Set<(id: TerminalSessionId) => void>()
  #snapshot: TerminalServiceSnapshot
  #stateSnapshot: TerminalServiceSnapshot
  readonly #appearancePath: string | false
  #appearance: TerminalAppearance
  #activeBottomId: TerminalSessionId | undefined
  #activeRightId: TerminalSessionId | undefined
  #generation = 0
  #lastFrameAt = 0
  #frame: ReturnType<typeof setTimeout> | undefined
  readonly #dirtyFrameIds = new Set<TerminalSessionId>()
  #stateDirty = false
  #disposed = false
  #seq = 0

  constructor(options: {
    cwd: string
    backend?: TerminalBackend
    appearance?: Partial<TerminalAppearance>
    appearancePath?: string | false
  }) {
    this.#cwd = options.cwd
    this.#backend = options.backend ?? new BunPtyBackend()
    this.#appearancePath = options.appearancePath ?? false
    this.#appearance = resolveTerminalAppearance(
      options.appearance,
      readTerminalAppearance(this.#appearancePath) ?? DEFAULT_TERMINAL_APPEARANCE,
    )
    this.#snapshot = this.#createSnapshot()
    this.#stateSnapshot = this.#snapshot
  }

  readonly subscribe = (listener: () => void): TerminalCleanup => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly subscribeState = (listener: () => void): TerminalCleanup => {
    this.#stateListeners.add(listener)
    return () => { this.#stateListeners.delete(listener) }
  }

  readonly subscribeFrames = (listener: (id: TerminalSessionId) => void): TerminalCleanup => {
    this.#frameListeners.add(listener)
    return () => { this.#frameListeners.delete(listener) }
  }

  readonly getSnapshot = (): TerminalServiceSnapshot => this.#snapshot
  readonly getStateSnapshot = (): TerminalServiceSnapshot => this.#stateSnapshot

  grid(id: TerminalSessionId | undefined): TerminalGridSnapshot | undefined {
    if (!id) return undefined
    const session = this.#sessions.get(id)
    if (!session) return undefined
    if (!session.gridDirty && session.cachedGrid?.scrollOffset === session.scrollOffset) return session.cachedGrid
    const snap = session.vt.snapshot(session.scrollOffset)
    session.cachedGrid = snap
    session.gridDirty = false
    return snap
  }

  setAppearance(patch: Partial<TerminalAppearance>): void {
    const next = resolveTerminalAppearance(patch, this.#appearance)
    if (terminalAppearancesEqual(next, this.#appearance)) return
    this.#appearance = next
    writeTerminalAppearance(this.#appearancePath, next)
    this.#publishState()
  }

  resetAppearance(): void {
    this.setAppearance(DEFAULT_TERMINAL_APPEARANCE)
  }

  async spawn(request: TerminalSpawnRequest = {}): Promise<TerminalSessionId> {
    if (this.#disposed) throw new Error('Terminal service is disposed')
    const cols = Math.max(2, request.cols ?? 80)
    const rows = Math.max(1, request.rows ?? 24)
    const cwd = request.cwd ?? this.#cwd
    this.#seq += 1
    const id = randomUUID()
    const name = request.name?.trim() || ('Terminal ' + String(this.#seq))
    const vt = new VtEmulator(cols, rows)
    const process = await this.#backend.spawn({ ...request, cols, rows, cwd })
    vt.onOutput = (data) => process.write(data)
    const session: LiveSession = {
      info: { id, name, title: name, cwd, cols, rows, status: { kind: 'running' } },
      process,
      vt,
      scrollOffset: 0,
      sizeOwner: undefined,
      cachedGrid: vt.snapshot(),
      gridDirty: false,
      synchronizedHold: false,
      synchronizedTimer: undefined,
      lastInputAt: Number.NEGATIVE_INFINITY,
      cleanups: [],
    }
    session.cleanups.push(process.onData((chunk, metadata) => {
      const wasSynchronized = session.vt.synchronizedOutput
      const previousScrollback = session.vt.scrollbackLength
      session.vt.write(chunk)
      this.#anchorDetachedViewport(session, previousScrollback)
      const titleChanged = Boolean(session.vt.title && session.vt.title !== session.info.title)
      if (titleChanged) session.info = { ...session.info, title: session.vt.title }
      if (session.vt.synchronizedOutput) {
        if (titleChanged) this.#publishState()
        session.synchronizedHold = true
        this.#holdSynchronizedOutput(session)
        return
      }
      const completedSynchronizedFrame = metadata?.synchronizedFrame === true || wasSynchronized || session.synchronizedHold
      const elapsedSinceInput = performance.now() - session.lastInputAt
      const withinInteractiveWindow = elapsedSinceInput >= 0 && elapsedSinceInput <= INTERACTIVE_OUTPUT_WINDOW_MS
      const interactiveResponse = withinInteractiveWindow && chunk.byteLength <= INTERACTIVE_OUTPUT_MAX_BYTES
      if (withinInteractiveWindow) session.lastInputAt = Number.NEGATIVE_INFINITY
      this.#releaseSynchronizedOutput(session)
      session.gridDirty = true
      this.#scheduleFrame(session.info.id, completedSynchronizedFrame || interactiveResponse, titleChanged)
    }))
    session.cleanups.push(process.onExit((status) => {
      this.#releaseSynchronizedOutput(session)
      session.gridDirty = true
      session.info = { ...session.info, status }
      this.#scheduleFrame(session.info.id, true, true)
    }))
    this.#sessions.set(id, session)
    if (!this.#activeBottomId) this.#activeBottomId = id
    if (!this.#activeRightId) this.#activeRightId = id
    this.#publishState()
    return id
  }

  async ensureSession(placement?: TerminalPlacement, size?: { cols: number; rows: number }): Promise<TerminalSessionId> {
    const current = placement === 'right' ? this.#activeRightId : placement === 'bottom' ? this.#activeBottomId : (this.#activeBottomId ?? this.#activeRightId)
    if (current && this.#sessions.has(current)) return current
    const first = this.#snapshot.sessions[0]?.id
    if (first) {
      if (placement) this.select(placement, first)
      return first
    }
    return this.spawn(size)
  }

  select(placement: TerminalPlacement, id: TerminalSessionId | undefined): void {
    if (id && !this.#sessions.has(id)) return
    if (placement === 'bottom') this.#activeBottomId = id
    else this.#activeRightId = id
    this.#publishState()
  }

  write(id: TerminalSessionId, data: string): void {
    const session = this.#sessions.get(id)
    if (!session || session.info.status.kind === 'exited' || !data) return
    session.scrollOffset = 0
    session.lastInputAt = performance.now()
    if (session.synchronizedHold) {
      session.gridDirty = true
      this.#scheduleFrame(id, true)
    }
    session.process.write(data)
  }

  claimSize(id: TerminalSessionId, owner: TerminalPlacement): void {
    const session = this.#sessions.get(id)
    if (session) session.sizeOwner = owner
  }

  resize(id: TerminalSessionId, cols: number, rows: number, owner?: TerminalPlacement): void {
    const session = this.#sessions.get(id)
    if (!session) return
    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (owner && session.sizeOwner && session.sizeOwner !== owner) return
    if (owner) session.sizeOwner = owner
    session.process.resize(nextCols, nextRows)
    if (session.info.cols === nextCols && session.info.rows === nextRows) return
    session.vt.resize(nextCols, nextRows)
    session.info = { ...session.info, cols: nextCols, rows: nextRows }
    session.gridDirty = true
    this.#scheduleFrame(id, true, true)
  }

  setScrollOffset(id: TerminalSessionId, offset: number): void {
    const session = this.#sessions.get(id)
    if (!session) return
    const next = Math.max(0, Math.min(session.vt.scrollbackLength, Math.floor(offset)))
    if (next === session.scrollOffset) return
    session.scrollOffset = next
    session.gridDirty = true
    this.#scheduleFrame(id)
  }

  async close(id: TerminalSessionId): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session) return
    this.#releaseSynchronizedOutput(session)
    for (const cleanup of session.cleanups.splice(0)) cleanup()
    session.process.kill()
    this.#sessions.delete(id)
    this.#dirtyFrameIds.delete(id)
    if (this.#activeBottomId === id) this.#activeBottomId = this.#sessions.keys().next().value
    if (this.#activeRightId === id) this.#activeRightId = this.#sessions.keys().next().value
    this.#publishState()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#frame) clearTimeout(this.#frame)
    const ids = [...this.#sessions.keys()]
    for (const id of ids) await this.close(id)
    this.#listeners.clear()
    this.#stateListeners.clear()
    this.#frameListeners.clear()
    this.#dirtyFrameIds.clear()
  }

  #scheduleFrame(id: TerminalSessionId, immediate = false, stateChanged = false): void {
    this.#dirtyFrameIds.add(id)
    this.#stateDirty ||= stateChanged
    if (immediate) {
      if (this.#frame) {
        clearTimeout(this.#frame)
        this.#frame = undefined
      }
      this.#publishFrames()
      return
    }
    if (this.#frame) return
    const elapsed = performance.now() - this.#lastFrameAt
    const delay = Math.max(0, TERMINAL_FRAME_MS - elapsed)
    this.#frame = setTimeout(() => {
      this.#frame = undefined
      this.#publishFrames()
    }, delay)
  }

  #holdSynchronizedOutput(session: LiveSession): void {
    if (session.synchronizedTimer) return
    session.synchronizedTimer = setTimeout(() => {
      session.synchronizedTimer = undefined
      if (!this.#sessions.has(session.info.id)) return
      session.gridDirty = true
      this.#scheduleFrame(session.info.id)
    }, SYNCHRONIZED_OUTPUT_STALE_MS)
  }

  #anchorDetachedViewport(session: LiveSession, previousScrollback: number): void {
    if (session.scrollOffset === 0) return
    const appendedRows = Math.max(0, session.vt.scrollbackLength - previousScrollback)
    session.scrollOffset = Math.min(session.vt.scrollbackLength, session.scrollOffset + appendedRows)
  }

  #releaseSynchronizedOutput(session: LiveSession): void {
    if (session.synchronizedTimer) clearTimeout(session.synchronizedTimer)
    session.synchronizedTimer = undefined
    session.synchronizedHold = false
  }

  #publishState(): void {
    this.#stateDirty = false
    this.#snapshot = this.#createSnapshot()
    this.#stateSnapshot = this.#snapshot
    for (const listener of this.#stateListeners) listener()
    for (const listener of this.#listeners) listener()
  }

  #publishFrames(): void {
    if (this.#dirtyFrameIds.size === 0) return
    this.#lastFrameAt = performance.now()
    const ids = [...this.#dirtyFrameIds]
    this.#dirtyFrameIds.clear()
    const stateChanged = this.#stateDirty
    this.#stateDirty = false
    this.#snapshot = this.#createSnapshot()
    if (stateChanged) this.#stateSnapshot = this.#snapshot
    for (const id of ids) {
      if (!this.#sessions.has(id)) continue
      for (const listener of this.#frameListeners) listener(id)
    }
    if (stateChanged) for (const listener of this.#stateListeners) listener()
    for (const listener of this.#listeners) listener()
  }

  #createSnapshot(): TerminalServiceSnapshot {
    this.#generation += 1
    const sessions: TerminalSessionInfo[] = [...this.#sessions.values()].map((session) => session.info)
    return {
      sessions,
      activeBottomId: this.#activeBottomId,
      activeRightId: this.#activeRightId,
      appearance: this.#appearance,
      generation: this.#generation,
    }
  }
}

function terminalAppearancesEqual(left: TerminalAppearance, right: TerminalAppearance): boolean {
  return left.fontFamily === right.fontFamily
    && left.nerdFontFamily === right.nerdFontFamily
    && left.ligaturesEnabled === right.ligaturesEnabled
    && left.nerdFontEnabled === right.nerdFontEnabled
    && left.muteEmojiColors === right.muteEmojiColors
}

export { MemoryTerminalBackend, BunPtyBackend }
