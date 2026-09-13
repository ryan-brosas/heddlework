import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isCurrentPiSession, type PiSessionSummary } from '../pi/session-catalog.ts'
import { parseBuiltinSlashCommand, slashCommandsFromRpc, type ParsedBuiltinSlashCommand } from '../pi/slash-commands.ts'
import {
  PiSessionHistoryPager,
  SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  SESSION_HISTORY_PAGE_MAX_MESSAGES,
  SESSION_HISTORY_PAGE_MESSAGES,
  type SessionHistoryPage,
} from '../pi/session-history.ts'
import {
  sessionTreeFrom,
  sessionTreeOptions,
  treeNavigationLeavesBranch,
  type PiSessionTree,
} from '../pi/session-tree.ts'
import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import {
  encodeFabricBridgeRequest,
  parseFabricBridgeEvent,
  type FabricBridgeEvent,
  type FabricPeerCard,
} from '../pi/fabric-bridge.ts'
import {
  errorMessage,
  isExtensionUiRequest,
  type ComposerImage,
  type PiForkMessage,
  type PiMessage,
  type PiModel,
  type PiSessionState,
  type PiSessionStats,
  type RpcRecord,
  type RpcSlashCommand,
  type ThinkingLevel,
} from '../pi/types.ts'
import {
  addNotice,
  applyRpcEvent,
  contentText,
  createInitialState,
  shiftTurnAnchors,
  type NoticeKind,
  type ThreadPriority,
  type WorkbenchState,
  type WorkbenchUiRequest,
} from './state.ts'
import {
  createQueueState,
  moveQueuedInput,
  moveQueuedInputToLaneTail,
  queueLaneHead,
  queuedInputControl,
  type QueuedControl,
  type QueuedInput,
  type QueueInputDraft,
  type QueueLane,
} from './queue.ts'
import type { QueueStoreService } from './queue-store.ts'
import { normalizeThreadLabels, type ThreadMetadataStoreService } from './thread-metadata-store.ts'
import type { AskUserSubmissionAnswer } from './ask-user.ts'
import { WorkbenchDialogCoordinator } from './dialog-coordinator.ts'
import type { SessionCatalogService, WorkspaceDiffService } from './services.ts'
import { liveFieldsOnlyChanged, TrailingNotifier } from './notify-batch.ts'
import { formatTimeOfDay } from '../ui/format-time.ts'
import { persistLastWorkspace } from './last-workspace.ts'
import { ensureSessionExportPath } from './session-export.ts'

const SESSION_PAGE_SIZE = 120
/** Idle background Pi processes kept after a switch. Streaming harnesses are never evicted. */
export const SESSION_IDLE_POOL_LIMIT = 8
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000
const MAX_RECONNECT_ATTEMPTS = 10
const HISTORY_NAVIGATION_LOAD_OPTIONS = {
  minimumConversationMessages: SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  maximumMessages: SESSION_HISTORY_PAGE_MAX_MESSAGES,
} as const

export interface NavigateTreeOptions {
  summarize?: boolean | undefined
  customInstructions?: string | undefined
  replaceInstructions?: boolean | undefined
  label?: string | undefined
  preserveQueue?: boolean | undefined
}

export interface WorkbenchControllerDependencies {
  sessionCatalog: SessionCatalogService
  workspaceDiff: WorkspaceDiffService
  transportEvents?: 'direct' | 'external'
  transportOwnership?: 'controller' | 'provider'
  /** Spawns the dedicated harness for one session; each session keeps its own Pi process. */
  createSessionTransport?: ((sessionPath: string) => AgentTransport | Promise<AgentTransport>) | undefined
  queueStore?: QueueStoreService | undefined
  threadMetadataStore?: ThreadMetadataStoreService | undefined
}

/** Live overlay for a background harness so switching back does not look aborted. */
interface SessionLiveSnapshot {
  isStreaming: boolean
  liveAssistant: WorkbenchState['liveAssistant']
  liveTools: WorkbenchState['liveTools']
  activity: string
  dialog: WorkbenchState['dialog']
  dialogQueue: WorkbenchState['dialogQueue']
  statusItems: WorkbenchState['statusItems']
  widgets: WorkbenchState['widgets']
}

export class WorkbenchController {
  #transport: AgentTransport
  readonly #sessionCatalog: SessionCatalogService
  readonly #workspaceDiff: WorkspaceDiffService
  readonly #queueStore: QueueStoreService | undefined
  readonly #threadMetadataStore: ThreadMetadataStoreService | undefined
  readonly #dialogs: WorkbenchDialogCoordinator
  readonly #stopTransportOnDispose: boolean
  readonly #listeners = new Set<() => void>()
  readonly #notifier = new TrailingNotifier(() => {
    for (const listener of this.#listeners) listener()
  })
  #state: WorkbenchState
  #started = false
  #connecting = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #refreshFull = false
  #streamRevision = 0
  #transcriptRefreshGeneration = 0
  #bootstrapGeneration = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempts = 0
  #disposed = false
  #sessionLimit = SESSION_PAGE_SIZE
  #sessionRefresh: Promise<void> | undefined
  #sessionRefreshDirty = false
  #unsubscribeCatalog: (() => void) | undefined
  #sessionTransitionDepth = 0
  #historyPager: PiSessionHistoryPager | undefined
  #sessionTree: PiSessionTree | undefined
  #sessionTreeRequest: Promise<PiSessionTree | undefined> | undefined
  #pendingSessionSwitch: { session: PiSessionSummary; settle: Array<() => void> } | undefined
  #sessionLeafId: string | null | undefined
  #sessionLeafAnchorFile: string | undefined
  #sessionLeafAnchorSize: number | undefined
  #nextQueueId = 0
  #nextUiRequestId = 0
  #nextFabricRequestId = 0
  #queueDispatch: Promise<void> | undefined
  readonly #fabricPeerRequests = new Map<string, (peers: FabricPeerCard[]) => void>()
  #compactionHold = false
  #pauseAfterTools = false
  #detachActiveTransport: (() => void) | undefined
  readonly #sessionTransports = new Map<string, AgentTransport>()
  readonly #backgroundTracking = new Map<AgentTransport, { path: string; detach: () => void }>()
  readonly #liveSessions = new Map<string, SessionLiveSnapshot>()
  readonly #createSessionTransport: ((sessionPath: string) => AgentTransport | Promise<AgentTransport>) | undefined

  constructor(transport: AgentTransport, workspacePath: string, dependencies: WorkbenchControllerDependencies) {
    this.#transport = transport
    this.#sessionCatalog = dependencies.sessionCatalog
    this.#workspaceDiff = dependencies.workspaceDiff
    this.#queueStore = dependencies.queueStore
    this.#threadMetadataStore = dependencies.threadMetadataStore
    this.#stopTransportOnDispose = dependencies.transportOwnership !== 'provider'
    this.#state = {
      ...createInitialState(workspacePath),
      queue: dependencies.queueStore?.load(workspacePath) ?? createQueueState(),
      threadLifecycle: dependencies.threadMetadataStore?.load() ?? {},
    }
    this.#dialogs = new WorkbenchDialogCoordinator({
      getState: () => this.#state,
      patch: (patch) => this.#patch(patch),
      setState: (update) => this.#setState(update),
      send: (record) => this.#transport.send(record),
    })
    const cachedSessions = this.#sessionCatalog.cached?.(workspacePath, this.#sessionLimit + 1) ?? []
    if (cachedSessions.length > 0) {
      this.#state = { ...this.#state, sessions: cachedSessions.slice(0, this.#sessionLimit), sessionsLoading: true, sessionsHasMore: cachedSessions.length > this.#sessionLimit }
    }
    this.#createSessionTransport = dependencies.createSessionTransport
    if (dependencies.transportEvents === 'external') {
      // The integrating plugin owns the provider transport; it attaches it via attachTransport.
    } else {
      this.#attachActiveTransport(transport)
    }
  }

  /** Point the controller at a harness, routing events only from the active one. */
  attachTransport(transport: AgentTransport): void {
    this.#attachActiveTransport(transport)
  }

  #attachActiveTransport(transport: AgentTransport): void {
    // Withdraw the previous attachment first. Session transports are pooled and can be
    // attached again later; a deferred chain would leave the old listeners registered on
    // that same transport, and with the identity guard passing they would apply every
    // event twice (streaming deltas doubled in the live transcript).
    this.#detachActiveTransport?.()
    this.#detachActiveTransport = undefined
    this.#transport = transport
    const onEvent = (event: RpcRecord): void => {
      if (this.#transport === transport) this.#handleEvent(event)
    }
    const onStatus = (status: TransportStatus): void => {
      if (this.#transport === transport) this.#handleStatus(status)
    }
    const offEvent = transport.onEvent(onEvent)
    const offStatus = transport.onStatus(onStatus)
    this.#detachActiveTransport = () => {
      offEvent()
      offStatus()
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): WorkbenchState => this.#state

  readonly loadEarlierMessages = async (): Promise<void> => {
    const pager = this.#historyPager
    if (!pager || !this.#state.messagesHasOlder || this.#state.messagesLoadingEarlier) return
    this.#patch({ messagesLoadingEarlier: true })
    try {
      const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
      if (pager !== this.#historyPager) return
      const known = new Set(this.#state.messages.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
      const older = page.messages.filter((message) => !known.has(messageEntryId(message) ?? ''))
      // Prepending shifts every turn the loaded window already anchored, so the anchors move with
      // the messages they point at instead of rendering after an older turn.
      const prependedTurns = older.filter((message) => message.role === 'user').length
      this.#setState((state) => shiftTurnAnchors({
        ...state,
        messages: [...older, ...state.messages],
        messagesHasOlder: page.hasOlder,
        messagesLoadingEarlier: false,
      }, prependedTurns))
    } catch (error) {
      if (pager !== this.#historyPager) return
      this.#patch({ messagesHasOlder: false, messagesLoadingEarlier: false })
      this.#setState((state) => addNotice(state, 'warning', `Could not load earlier transcript: ${errorMessage(error)}`))
    }
  }

  readonly acceptAgentEvent = (event: RpcRecord): void => this.#handleEvent(event)
  readonly acceptAgentStatus = (status: TransportStatus): void => this.#handleStatus(status)

    notify(kind: NoticeKind, message: string): void {
    this.#setState((state) => addNotice(state, kind, message))
  }

  async start(): Promise<void> {
    if (this.#disposed || this.#started || this.#connecting) return
    this.#clearReconnectTimer()
    this.#connecting = true
    this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    this.#watchSessionCatalog()
    void this.refreshSessions()
    try {
      await this.#transport.start()
      this.#started = true
      await this.#bootstrap(true)
      void persistLastWorkspace(this.#state.workspacePath)
    } catch (error) {
      this.#patch({
        connection: 'error',
        connectionMessage: errorMessage(error),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleReconnect()
    } finally {
      this.#connecting = false
    }
  }

  async reconnect(): Promise<void> {
    this.#clearReconnectTimer()
    this.#started = false
    await this.#transport.stop()
    await this.start()
  }

  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    const message = text.trim()
    const editorImages = this.#state.editorImages
    if ((!message && editorImages.length === 0) || this.#state.connection !== 'connected') return
    if (editorImages.length === 0 && message === '/queue-drain') {
      this.#patch({ editorText: '', editorImages: [] })
      await this.drainQueueMessages()
      return
    }
    if (editorImages.length === 0 && message === '/pause') {
      this.#patch({ editorText: '', editorImages: [] })
      await this.pause()
      return
    }
    const queuedControl = editorImages.length === 0 ? queuedInputControl({ text: message, images: [] }) : undefined
    if (!options.queue && (queuedControl?.kind === 'fabric-prewalk' || queuedControl?.kind === 'fabric-await')) {
      this.#patch({ editorText: '', editorImages: [] })
      this.queueInput(message, [], { lane: this.#state.session.isStreaming ? 'steer' : 'followUp' })
      this.#drainAvailableQueueLane()
      return
    }
    if (this.#state.session.isStreaming || options.queue) {
      this.#patch({ editorText: '', editorImages: [] })
      this.queueInput(message, editorImages, {
        paused: Boolean(options.queue && !this.#state.session.isStreaming),
        lane: this.#state.session.isStreaming && !options.queue ? 'steer' : 'followUp',
      })
      return
    }
    this.#patch({ editorText: '', editorImages: [] })
    const command = editorImages.length === 0 ? parseBuiltinSlashCommand(message) : undefined
    if (command) {
      await this.#runBuiltinSlashCommand(command, false)
      return
    }
    await this.#sendPrompt(message, editorImages, true)
  }

  queueInput(text: string, images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: 'steer' | 'followUp' } = {}): QueuedInput | undefined {
    const [item] = this.enqueueQueueInputs([{ text, images, ...(options.lane ? { lane: options.lane } : {}) }], { start: false, ...(options.paused === undefined ? {} : { paused: options.paused }) })
    return item
  }

  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options: { start?: boolean; paused?: boolean } = {}): QueuedInput[] {
    const createdAt = Date.now()
    const items = inputs.flatMap((input, index): QueuedInput[] => {
      const text = input.text.trim()
      const images = input.images ?? []
      if (!text && images.length === 0) return []
      return [{
        id: `queue-${createdAt}-${++this.#nextQueueId}`,
        text,
        images: images.map((image) => ({ ...image })),
        createdAt: createdAt + index,
        ...(input.lane ? { lane: input.lane } : {}),
        ...(input.paused ? { paused: true } : {}),
        ...(input.flow ? { flow: { ...input.flow } } : {}),
      }]
    })
    if (items.length === 0) return []
    const wasEmpty = this.#state.queue.items.length === 0
    const resetPause = wasEmpty && !options.paused
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: [...this.#state.queue.items, ...items],
        ...(options.paused ? { paused: true, pauseReason: 'manual' as const } : {}),
        ...(resetPause ? { paused: false, pauseReason: undefined } : {}),
      },
    })
    if (options.start) this.#drainQueue()
    return items
  }

  hasQueuedFlow(runId: string): boolean {
    return this.#state.queue.items.some((item) => item.flow?.runId === runId)
  }

  removeQueuedFlow(runId: string): void {
    const dispatchingId = this.#state.queue.dispatchingId
    const items = this.#state.queue.items.filter((item) => item.flow?.runId !== runId || item.id === dispatchingId)
    this.#patch({ queue: { ...this.#state.queue, items, ...(items.length === 0 ? { paused: false, pauseReason: undefined } : {}) } })
  }

  updateQueuedInput(id: string, text: string): void {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || this.#state.queue.dispatchingId === id) return
    const message = text.trim()
    if (!message && item.images.length === 0) {
      this.removeQueuedInput(id)
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.map((candidate) => candidate.id === id ? { ...candidate, text: message } : candidate),
      },
    })
  }

  removeQueuedInput(id: string): void {
    if (this.#state.queue.dispatchingId === id) return
    const items = this.#state.queue.items.filter((item) => item.id !== id)
    this.#patch({ queue: { ...this.#state.queue, items, ...(items.length === 0 ? { paused: false, pauseReason: undefined } : {}) } })
  }

  moveQueuedInput(id: string, targetIndex: number): void {
    if (this.#state.queue.dispatchingId) return
    this.#patch({ queue: { ...this.#state.queue, items: moveQueuedInput(this.#state.queue.items, id, targetIndex) } })
  }

  moveQueuedInputToLane(id: string, lane: QueueLane): void {
    if (this.#state.queue.dispatchingId === id) return
    this.#patch({ queue: { ...this.#state.queue, items: moveQueuedInputToLaneTail(this.#state.queue.items, id, lane) } })
    this.#drainAvailableQueueLane()
  }

  toggleQueuedInputPause(id: string): void {
    if (this.#state.queue.dispatchingId === id) return
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item) return
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.map((candidate) => candidate.id === id ? { ...candidate, paused: !candidate.paused } : candidate),
      },
    })
    if (item.paused) this.#drainAvailableQueueLane()
  }

  async queueFabricPeerGate(): Promise<void> {
    const peers = await this.#requestFabricPeers()
    if (peers.length === 0) {
      this.#setState((state) => addNotice(state, 'warning', 'No live Pi Fabric peers are available'))
      return
    }
    const options = [
      'All active peers',
      ...peers.map((peer) => `${peer.label} · ${peer.status}${peer.model ? ` · ${peer.model}` : ''}`),
    ]
    const peerIds = new Map(options.slice(1).map((option, index) => [option, peers[index]!.id]))
    this.#dialogs.showLocalSelect('Wait for Fabric peers to settle', options, (response) => {
      if (!response.value) return
      const peer = peerIds.get(response.value)
      this.queueInput(`/fabric await${peer ? ` ${peer}` : ''}`, [], { lane: 'followUp' })
      this.#drainAvailableQueueLane()
    })
  }

  cancelBlockingQueueActivity(): void {
    const { dispatchingId, blockingActivity } = this.#state.queue
    if (!dispatchingId || blockingActivity !== 'fabric-await') return
    this.#transport.send({
      type: 'prompt',
      message: encodeFabricBridgeRequest({
        action: 'cancel',
        requestId: this.#newFabricRequestId('cancel'),
        targetId: dispatchingId,
      }),
    })
    const items = this.#state.queue.items.filter((item) => item.id !== dispatchingId)
    this.#patch({
      queue: {
        ...this.#state.queue,
        items,
        paused: items.length > 0,
        pauseReason: items.length > 0 ? 'manual' : undefined,
        dispatchingId: undefined,
        blockingActivity: undefined,
        blockingNote: undefined,
      },
    })
  }

  async steerQueuedInput(id: string): Promise<void> {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || !this.#state.session.isStreaming || this.#state.queue.dispatchingId) return
    if (queuedInputControl(item)) return
    this.#patch({ queue: { ...this.#state.queue, dispatchingId: id } })
    try {
      await this.#transport.request({
        type: 'prompt',
        message: item.text,
        ...(item.images.length > 0 ? { images: item.images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
        streamingBehavior: 'steer',
      })
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((candidate) => candidate.id !== id),
          steering: [item.text || 'Image attachment', ...this.#state.queue.steering.filter((text) => text !== item.text)],
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#patch({ queue: { ...this.#state.queue, dispatchingId: undefined } })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  resumeQueue(): void {
    this.#pauseAfterTools = false
    this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    this.#drainQueue()
  }

  async drainQueueMessages(): Promise<void> {
    if (this.#state.queue.dispatchingId || this.#compactionHold) {
      this.#setState((state) => addNotice(state, 'warning', 'The queue can drain after the current control or compaction finishes'))
      return
    }
    const messages = this.#state.queue.items.filter((item) => !item.flow && !queuedInputControl(item))
    if (messages.length === 0) {
      this.#setState((state) => addNotice(state, 'info', this.#state.queue.items.length === 0 ? 'Queue is empty' : 'No ordinary message rows can be drained; Flow and control rows keep their boundaries'))
      return
    }
    const ids = new Set(messages.map((item) => item.id))
    const wasStreaming = this.#state.session.isStreaming
    const text = messages.map((item) => item.text).filter(Boolean).join('\n\n')
    const images = messages.flatMap((item) => item.images)
    this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined, dispatchingId: messages[0]!.id } })
    try {
      const accepted = wasStreaming
        ? await this.#transport.request({
            type: 'prompt',
            message: text,
            ...(images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
            streamingBehavior: 'steer',
          }).then(() => true)
        : await this.#sendPrompt(text, images, false)
      if (!accepted) throw new Error('Pi did not accept the drained queue')
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => !ids.has(item.id)),
          ...(wasStreaming ? { steering: [...this.#state.queue.steering, text || `${images.length} image attachments`] } : {}),
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error', dispatchingId: undefined } })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async pause(): Promise<void> {
    this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'manual' } })
    if (!this.#state.session.isStreaming) return
    if (this.#state.liveTools.some((tool) => tool.status !== 'complete')) {
      this.#pauseAfterTools = true
      this.#setState((state) => addNotice(state, 'info', 'Pause armed; in-flight tools will finish before Pi stops'))
      return
    }
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Pausing' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async abort(): Promise<void> {
    this.#pauseAfterTools = false
    this.cancelBlockingQueueActivity()
    if (this.#state.queue.items.length > 0) this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'abort' } })
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Aborting' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async newSession(): Promise<void> {
    const previousFile = this.#state.session.sessionFile
    const wasStreaming = this.#state.session.isStreaming
    if (!this.#createSessionTransport && wasStreaming) return
    this.#sessionTransitionDepth += 1
    try {
      if (previousFile) {
        this.#captureLiveSession(previousFile)
        this.#ensureBackgroundTracking(this.#transport, previousFile)
        this.#dialogs.hideVisible()
      }
      if (this.#createSessionTransport) {
        const transport = await this.#openSessionTransport('')
        this.#attachActiveTransport(transport)
      } else {
        this.#dialogs.cancelAll()
      }
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session' })
      if (result.cancelled) return
      if (previousFile && wasStreaming) {
        this.#patch({
          sessionActivity: {
            ...this.#state.sessionActivity,
            [previousFile]: true,
            [resolve(previousFile)]: true,
          },
        })
      }
      this.#historyPager = undefined
      this.#patch({
        messages: [],
        messagesHasOlder: false,
        messagesLoadingEarlier: false,
        forkMessages: [],
        liveAssistant: undefined,
        liveTools: [],
        editorText: '',
        editorImages: [],
        notices: [],
        statusLines: [],
        statusItems: {},
        widgets: {},
        dialog: undefined,
        dialogQueue: [],
        questionnaireSubmitting: undefined,
        questionnaireCollapsed: undefined,
        queue: createQueueState(),
      })
      await this.#bootstrap(false)
      const opened = this.#state.session.sessionFile
      if (this.#createSessionTransport && opened) {
        this.#touchSessionTransport(resolve(opened), this.#transport)
        this.#trimIdleSessionPool(opened)
      }
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#endSessionTransition()
    }
  }

  async switchWorkspace(workspacePath: string): Promise<void> {
    const target = resolve(workspacePath)
    if (target === resolve(this.#state.workspacePath)) return
    if (this.#state.connection !== 'connected') {
      this.#setState((state) => addNotice(state, 'warning', 'Reconnect Pi before switching sessions'))
      return
    }
    this.#patch({ activity: 'Opening project' })
    try {
      const session = await this.#sessionCatalog.createWorkspaceSession(target)
      await this.switchSession(session)
      void persistLastWorkspace(target)
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', `Could not open project: ${errorMessage(error)}`))
    }
  }

  async switchSession(session: PiSessionSummary): Promise<void> {
    if (this.#sessionTransitionDepth > 0) {
      // A click landed while another session transition was still running; keep the newest
      // target instead of dropping it, and open it when the transition finishes. The caller
      // waits for that switch instead of returning early, which would claim the clicked
      // thread is open while Pi still holds the previous one.
      const settle = this.#pendingSessionSwitch?.settle ?? []
      this.#pendingSessionSwitch = { session, settle }
      return new Promise<void>((resolve) => { settle.push(resolve) })
    }
    if (isCurrentPiSession(session, this.#state.session)) return
    if (this.#state.connection !== 'connected') {
      this.#setState((state) => addNotice(state, 'warning', 'Reconnect Pi before switching sessions'))
      return
    }
    this.#sessionTransitionDepth += 1
    // Drop in-flight bootstrap from the previous thread so a late get_state cannot
    // overwrite this click's optimistic scope once we release the transition lock.
    this.#bootstrapGeneration += 1
    this.#transcriptRefreshGeneration += 1
    // Everything the optimistic scope below hides, so a rejected switch can put it back.
    const scope = { state: this.#state, historyPager: this.#historyPager, sessionTree: this.#sessionTree }
    let rollback: Partial<WorkbenchState> | undefined
    try {
      const previousFile = this.#state.session.sessionFile
      this.#captureLiveSession(previousFile)
      this.#ensureBackgroundTracking(this.#transport, previousFile)
      // Hide this window's dialogs; do not cancel Pi — that aborts the background turn.
      this.#dialogs.hideVisible()
      const live = this.#liveSessions.get(resolve(session.path)) ?? this.#liveSessions.get(session.path)
      this.#patch({ activity: live?.isStreaming ? 'Working' : 'Opening thread' })
      // No abort: every session owns a dedicated Pi process, so the previous harness keeps
      // running any in-flight turn while this thread opens. Moving the visible thread to the
      // clicked session must not depend on the harness either: the persisted JSONL tail
      // paints in milliseconds while a cold harness parses the whole session file (seconds
      // to tens of seconds on large threads). #bootstrap replaces the preview with
      // authoritative state, off the transition lock.
      this.#sessionTree = undefined
      this.#historyPager = undefined
      const optimistic = this.#sessionSwitchPatch(session, live)
      // Restore only fields this preview changed, not concurrent application updates.
      rollback = Object.fromEntries(Object.keys(optimistic).map((key) => [key, scope.state[key as keyof WorkbenchState]]))
      if (optimistic.workspacePath === scope.state.workspacePath) delete rollback.queue
      this.#patch(optimistic)
      const preview = this.#previewSessionTranscript(session)
      const sessionKey = resolve(session.path)
      const pooled = this.#sessionTransports.get(sessionKey) ?? this.#sessionTransports.get(session.path)
      const transport = pooled ?? await this.#openSessionTransport(session.path)
      if (this.#state.session.sessionFile !== session.path) {
        // A newer click superseded this switch while the harness was starting; leave the
        // pooled harness attached for the newer transition instead of clobbering it.
        await preview
        return
      }
      this.#attachActiveTransport(transport)
      this.#touchSessionTransport(sessionKey, transport)
      this.#trimIdleSessionPool(session.path)
      // The thread just left keeps its harness and possibly its turn; seed the sidebar signal.
      if (previousFile && previousFile !== session.path) {
        this.#patch({
          sessionActivity: {
            ...this.#state.sessionActivity,
            [previousFile]: scope.state.session.isStreaming,
            [resolve(previousFile)]: scope.state.session.isStreaming,
          },
        })
      }
      await preview
      this.#patch({ activity: this.#state.session.isStreaming ? 'Working' : 'Ready' })
      // get_state waits for Pi to finish parsing the JSONL. Holding the click lock for
      // that (5–10s on a 100 MiB thread) made every switch feel stalled even after the
      // transcript was already on screen.
      void this.#bootstrap(false).then(() => { void this.refreshSessions() }).catch((error) => {
        if (this.#state.session.sessionFile !== session.path) return
        this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      })
    } catch (error) {
      if (rollback) this.#patch({ ...rollback, notices: [...scope.state.notices, ...this.#state.notices], statusLines: [...scope.state.statusLines, ...this.#state.statusLines] })
      this.#historyPager = scope.historyPager
      this.#sessionTree = scope.sessionTree
      // Pi keeps the previous session open when switch_session rejects, so the optimistic
      // scope must not outlive it: showing the clicked thread there would take the next
      // prompt into the previous thread under the wrong header.
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      await this.#reconcileSessionScope()
    } finally {
      this.#endSessionTransition()
    }
  }

  /** Start a dedicated harness for one session; the previous harness keeps running. */
  async #openSessionTransport(sessionPath: string): Promise<AgentTransport> {
    if (!this.#createSessionTransport) throw new Error('No session transport factory is configured')
    const transport = await this.#createSessionTransport(sessionPath)
    try {
      await transport.start()
    } catch (error) {
      await transport.stop().catch(() => {})
      throw error
    }
    if (sessionPath) this.#sessionTransports.set(resolve(sessionPath), transport)
    return transport
  }

  #touchSessionTransport(sessionKey: string, transport: AgentTransport): void {
    this.#sessionTransports.delete(sessionKey)
    this.#sessionTransports.set(sessionKey, transport)
  }

  /** Stop oldest idle harnesses so Linux does not accumulate a Pi per sidebar click. Streaming stays. */
  #trimIdleSessionPool(keepPath: string): void {
    const keep = resolve(keepPath)
    const idle: AgentTransport[] = []
    const seen = new Set<AgentTransport>()
    for (const [path, transport] of this.#sessionTransports) {
      if (seen.has(transport) || transport === this.#transport) continue
      if (resolve(path) === keep) continue
      const streaming = this.#liveSessions.get(path)?.isStreaming === true
        || this.#liveSessions.get(resolve(path))?.isStreaming === true
        || this.#state.sessionActivity[path] === true
        || this.#state.sessionActivity[resolve(path)] === true
      if (streaming) continue
      seen.add(transport)
      idle.push(transport)
    }
    const overflow = idle.length - SESSION_IDLE_POOL_LIMIT
    if (overflow <= 0) return
    for (const transport of idle.slice(0, overflow)) {
      this.#backgroundTracking.get(transport)?.detach()
      this.#backgroundTracking.delete(transport)
      for (const [path, pooled] of [...this.#sessionTransports]) {
        if (pooled === transport) this.#sessionTransports.delete(path)
      }
      void transport.stop()
    }
  }

  #captureLiveSession(sessionFile: string | undefined): void {
    if (!sessionFile) return
    const snapshot: SessionLiveSnapshot = {
      isStreaming: this.#state.session.isStreaming,
      liveAssistant: this.#state.liveAssistant,
      liveTools: this.#state.liveTools,
      activity: this.#state.activity,
      dialog: this.#state.dialog,
      dialogQueue: this.#state.dialogQueue,
      statusItems: this.#state.statusItems,
      widgets: this.#state.widgets,
    }
    this.#liveSessions.set(resolve(sessionFile), snapshot)
    this.#liveSessions.set(sessionFile, snapshot)
  }

  #ensureBackgroundTracking(transport: AgentTransport, sessionFile: string | undefined): void {
    if (!sessionFile) return
    const key = resolve(sessionFile)
    const tracked = this.#backgroundTracking.get(transport)
    if (tracked?.path === sessionFile || tracked?.path === key) return
    tracked?.detach()
    this.#backgroundTracking.set(transport, { path: sessionFile, detach: this.#attachBackgroundTracking(transport, sessionFile) })
  }

  /** Keep the pool keyed by the file each harness actually holds (new_session re-files it). */
  #rememberActiveSessionTransport(sessionFile: string | undefined): void {
    if (!sessionFile) return
    const sessionKey = resolve(sessionFile)
    for (const [path, transport] of this.#sessionTransports) {
      if (transport === this.#transport && path !== sessionKey && path !== sessionFile) this.#sessionTransports.delete(path)
    }
    this.#sessionTransports.set(sessionKey, this.#transport)
    const tracked = this.#backgroundTracking.get(this.#transport)
    if (tracked?.path !== sessionFile) {
      tracked?.detach()
      this.#backgroundTracking.set(this.#transport, { path: sessionFile, detach: this.#attachBackgroundTracking(this.#transport, sessionFile) })
    }
  }

  /**
   * Watch a non-active harness so its turn state stays visible: the sidebar shows a
   * background session still working, and a crashed harness leaves the pool quietly.
   */
  #attachBackgroundTracking(transport: AgentTransport, sessionFile: string): () => void {
    const setActivity = (streaming: boolean): void => {
      this.#patch({
        sessionActivity: {
          ...this.#state.sessionActivity,
          [sessionFile]: streaming,
          [resolve(sessionFile)]: streaming,
        },
      })
      const live = this.#liveSessions.get(resolve(sessionFile)) ?? this.#liveSessions.get(sessionFile)
      if (!live) return
      live.isStreaming = streaming
      live.activity = streaming ? 'Working' : 'Ready'
      if (!streaming) {
        live.liveAssistant = undefined
        live.liveTools = []
      }
    }
    const offEvent = transport.onEvent((event) => {
      if (this.#disposed || this.#transport === transport) return
      if (event.type === 'agent_start') setActivity(true)
      if (event.type === 'agent_settled') setActivity(false)
    })
    const offStatus = transport.onStatus((status) => {
      if (this.#disposed || this.#transport === transport) return
      if (status.state !== 'exited' && status.state !== 'stopped') return
      const sessionKey = resolve(sessionFile)
      if (this.#sessionTransports.get(sessionKey) === transport) this.#sessionTransports.delete(sessionKey)
      if (this.#sessionTransports.get(sessionFile) === transport) this.#sessionTransports.delete(sessionFile)
      this.#backgroundTracking.get(transport)?.detach()
      this.#backgroundTracking.delete(transport)
      setActivity(false)
    })
    return () => {
      offEvent()
      offStatus()
    }
  }

  /**
   * Leave a session transition. Every operation that owns the transition must exit through
   * here, so a click that landed during it opens on the way out instead of waiting for an
   * unrelated later switch to drain it.
   */
  #endSessionTransition(): void {
    this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
    if (this.#sessionTransitionDepth > 0) return
    const pending = this.#pendingSessionSwitch
    this.#pendingSessionSwitch = undefined
    if (!pending) return
    // switchSession reports its own failures, but a failure must not strand the waiters.
    void this.switchSession(pending.session).catch(() => {}).finally(() => {
      for (const settle of pending.settle) settle()
    })
  }

  /** Pi owns what is actually open, so re-read it after a rejected transition. */
  async #reconcileSessionScope(): Promise<void> {
    if (this.#disposed || this.#state.connection !== 'connected') return
    try {
      await this.#bootstrap(false)
    } catch {
      // The failure notice above is the report; reconciling must not add a second one.
    }
  }

  /**
   * Reset applied the moment a thread is clicked, so the transcript, header, project
   * scope, and queue move together while Pi loads the session in the background.
   */
  #sessionSwitchPatch(session: PiSessionSummary, live?: SessionLiveSnapshot): Partial<WorkbenchState> {
    const workspacePath = session.cwd ? resolve(session.cwd) : this.#state.workspacePath
    const sameWorkspace = resolve(workspacePath) === resolve(this.#state.workspacePath)
    return {
      workspacePath,
      session: {
        ...this.#state.session,
        sessionFile: session.path,
        sessionId: session.id,
        sessionName: session.name ?? session.title,
        isStreaming: live?.isStreaming ?? false,
      },
      messages: [],
      messagesHasOlder: false,
      messagesLoadingEarlier: false,
      forkMessages: [],
      liveAssistant: live?.liveAssistant,
      liveTools: live?.liveTools ?? [],
      editorText: '',
      editorImages: [],
      notices: [],
      statusLines: [],
      statusItems: live?.statusItems ?? {},
      widgets: live?.widgets ?? {},
      dialog: live?.dialog,
      dialogQueue: live?.dialogQueue ?? [],
      questionnaireSubmitting: undefined,
      questionnaireCollapsed: undefined,
      activity: live?.isStreaming ? live.activity || 'Working' : 'Opening thread',
      queue: sameWorkspace ? this.#state.queue : this.#queueStore?.load(workspacePath) ?? createQueueState(),
      workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
    }
  }

  /** Read the clicked thread's persisted tail; #bootstrap owns the authoritative transcript. */
  async #previewSessionTranscript(session: PiSessionSummary): Promise<void> {
    const pager = new PiSessionHistoryPager(session.path)
    let page: SessionHistoryPage
    try {
      page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
    } catch {
      return
    }
    if (this.#disposed || this.#sessionTransitionDepth === 0) return
    if (this.#state.session.sessionFile !== session.path) return
    if (page.messages.length === 0) return
    this.#historyPager = pager
    this.#patch({
      messages: page.messages,
      messagesHasOlder: page.hasOlder,
      messagesLoadingEarlier: false,
    })
  }

  async refreshSessions(background = false): Promise<void> {
    if (this.#disposed) return
    if (!background) this.#patch({ sessionsLoading: true })
    if (this.#sessionRefresh) {
      this.#sessionRefreshDirty = true
      return this.#sessionRefresh
    }
    const task = (async () => {
      do {
        this.#sessionRefreshDirty = false
        const workspacePath = this.#state.workspacePath
        const limit = this.#sessionLimit
        try {
          const sessions = await this.#sessionCatalog.list(workspacePath, limit + 1)
          if (this.#disposed) return
          if (
            workspacePath !== this.#state.workspacePath
            || limit !== this.#sessionLimit
            || this.#sessionRefreshDirty
          ) {
            this.#sessionRefreshDirty = true
            continue
          }
          const page = sessions.slice(0, limit)
          const unchanged = page.length === this.#state.sessions.length
            && page.every((session, index) => session === this.#state.sessions[index])
          this.#patch({
            sessions: unchanged ? this.#state.sessions : page,
            sessionsLoading: false,
            sessionsHasMore: sessions.length > limit,
          })
        } catch (error) {
          if (this.#disposed) return
          if (this.#sessionRefreshDirty) continue
          this.#patch({ sessionsLoading: false })
          this.#setState((state) => addNotice(state, 'warning', `Could not list sessions: ${errorMessage(error)}`))
          return
        }
      } while (this.#sessionRefreshDirty && !this.#disposed)
    })().finally(() => {
      if (this.#sessionRefresh === task) this.#sessionRefresh = undefined
    })
    this.#sessionRefresh = task
    return task
  }

  #watchSessionCatalog(): void {
    this.#unsubscribeCatalog?.()
    const catalog = this.#sessionCatalog as SessionCatalogService & {
      subscribe?(cwd: string, listener: () => void): () => void
    }
    this.#unsubscribeCatalog = catalog.subscribe?.(this.#state.workspacePath, () => {
      void this.refreshSessions(true)
    })
  }

  async loadMoreSessions(): Promise<void> {
    if (this.#state.sessionsLoading || !this.#state.sessionsHasMore) return
    this.#sessionLimit += SESSION_PAGE_SIZE
    await this.refreshSessions()
  }

  async openSessionTree(options: { preserveQueue?: boolean } = {}): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const sessionTree = await this.#requestSessionTree()
      const selections = sessionTreeOptions(sessionTree)
      if (selections.length === 0) {
        this.#setState((state) => addNotice(state, 'warning', 'The current Pi session tree is empty'))
        return
      }
      this.#dialogs.showLocalTree('Navigate session tree\nSelect any point to continue in this session', selections, (response) => {
        if (response.value) this.#chooseTreeNavigation(sessionTree, response.value, options.preserveQueue ?? false)
      })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'warning', errorMessage(error)))
    }
  }

  async navigateTree(entryId: string, options: NavigateTreeOptions = {}): Promise<void> {
    if (!entryId || this.#state.session.isStreaming) return
    this.#patch({ activity: options.summarize ? 'Summarizing branch' : 'Navigating session tree' })
    try {
      const result = await this.#transport.request<{ cancelled?: boolean; editorText?: string }>({
        type: 'navigate_tree',
        entryId,
        ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
        ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
        ...(options.replaceInstructions === undefined ? {} : { replaceInstructions: options.replaceInstructions }),
        ...(options.label === undefined ? {} : { label: options.label }),
      })
      if (result.cancelled) {
        this.#patch({ activity: 'Ready' })
        return
      }
      this.#historyPager = undefined
      this.#patch({ notices: [], statusLines: [], queue: options.preserveQueue ? this.#state.queue : createQueueState() })
      // In-memory navigation can leave the file tip on the abandoned branch.
      await this.#bootstrap(false, { anchorLeaf: true })
      if (result.editorText !== undefined) this.#patch({ editorText: result.editorText, editorImages: [] })
      this.#setState((state) => addNotice(state, 'info', 'Navigated within the current Pi session'))
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  #chooseTreeNavigation(sessionTree: PiSessionTree, entryId: string, preserveQueue: boolean): void {
    if (!treeNavigationLeavesBranch(sessionTree, entryId)) {
      void this.navigateTree(entryId, { preserveQueue })
      return
    }
    const withoutSummary = 'Continue without summary — Keep the abandoned branch only in session history'
    const withSummary = 'Summarize abandoned branch — Carry its important context onto the selected branch'
    const withCustomSummary = 'Summarize with custom focus — Add instructions for what Pi should preserve'
    this.#dialogs.showLocalSelect('Leave the active branch\nChoose how context should carry forward', [withoutSummary, withSummary, withCustomSummary], (response) => {
      if (response.value === withoutSummary) {
        void this.navigateTree(entryId, { preserveQueue })
      } else if (response.value === withSummary) {
        void this.navigateTree(entryId, { summarize: true, preserveQueue })
      } else if (response.value === withCustomSummary) {
        this.#dialogs.showLocalInput('Branch summary focus', 'What should Pi preserve from the branch?', (input) => {
          const customInstructions = input.value?.trim()
          if (customInstructions) void this.navigateTree(entryId, { summarize: true, customInstructions, preserveQueue })
        })
      }
    })
  }

  async cloneSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'clone' })
      if (result.cancelled) return
      this.#patch({ notices: [], statusLines: [], queue: createQueueState() })
      await this.#bootstrap(false, { anchorLeaf: true })
      this.#setState((state) => addNotice(state, 'info', 'Cloned thread into a new Pi session'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async forkFrom(entryId: string, options: { preserveQueue?: boolean } = {}): Promise<void> {
    if (!entryId || this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ text?: string; cancelled?: boolean }>({ type: 'fork', entryId })
      if (result.cancelled) return
      this.#patch({ notices: [], statusLines: [], queue: options.preserveQueue ? this.#state.queue : createQueueState() })
      await this.#bootstrap(false, { anchorLeaf: true })
      this.#patch({ editorText: result.text ?? '', editorImages: [] })
      this.#setState((state) => addNotice(state, 'info', 'Branched from the selected turn'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async exportSession(): Promise<string | undefined> {
    try {
      const outputPath = ensureSessionExportPath(this.#state.session.sessionFile)
      const data = await this.#transport.request<{ path: string }>({ type: 'export_html', outputPath })
      this.#setState((state) => addNotice(state, 'info', `Exported session to ${data.path}`))
      return data.path
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return undefined
    }
  }

  async setModel(model: PiModel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_model', provider: model.provider, modelId: model.id })
      const [session, levels] = await Promise.all([
        this.#transport.request<PiSessionState>({ type: 'get_state' }),
        this.#getThinkingLevels(),
      ])
      this.#patch({ session, thinkingLevels: levels })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_thinking_level', level })
      this.#patch({ session: { ...this.#state.session, thinkingLevel: level } })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async compact(): Promise<void> {
    if (this.#state.session.isStreaming) return
    await this.#runBuiltinSlashCommand({ name: 'compact', argument: '' }, false)
  }

  completeUiRequest(id: number): void {
    if (this.#state.uiRequest?.id === id) this.#patch({ uiRequest: undefined })
  }

  setEditorText(text: string): void {
    this.#patch({ editorText: text })
  }

  addEditorImage(image: ComposerImage): void {
    const acceptedInputs = this.#state.session.model?.input
    if (acceptedInputs && !acceptedInputs.includes('image')) {
      this.#setState((state) => addNotice(state, 'warning', 'The selected model does not accept images'))
      return
    }
    if (this.#state.editorImages.some((candidate) => candidate.data === image.data)) return
    if (this.#state.editorImages.length >= 8) {
      this.#setState((state) => addNotice(state, 'warning', 'A prompt can include at most 8 images'))
      return
    }
    this.#patch({ editorImages: [...this.#state.editorImages, image] })
  }

  removeEditorImage(id: string): void {
    this.#patch({ editorImages: this.#state.editorImages.filter((image) => image.id !== id) })
  }

  dismissNotice(id: number): void {
    this.#patch({ notices: this.#state.notices.filter((notice) => notice.id !== id) })
  }

  clearNotices(): void {
    this.#patch({ notices: [] })
  }

  settleThread(path: string): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { snoozedUntil: _snoozedUntil, unsettledAt: _unsettledAt, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, settledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread moved to Settled'))
  }

  snoozeThread(path: string, snoozedUntil: number): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { settledAt: _settledAt, unsettledAt: _unsettledAt, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, snoozedUntil },
    }
    const time = formatTimeOfDay(snoozedUntil)
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', `Snoozed until ${time}`))
  }

  wakeThread(path: string): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { settledAt: _settledAt, snoozedUntil: _snoozedUntil, ...retained } = current
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { ...retained, unsettledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread returned to Active'))
  }

  setThreadPriority(path: string, priority: ThreadPriority | undefined): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { priority: _priority, ...retained } = current
    this.#patch({ threadLifecycle: {
      ...this.#state.threadLifecycle,
      [path]: priority === undefined ? retained : { ...retained, priority },
    } })
  }

  setThreadLabels(path: string, labels: readonly string[]): void {
    const current = this.#state.threadLifecycle[path] ?? {}
    const { labels: _labels, ...retained } = current
    const normalized = normalizeThreadLabels(labels)
    this.#patch({ threadLifecycle: {
      ...this.#state.threadLifecycle,
      [path]: normalized.length === 0 ? retained : { ...retained, labels: normalized },
    } })
  }

  markThreadRead(path: string, updatedAt: number): void {
    this.markThreadsRead([{ path, updatedAt }])
  }

  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void {
    let threadLifecycle = this.#state.threadLifecycle
    for (const { path, updatedAt } of threads) {
      const current = threadLifecycle[path] ?? {}
      if ((current.readAt ?? 0) >= updatedAt) continue
      if (threadLifecycle === this.#state.threadLifecycle) threadLifecycle = { ...threadLifecycle }
      threadLifecycle[path] = { ...current, readAt: updatedAt }
    }
    if (threadLifecycle !== this.#state.threadLifecycle) this.#patch({ threadLifecycle })
  }

  async refreshWorkspaceDiff(): Promise<void> {
    const workspacePath = this.#state.workspacePath
    this.#patch({
      workspaceDiff: {
        status: 'loading',
        branch: this.#state.workspaceDiff.branch,
        files: this.#state.workspaceDiff.files,
        additions: this.#state.workspaceDiff.additions,
        deletions: this.#state.workspaceDiff.deletions,
      },
    })
    const workspaceDiff = await this.#workspaceDiff.load(workspacePath)
    if (this.#state.workspacePath === workspacePath) this.#patch({ workspaceDiff })
  }

  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    this.#dialogs.respond(response)
  }

  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[]): void {
    this.#dialogs.submitQuestionnaire(toolCallId, answers)
  }

  cancelAskUserQuestionnaire(toolCallId: string): void {
    this.#dialogs.cancelQuestionnaire(toolCallId)
  }

  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void {
    this.#dialogs.setQuestionnaireCollapsed(toolCallId, collapsed)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#unsubscribeCatalog?.()
    this.#unsubscribeCatalog = undefined
    this.#clearReconnectTimer()
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#dialogs.dispose()
    for (const resolvePeers of this.#fabricPeerRequests.values()) resolvePeers([])
    this.#fabricPeerRequests.clear()
    this.#detachActiveTransport?.()
    this.#detachActiveTransport = undefined
    for (const tracked of this.#backgroundTracking.values()) tracked.detach()
    this.#backgroundTracking.clear()
    const stopAll = await Promise.allSettled(
      [...new Set([this.#transport, ...this.#sessionTransports.values()])].map(async (transport) => {
        if (transport === this.#transport && !this.#stopTransportOnDispose) return
        await transport.stop()
      }),
    )
    void stopAll
    this.#notifier.cancel()
    this.#listeners.clear()
  }

  async #sendPrompt(message: string, images: readonly ComposerImage[], restoreDraft: boolean): Promise<boolean> {
    const previousMessages = this.#state.messages
    const previousSession = this.#state.session
    const previousActivity = this.#state.activity
    const optimisticContent = images.length > 0
      ? [
          ...(message ? [{ type: 'text' as const, text: message }] : []),
          ...images.map(({ data, mimeType, previewPath }) => ({ type: 'image' as const, data, mimeType, previewPath })),
        ]
      : message
    const optimistic: PiMessage = {
      role: 'user',
      content: optimisticContent,
      timestamp: Date.now(),
      workbenchOptimistic: true,
    }
    this.#patch({
      messages: [...previousMessages, optimistic],
      session: { ...previousSession, isStreaming: true },
      activity: 'Sending',
    })
    try {
      await this.#transport.request({
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
      })
      return true
    } catch (error) {
      this.#patch({
        messages: previousMessages,
        session: previousSession,
        activity: previousActivity,
        ...(restoreDraft ? { editorText: message, editorImages: images.map((image) => ({ ...image })) } : {}),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleRefresh(true)
      return false
    }
  }

  #drainAvailableQueueLane(): void {
    if (this.#state.session.isStreaming) this.#drainSteering()
    else this.#drainQueue()
  }

  #drainSteering(): void {
    if (this.#queueDispatch) return
    const task = this.#drainSteeringHead()
    this.#queueDispatch = task
    void task.finally(() => {
      if (this.#queueDispatch !== task) return
      this.#queueDispatch = undefined
      if (!this.#state.session.isStreaming && this.#hasDispatchableIdleHead()) queueMicrotask(() => this.#drainQueue())
    })
  }

  async #drainSteeringHead(): Promise<void> {
    const { queue, session, connection } = this.#state
    if (queue.paused || queue.dispatchingId || !session.isStreaming || connection !== 'connected' || this.#compactionHold) return
    const item = queueLaneHead(queue.items, 'steer')
    if (!item || item.paused) return
    const control = queuedInputControl(item)
    if (control && control.kind !== 'fabric-prewalk' && control.kind !== 'fabric-await') return
    this.#patch({ queue: { ...queue, dispatchingId: item.id } })
    if (control?.kind === 'fabric-prewalk' || control?.kind === 'fabric-await') {
      await this.#startFabricQueueControl(item, control, true)
      return
    }
    const command = item.images.length === 0 ? parseBuiltinSlashCommand(item.text) : undefined
    try {
      const accepted = command
        ? await this.#runBuiltinSlashCommand(command, true, item)
        : await this.#transport.request({
            type: 'prompt',
            message: item.text,
            ...(item.images.length > 0 ? { images: item.images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
            streamingBehavior: 'steer',
          }).then(() => true)
      if (!accepted) throw new Error('Pi did not accept the queued steering row')
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((candidate) => candidate.id !== item.id),
          steering: command ? this.#state.queue.steering : [...this.#state.queue.steering, item.text || 'Image attachment'],
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#failQueueDispatch(error)
    }
  }

  #drainQueue(): void {
    if (this.#queueDispatch) return
    const task = this.#drainQueueHead()
    this.#queueDispatch = task
    void task.finally(() => {
      if (this.#queueDispatch !== task) return
      this.#queueDispatch = undefined
      if (!this.#state.session.isStreaming && this.#hasDispatchableIdleHead()) queueMicrotask(() => this.#drainQueue())
    })
  }

  async #drainQueueHead(): Promise<void> {
    const { queue, session, connection } = this.#state
    if (queue.paused || queue.dispatchingId || session.isStreaming || connection !== 'connected' || this.#compactionHold) return
    const steerHead = queueLaneHead(queue.items, 'steer')
    const followUpHead = queueLaneHead(queue.items, 'followUp')
    const item = steerHead && !steerHead.paused ? steerHead : followUpHead && !followUpHead.paused ? followUpHead : undefined
    if (!item) return
    this.#patch({ queue: { ...queue, dispatchingId: item.id } })
    const control = queuedInputControl(item)
    if (control?.kind === 'fabric-prewalk' || control?.kind === 'fabric-await') {
      await this.#startFabricQueueControl(item, control, false)
      return
    }
    const command = item.images.length === 0 ? parseBuiltinSlashCommand(item.text) : undefined
    const accepted = command
      ? await this.#runBuiltinSlashCommand(command, true, item)
      : await this.#sendPrompt(item.text, item.images, false)
    if (!accepted) {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error', dispatchingId: undefined } })
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.filter((candidate) => candidate.id !== item.id),
        dispatchingId: undefined,
      },
    })
    if (!command && item.text.startsWith('/')) this.#scheduleRefresh(true)
  }

  #hasDispatchableIdleHead(): boolean {
    const { queue, connection } = this.#state
    if (queue.paused || queue.dispatchingId || this.#state.session.isStreaming || connection !== 'connected' || this.#compactionHold) return false
    return [queueLaneHead(queue.items, 'steer'), queueLaneHead(queue.items, 'followUp')]
      .some((item) => item !== undefined && !item.paused)
  }

  async #startFabricQueueControl(item: QueuedInput, control: Extract<QueuedControl, { kind: 'fabric-prewalk' | 'fabric-await' }>, steering: boolean): Promise<void> {
    const activity = control.kind === 'fabric-prewalk' ? 'fabric-prewalk' : 'fabric-await'
    const note = control.kind === 'fabric-prewalk'
      ? 'Arming Fabric prewalk…'
      : control.peer ? `Waiting for ${control.peer} to settle…` : 'Waiting for Fabric peers to settle…'
    this.#patch({ queue: { ...this.#state.queue, blockingActivity: activity, blockingNote: note } })
    try {
      await this.#transport.request({
        type: 'prompt',
        message: encodeFabricBridgeRequest(control.kind === 'fabric-prewalk'
          ? { action: 'prewalk', requestId: item.id }
          : { action: 'await', requestId: item.id, ...(control.peer ? { peer: control.peer } : {}) }),
        ...(steering ? { streamingBehavior: 'steer' as const } : {}),
      })
    } catch (error) {
      if (this.#state.queue.dispatchingId === item.id) this.#failQueueDispatch(error)
    }
  }

  #failQueueDispatch(error: unknown): void {
    this.#patch({
      queue: {
        ...this.#state.queue,
        paused: true,
        pauseReason: 'error',
        dispatchingId: undefined,
        blockingActivity: undefined,
        blockingNote: undefined,
      },
    })
    this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
  }

  async #runBuiltinSlashCommand(command: ParsedBuiltinSlashCommand, queued: boolean, queuedItem?: QueuedInput): Promise<boolean> {
    try {
      switch (command.name) {
        case 'settings':
          this.#requestUi({ kind: 'settings' })
          return true
        case 'model': {
          if (!command.argument) {
            this.#requestUi({ kind: 'model' })
            return true
          }
          const target = resolveModelReference(this.#state.models, command.argument)
          if (!target) {
            this.#setState((state) => addNotice(state, 'warning', 'Use /model provider/model or choose a model from the picker'))
            return false
          }
          await this.#transport.request({ type: 'set_model', ...target })
          await this.#bootstrap(false)
          return true
        }
        case 'thinking': {
          const level = command.argument as ThinkingLevel
          if (!command.argument) {
            this.#requestUi({ kind: 'thinking' })
            return true
          }
          if (!this.#state.thinkingLevels.includes(level)) {
            this.#setState((state) => addNotice(state, 'warning', `Unsupported thinking level: ${command.argument}`))
            return false
          }
          await this.#transport.request({ type: 'set_thinking_level', level })
          await this.#bootstrap(false)
          return true
        }
        case 'export': {
          const outputPath = parsePathArgument(command.argument)
          if (command.argument && !outputPath) {
            this.#setState((state) => addNotice(state, 'warning', 'Usage: /export [file.html]'))
            return false
          }
          if (outputPath?.toLowerCase().endsWith('.jsonl')) {
            this.#setState((state) => addNotice(state, 'warning', 'Pi RPC only exposes HTML export; JSONL branch export remains interactive-only'))
            return true
          }
          const data = await this.#transport.request<{ path?: string }>({ type: 'export_html', ...(outputPath ? { outputPath } : {}) })
          this.#setState((state) => addNotice(state, 'info', data?.path ? `Exported session to ${data.path}` : 'Session exported'))
          return true
        }
        case 'copy': {
          const data = await this.#transport.request<{ text?: string | null }>({ type: 'get_last_assistant_text' })
          if (!data?.text) {
            this.#setState((state) => addNotice(state, 'warning', 'No assistant message to copy yet'))
            return true
          }
          this.#requestUi({ kind: 'copy', text: data.text })
          return true
        }
        case 'name': {
          if (!command.argument) {
            const currentName = this.#state.session.sessionName
            this.#setState((state) => addNotice(state, currentName ? 'info' : 'warning', currentName ? `Session name: ${currentName}` : 'Usage: /name <name>'))
            return true
          }
          await this.#transport.request({ type: 'set_session_name', name: command.argument })
          this.#patch({ session: { ...this.#state.session, sessionName: command.argument } })
          void this.refreshSessions()
          this.#setState((state) => addNotice(state, 'info', `Session name set: ${command.argument}`))
          return true
        }
        case 'session': {
          const stats = await this.#transport.request<PiSessionStats>({ type: 'get_session_stats' })
          this.#patch({ stats })
          this.#setState((state) => addNotice(state, 'info', formatSessionNotice(this.#state.session, stats)))
          return true
        }
        case 'tree':
          await this.openSessionTree({ preserveQueue: queued })
          return true
        case 'fork': {
          const messages = this.#state.forkMessages
          if (messages.length === 0) {
            this.#setState((state) => addNotice(state, 'warning', 'No user messages are available to fork'))
            return true
          }
          const options = messages.map((message, index) => `${index + 1}. ${compactCommandText(message.text)}`)
          const entryIds = new Map(options.map((option, index) => [option, messages[index]!.entryId]))
          this.#dialogs.showLocalSelect('Fork from a previous message', options, (response) => {
            const entryId = response.value ? entryIds.get(response.value) : undefined
            if (entryId) void this.forkFrom(entryId, { preserveQueue: queued })
          })
          return true
        }
        case 'clone': {
          const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'clone' })
          if (result.cancelled) return false
          this.#historyPager = undefined
          this.#patch({ notices: [], statusLines: [], queue: queued ? { ...this.#state.queue, steering: [], followUp: [] } : createQueueState() })
          await this.#bootstrap(false, { anchorLeaf: true })
          this.#setState((state) => addNotice(state, 'info', 'Cloned thread into a new Pi session'))
          return true
        }
        case 'new': {
          this.#sessionTransitionDepth += 1
          try {
            this.#dialogs.cancelAll()
            const parentSession = queuedItem
              ? queuedItem.flow?.phase === 'new-session'
                ? queuedItem.flow.taskIndex > 0 ? this.#state.session.sessionFile : undefined
                : this.#state.session.sessionFile
              : undefined
            const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session', ...(parentSession ? { parentSession } : {}) })
            if (result.cancelled) return false
            this.#historyPager = undefined
            this.#patch({
              messages: [],
              messagesHasOlder: false,
              messagesLoadingEarlier: false,
              forkMessages: [],
              liveAssistant: undefined,
              liveTools: [],
              editorText: '',
              editorImages: [],
              notices: [],
              statusLines: [],
              statusItems: {},
              widgets: {},
              dialog: undefined,
              dialogQueue: [],
              uiRequest: undefined,
              questionnaireSubmitting: undefined,
              questionnaireCollapsed: undefined,
              queue: queued ? { ...this.#state.queue, steering: [], followUp: [] } : createQueueState(),
            })
            await this.#bootstrap(false)
            return true
          } finally {
            this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
          }
        }
        case 'compact': {
          this.#patch({ activity: 'Compacting context' })
          const result = await this.#transport.request({ type: 'compact', ...(command.argument ? { customInstructions: command.argument } : {}) })
          await this.#refreshStats()
          await this.#refreshMessages()
          this.#appendCompactionMessage(result)
          this.#setState((state) => addNotice({ ...state, activity: 'Ready' }, 'info', 'Context compacted'))
          return true
        }
        case 'resume':
          await this.refreshSessions()
          this.#requestUi({ kind: 'sessions' })
          return true
        case 'reload': {
          const sessionFile = this.#state.session.sessionFile
          if (!sessionFile) {
            this.#setState((state) => addNotice(state, 'warning', '/reload requires a persisted Pi session'))
            return false
          }
          this.#connecting = true
          try {
            this.#started = false
            this.#patch({ queue: { ...this.#state.queue, steering: [], followUp: [] } })
            await this.#transport.stop()
            await this.#transport.start()
            this.#started = true
            // Pi reloads the file, so its leaf is the file tip again.
            this.#clearSessionLeafAnchor()
            const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'switch_session', sessionPath: sessionFile })
            if (result.cancelled) {
              await this.#bootstrap(false)
              return false
            }
            await this.#bootstrap(false)
          } finally {
            this.#connecting = false
          }
          return true
        }
        case 'quit':
          this.#requestUi({ kind: 'quit' })
          return true
        case 'scoped-models':
        case 'import':
        case 'share':
        case 'changelog':
        case 'hotkeys':
        case 'trust':
        case 'login':
        case 'logout':
          this.#setState((state) => addNotice(state, 'warning', interactiveOnlyCommandMessage(command.name)))
          return true
      }
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return false
    }
  }

  #requestUi(request: { kind: 'settings' | 'sessions' | 'model' | 'thinking' | 'quit' } | { kind: 'copy'; text: string }): void {
    const uiRequest = { id: ++this.#nextUiRequestId, ...request } as WorkbenchUiRequest
    this.#patch({ uiRequest })
  }

  async #bootstrap(includeModels: boolean, { anchorLeaf = false }: { anchorLeaf?: boolean } = {}): Promise<void> {
    const generation = ++this.#bootstrapGeneration
    const transcriptGeneration = ++this.#transcriptRefreshGeneration
    const streamRevision = this.#streamRevision
    const reportedSession = await this.#transport.request<PiSessionState>({ type: 'get_state' })
    if (this.#disposed || generation !== this.#bootstrapGeneration) return
    this.#rememberActiveSessionTransport(reportedSession.sessionFile)

    const streamUnchanged = streamRevision === this.#streamRevision
    const session = streamUnchanged
      ? reportedSession
      : { ...reportedSession, isStreaming: this.#state.session.isStreaming }
    // get_tree is O(session size) in Pi and a background request would stall Pi's
    // serial command loop (seconds on large threads), so the tree is fetched only when
    // tree navigation is opened. Drop any tree cached for a different session.
    if ((session.sessionFile ?? '') !== (this.#state.session.sessionFile ?? '')) this.#sessionTree = undefined
    this.#reconnectAttempts = 0
    this.#patch({
      connection: 'connected',
      connectionMessage: 'Connected',
      session,
      activity: session.isStreaming ? 'Working' : 'Ready',
      ...(streamUnchanged && !reportedSession.isStreaming
        ? {
            liveAssistant: undefined,
            liveTools: this.#state.liveTools.length > 0 ? [] : this.#state.liveTools,
          }
        : {}),
    })

    const current = () => !this.#disposed && generation === this.#bootstrapGeneration
    // Changing sessionFile clears the previous anchor; capture the new harness leaf after
    // that change, including fork/clone results whose persisted tip may be another branch.
    if (anchorLeaf) await this.#captureSessionLeafAnchor(session.sessionFile)
    if (!current()) return
    const transcriptCurrent = () => current()
      && transcriptGeneration === this.#transcriptRefreshGeneration
      && streamRevision === this.#streamRevision
    const transcript = this.#loadInitialTranscript(session).then(({ page, pager }) => {
      if (!transcriptCurrent()) return
      this.#historyPager = pager
      this.#patch({
        messages: page.messages,
        messagesHasOlder: page.hasOlder,
        messagesLoadingEarlier: false,
        ...reconcileLiveTranscript(this.#state, page.messages),
      })
    }).catch(() => {
      if (transcriptCurrent()) this.#patch({ messagesLoadingEarlier: false })
    })

    const metadata = Promise.allSettled([
      includeModels
        ? this.#transport.request<{ models: PiModel[] }>({ type: 'get_available_models' })
        : Promise.resolve({ models: this.#state.models }),
      this.#getThinkingLevels(),
      this.#transport.request<PiSessionStats>({ type: 'get_session_stats' }),
      this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
      this.#transport.request<{ commands: RpcSlashCommand[] }>({ type: 'get_commands' }),
    ]).then(([modelsResult, levelsResult, statsResult, forkMessagesResult, commandsResult]) => {
      if (!current()) return
      this.#patch({
        forkMessages: forkMessagesResult.status === 'fulfilled' ? forkMessagesFrom(forkMessagesResult.value) : this.#state.forkMessages,
        models: modelsResult.status === 'fulfilled' ? modelsResult.value.models : this.#state.models,
        thinkingLevels: levelsResult.status === 'fulfilled' ? levelsResult.value : this.#state.thinkingLevels,
        stats: statsResult.status === 'fulfilled' ? statsResult.value : this.#state.stats,
        commands: commandsResult.status === 'fulfilled' ? slashCommandsFromRpc(commandsResult.value) : this.#state.commands,
      })
    })

    await Promise.all([transcript, metadata])
    if (!current()) return
    void this.refreshWorkspaceDiff()
    if (!this.#state.session.isStreaming) {
      queueMicrotask(() => {
        if (current() && !this.#state.session.isStreaming) this.#drainQueue()
      })
    }
  }

  async #loadInitialTranscript(session: PiSessionState): Promise<{ page: SessionHistoryPage; pager: PiSessionHistoryPager | undefined }> {
    if (session.sessionFile) {
      const pager = new PiSessionHistoryPager(session.sessionFile, await this.#activeLeafAnchor(session.sessionFile))
      try {
        const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
        return { page, pager }
      } catch {
        // Fall through to RPC for unsaved, unavailable, or legacy sessions.
      }
    }
    const result = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
    return { page: { messages: result.messages, hasOlder: false }, pager: undefined }
  }

  async #requestSessionTree(): Promise<PiSessionTree> {
    const sessionTree = (await this.#tryRequestSessionTree()) ?? this.#sessionTree
    if (!sessionTree) throw new Error('This Pi version does not expose session tree navigation to RPC clients')
    this.#sessionTree = sessionTree
    return sessionTree
  }

  /**
   * Read Pi's active leaf for a transcript that in-memory navigation moved away from the
   * file tip. The anchor only holds while the same session stays loaded: a different file
   * or a grown one means Pi's leaf is the file tip again.
   */
  async #activeLeafAnchor(sessionFile: string | undefined): Promise<string | null | undefined> {
    if (sessionFile === undefined || this.#sessionLeafId === undefined) return undefined
    if (this.#sessionLeafAnchorFile !== sessionFile) return undefined
    const size = await sessionFileSize(sessionFile)
    if (size === undefined || size !== this.#sessionLeafAnchorSize) {
      this.#clearSessionLeafAnchor()
      return undefined
    }
    return this.#sessionLeafId
  }

  #clearSessionLeafAnchor(): void {
    this.#sessionLeafId = undefined
    this.#sessionLeafAnchorFile = undefined
    this.#sessionLeafAnchorSize = undefined
  }

  async #captureSessionLeafAnchor(sessionFile: string | undefined): Promise<void> {
    if (sessionFile === undefined) {
      this.#clearSessionLeafAnchor()
      return
    }
    const size = await sessionFileSize(sessionFile)
    try {
      const tree = await this.#requestSessionTree()
      this.#sessionLeafId = tree.leafId
    } catch {
      this.#clearSessionLeafAnchor()
      return
    }
    this.#sessionLeafAnchorFile = sessionFile
    this.#sessionLeafAnchorSize = size
  }

  /** One get_tree at a time: it is O(session size) in Pi, so callers must share the result. */
  async #tryRequestSessionTree(): Promise<PiSessionTree | undefined> {
    if (this.#sessionTreeRequest) return this.#sessionTreeRequest
    const request = this.#transport.request({ type: 'get_tree' })
      .then((value) => sessionTreeFrom(value))
      .catch(() => undefined)
      .finally(() => {
        if (this.#sessionTreeRequest === request) this.#sessionTreeRequest = undefined
      })
    this.#sessionTreeRequest = request
    return request
  }

  async #getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.#transport.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' })
    return data.levels
  }

  async #refreshMessages(): Promise<void> {
    const refreshGeneration = ++this.#transcriptRefreshGeneration
    const bootstrapGeneration = this.#bootstrapGeneration
    const streamRevision = this.#streamRevision
    const current = () => !this.#disposed
      && refreshGeneration === this.#transcriptRefreshGeneration
      && bootstrapGeneration === this.#bootstrapGeneration
      && streamRevision === this.#streamRevision
      && this.#sessionTransitionDepth === 0
    try {
      const sessionFile = this.#state.session.sessionFile
      const forkMessages = await this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' })
        .catch(() => ({ messages: this.#state.forkMessages }))
      if (!current()) return
      if (sessionFile) {
        const latestPager = new PiSessionHistoryPager(sessionFile, await this.#activeLeafAnchor(sessionFile))
        const page = await latestPager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
        if (!current()) return
        const merged = mergeTranscriptTail(this.#state.messages, page.messages)
        // A rewritten branch moves the head of the loaded window; the retained pager's
        // cursor would then follow the abandoned branch, so restart it from the new tail.
        const branchReset = this.#state.messages.length > 0
          && merged.length > 0
          && messageEntryId(merged[0]!) !== messageEntryId(this.#state.messages[0]!)
        const retainedPager = branchReset ? undefined : this.#historyPager
        if (!retainedPager) this.#historyPager = latestPager
        this.#patch({
          messages: merged,
          messagesHasOlder: retainedPager ? this.#state.messagesHasOlder : page.hasOlder,
          messagesLoadingEarlier: false,
          forkMessages: forkMessagesFrom(forkMessages),
          ...reconcileLiveTranscript(this.#state, page.messages),
        })
        return
      }
      const messages = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
      if (!current()) return
      this.#patch({
        messages: messages.messages,
        messagesHasOlder: false,
        messagesLoadingEarlier: false,
        forkMessages: forkMessagesFrom(forkMessages),
        ...reconcileLiveTranscript(this.#state, messages.messages),
      })
    } catch (error) {
      if (current()) this.#setState((state) => addNotice(state, 'warning', `Could not refresh transcript: ${errorMessage(error)}`))
    }
  }

  async #refreshStats(): Promise<void> {
    const bootstrapGeneration = this.#bootstrapGeneration
    try {
      const stats = await this.#transport.request<PiSessionStats>({ type: 'get_session_stats' })
      if (this.#disposed || this.#sessionTransitionDepth > 0 || bootstrapGeneration !== this.#bootstrapGeneration) return
      this.#patch({ stats })
    } catch {
      // Stats are supplementary; transcript operation should continue without them.
    }
  }

  #appendCompactionMessage(result: unknown): void {
    const message = compactionMessageFrom(result)
    if (!message) return
    if (this.#state.messages.some((candidate) => sameCompactionMessage(candidate, message))) return
    this.#patch({ messages: [...this.#state.messages, message] })
  }

  #scheduleRefresh(full: boolean): void {
    if (this.#sessionTransitionDepth > 0 || this.#disposed) return
    this.#refreshFull ||= full
    if (this.#refreshTimer) return
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      const refreshFull = this.#refreshFull
      this.#refreshFull = false
      void (refreshFull
        ? Promise.all([this.#bootstrap(false), this.refreshSessions(true)])
        : Promise.all([this.#refreshMessages(), this.#refreshStats()]))
        .catch((error) => {
          if (!this.#disposed) this.#setState((state) => addNotice(state, 'warning', `Could not refresh session: ${errorMessage(error)}`))
        })
    }, full ? 80 : 35)
  }

  #newFabricRequestId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.#nextFabricRequestId}`
  }

  async #requestFabricPeers(): Promise<FabricPeerCard[]> {
    const requestId = this.#newFabricRequestId('peers')
    return await new Promise<FabricPeerCard[]>((resolvePeers) => {
      let settled = false
      const finish = (peers: FabricPeerCard[]) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.#fabricPeerRequests.delete(requestId)
        resolvePeers(peers)
      }
      const timeout = setTimeout(() => finish([]), 3_000)
      this.#fabricPeerRequests.set(requestId, finish)
      void this.#transport.request({
        type: 'prompt',
        message: encodeFabricBridgeRequest({ action: 'peers', requestId }),
        ...(this.#state.session.isStreaming ? { streamingBehavior: 'steer' as const } : {}),
      }).catch((error) => {
        finish([])
        this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      })
    })
  }

  #handleFabricBridgeEvent(event: FabricBridgeEvent): void {
    if (event.event === 'ready') return
    if (event.event === 'peers') {
      this.#fabricPeerRequests.get(event.requestId)?.(event.peers)
      return
    }
    if (event.event === 'error' && event.activity === 'peers') {
      this.#fabricPeerRequests.get(event.requestId)?.([])
      this.#setState((state) => addNotice(state, 'warning', event.error))
      return
    }
    if (this.#state.queue.dispatchingId !== event.requestId) return
    if (event.event === 'started' || event.event === 'progress') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          blockingActivity: event.activity === 'prewalk' ? 'fabric-prewalk' : 'fabric-await',
          blockingNote: event.note,
        },
      })
      return
    }
    if (event.event === 'settled') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => item.id !== event.requestId),
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      if (!this.#state.session.isStreaming) this.#drainQueue()
      return
    }
    if (event.event === 'cancelled') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((item) => item.id !== event.requestId),
          paused: this.#state.queue.items.length > 1,
          pauseReason: this.#state.queue.items.length > 1 ? 'manual' : undefined,
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      return
    }
    if (event.event === 'error') {
      this.#patch({
        queue: {
          ...this.#state.queue,
          paused: true,
          pauseReason: 'error',
          dispatchingId: undefined,
          blockingActivity: undefined,
          blockingNote: undefined,
        },
      })
      this.#setState((state) => addNotice(state, 'error', event.error))
    }
  }

  #handleEvent(event: RpcRecord): void {
    if (this.#disposed) return
    if (event.type === 'agent_start' || event.type === 'agent_settled') this.#streamRevision += 1
    const fabricEvent = parseFabricBridgeEvent(event)
    if (fabricEvent) {
      this.#handleFabricBridgeEvent(fabricEvent)
      return
    }
    if (isExtensionUiRequest(event)) {
      this.#dialogs.handleExtensionUi(event, this.#sessionTransitionDepth > 0)
      return
    }
    this.#setState((state) => applyRpcEvent(state, event))
    if (event.type === 'compaction_start') this.#compactionHold = true
    if (event.type === 'compaction_end') {
      this.#compactionHold = false
      this.#appendCompactionMessage(event.result)
      if (this.#state.queue.pauseReason === 'error') this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
      if (!this.#state.session.isStreaming) this.#drainQueue()
      this.#scheduleRefresh(false)
    }
    if (event.type === 'turn_end' && healthyTurnBoundary(event)) this.#drainSteering()
    if (event.type === 'tool_execution_end') {
      const toolCallId = String(event.toolCallId ?? '')
      this.#dialogs.handleToolExecutionEnd(toolCallId)
      if (this.#pauseAfterTools && !this.#state.liveTools.some((tool) => tool.status !== 'complete')) {
        this.#pauseAfterTools = false
        void this.#transport.request({ type: 'abort' }).catch((error) => this.#setState((state) => addNotice(state, 'error', errorMessage(error))))
      }
    }
    const runOutcome = event.type === 'agent_end' && !event.willRetry ? agentEndOutcome(event) : 'unknown'
    if (runOutcome === 'failed') {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error' } })
    } else if (runOutcome === 'healthy' && this.#state.queue.pauseReason === 'error') {
      this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    }
    if (event.type === 'message_end' || event.type === 'tool_execution_end') this.#scheduleRefresh(false)
    if (event.type === 'agent_settled') {
      this.#scheduleRefresh(true)
      this.#drainQueue()
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed) return
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.#reconnectAttempts = 0
      this.#setState((state) => addNotice(state, 'error', 'Pi keeps disconnecting — automatic reconnection gave up. Press Reconnect to try again.'))
      return
    }
    this.#clearReconnectTimer()
    const attempt = ++this.#reconnectAttempts
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS)
    if (attempt === 1) {
      this.#setState((state) => addNotice(state, 'warning', 'Pi disconnected — reconnecting automatically…'))
    }
    this.#patch({ connectionMessage: `Reconnecting (attempt ${attempt})…` })
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.reconnect().catch(() => undefined)
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }

  #handleStatus(status: TransportStatus): void {
    if (status.state === 'starting') this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    if (status.state === 'running') this.#patch({ connectionMessage: `Pi process ${status.pid ?? ''}`.trim() })
    if (status.state === 'stopped' && !this.#connecting) this.#patch({ connection: 'idle', connectionMessage: 'Disconnected' })
    if (status.state === 'exited') {
      this.#started = false
      this.#patch({
        connection: 'error',
        connectionMessage: status.message,
        session: { ...this.#state.session, isStreaming: false },
        activity: 'Disconnected',
      })
      if (!this.#connecting) this.#scheduleReconnect()
    }
  }

  #patch(patch: Partial<WorkbenchState>): void {
    if ((Object.keys(patch) as (keyof WorkbenchState)[]).every((key) => this.#state[key] === patch[key])) return
    this.#setState((state) => ({ ...state, ...patch }))
  }

  #setState(update: (state: WorkbenchState) => WorkbenchState): void {
    const previous = this.#state
    const next = update(previous)
    if (next === previous) return
    this.#state = next
    // A loaded session owns its own leaf; a switch, new session or reload invalidates it.
    if (next.session.sessionFile !== previous.session.sessionFile) this.#clearSessionLeafAnchor()
    if (next.workspacePath !== previous.workspacePath && this.#unsubscribeCatalog) this.#watchSessionCatalog()
    if (next.queue !== previous.queue || next.workspacePath !== previous.workspacePath) this.#queueStore?.save(next.workspacePath, next.queue)
    if (next.threadLifecycle !== previous.threadLifecycle) this.#threadMetadataStore?.save(next.threadLifecycle)
    this.#notifier.notify(!liveFieldsOnlyChanged(previous, next))
  }
}

function resolveModelReference(models: readonly PiModel[], reference: string): { provider: string; modelId: string } | undefined {
  const separator = reference.indexOf('/')
  if (separator > 0 && separator < reference.length - 1) {
    return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) }
  }
  const normalized = reference.toLowerCase()
  const matches = models.filter((model) => model.id.toLowerCase() === normalized || model.name?.toLowerCase() === normalized)
  return matches.length === 1 ? { provider: matches[0]!.provider, modelId: matches[0]!.id } : undefined
}

function parsePathArgument(argument: string): string | undefined {
  if (!argument) return undefined
  const quote = argument[0]
  if (quote === '"' || quote === "'") {
    const closing = argument.indexOf(quote, 1)
    return closing > 0 ? argument.slice(1, closing) : undefined
  }
  return argument.split(/\s+/, 1)[0]
}

function compactCommandText(text: string): string {
  const compacted = text.replace(/\s+/g, ' ').trim()
  return compacted.length > 96 ? `${compacted.slice(0, 93)}…` : compacted
}

function formatSessionNotice(session: PiSessionState, stats: PiSessionStats): string {
  const parts = [
    session.sessionName ? `Name: ${session.sessionName}` : undefined,
    `ID: ${stats.sessionId ?? session.sessionId ?? 'unknown'}`,
    `Messages: ${stats.totalMessages ?? 0}`,
    `Tools: ${stats.toolCalls ?? 0}`,
    typeof stats.cost === 'number' ? `Cost: $${stats.cost.toFixed(3)}` : undefined,
    stats.sessionFile ?? session.sessionFile ?? 'In-memory session',
  ]
  return parts.filter((part): part is string => part !== undefined).join(' · ')
}

function interactiveOnlyCommandMessage(command: ParsedBuiltinSlashCommand['name']): string {
  if (command === 'scoped-models') return "Pi's scoped model editor is not exposed by RPC yet; all available models remain in Heddlework's picker"
  if (command === 'login' || command === 'logout') return `/${command} is interactive-only in Pi; authenticate with Pi in a terminal and reconnect Heddlework`
  if (command === 'trust') return "Pi's /trust flow is interactive-only; save trust in Pi or start Heddlework with an approved Pi configuration"
  if (command === 'import') return "Pi's /import flow is not exposed by RPC yet; use the session sidebar for existing sessions"
  if (command === 'share') return "Pi's /share flow is interactive-only and is not exposed by RPC"
  if (command === 'hotkeys') return "Pi's /hotkeys describes its terminal UI; Heddlework uses native desktop controls"
  if (command === 'changelog') return "Pi's /changelog view is interactive-only and is not exposed by RPC"
  return `/${command} is not available through Pi RPC`
}

async function sessionFileSize(path: string | undefined): Promise<number | undefined> {
  if (!path) return undefined
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

function messageEntryId(message: PiMessage): string | undefined {
  return typeof message.workbenchEntryId === 'string' ? message.workbenchEntryId : undefined
}

function compactionMessageFrom(value: unknown): PiMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary : undefined
  if (!summary) return undefined
  const tokensBefore = typeof record.tokensBefore === 'number' ? record.tokensBefore : undefined
  return {
    role: 'compaction',
    content: summary,
    display: true,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    timestamp: Date.now(),
  }
}

function sameCompactionMessage(candidate: PiMessage, message: PiMessage): boolean {
  return candidate.role === 'compaction'
    && contentText(candidate.content) === contentText(message.content)
    && candidate.tokensBefore === message.tokensBefore
}

/** Drop only live rows already represented by the authoritative transcript. Adapted from 0xCUB3/heddlework d196b0c. */
function reconcileLiveTranscript(
  state: WorkbenchState,
  messages: PiMessage[],
): Pick<WorkbenchState, 'liveAssistant' | 'liveTools'> {
  if (!state.session.isStreaming) {
    return {
      liveAssistant: undefined,
      liveTools: state.liveTools.length > 0 ? [] : state.liveTools,
    }
  }
  let liveAssistant = state.liveAssistant
  const completedTools = new Set<string>()
  for (const message of messages) {
    if (
      liveAssistant
      && message.role === 'assistant'
      && message.timestamp !== undefined
      && liveAssistant.id === `live-${message.timestamp}`
    ) {
      liveAssistant = undefined
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      completedTools.add(message.toolCallId)
    }
  }
  const remainingTools = state.liveTools.filter((tool) => (
    tool.status !== 'complete' || !completedTools.has(tool.id)
  ))
  return {
    liveAssistant,
    liveTools: remainingTools.length === state.liveTools.length ? state.liveTools : remainingTools,
  }
}

function mergeTranscriptTail(current: PiMessage[], latest: PiMessage[]): PiMessage[] {
  if (latest.length === 0) return current
  const latestIds = new Set(latest.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
  const overlap = current.findIndex((message) => latestIds.has(messageEntryId(message) ?? ''))
  const prefix = overlap >= 0 ? current.slice(0, overlap) : current.filter((message) => messageEntryId(message) !== undefined)
  const seen = new Set<string>()
  return [...prefix, ...latest].filter((message) => {
    const id = messageEntryId(message)
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function healthyTurnBoundary(event: RpcRecord): boolean {
  if (event.type !== 'turn_end' || !event.message || typeof event.message !== 'object') return false
  const stopReason = (event.message as { stopReason?: unknown }).stopReason
  return stopReason !== 'error' && stopReason !== 'aborted'
}

function agentEndOutcome(event: RpcRecord): 'healthy' | 'failed' | 'unknown' {
  if (!Array.isArray(event.messages)) return 'unknown'
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index]
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue
    const stopReason = (message as { stopReason?: unknown }).stopReason
    return stopReason === 'error' || stopReason === 'aborted' || stopReason === 'length' ? 'failed' : 'healthy'
  }
  return 'unknown'
}

function forkMessagesFrom(value: unknown): PiForkMessage[] {
  if (!value || typeof value !== 'object') return []
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is PiForkMessage => (
    Boolean(message)
    && typeof message === 'object'
    && typeof (message as { entryId?: unknown }).entryId === 'string'
    && typeof (message as { text?: unknown }).text === 'string'
  ))
}
