import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { PiSessionTreeOption } from '../pi/session-tree.ts'
import { BUILTIN_SLASH_COMMANDS } from '../pi/slash-commands.ts'
import type { ComposerImage, PiForkMessage, PiMessage, PiModel, PiSessionState, PiSessionStats, RpcRecord, SlashCommand, ThinkingLevel } from '../pi/types.ts'
import { createQueueState, type WorkbenchQueueState } from './queue.ts'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'
export type NoticeKind = 'info' | 'warning' | 'error'

export interface Notice {
  id: number
  kind: NoticeKind
  message: string
  createdAt: number
  transcriptTurn?: number
  transcriptPosition?: number
}

/**
 * Pi renders an `info` notify through `showStatus`: a dim status line appended to the session
 * chat rather than a notification. Lines are turn-anchored so the transcript can place one after
 * the turn it describes; consecutive statuses for a turn update it instead of stacking.
 */
export interface StatusLine {
  id: number
  text: string
  createdAt: number
  /** Turn index of the line's position, or -1 to append at the transcript tail. */
  turn: number
}

export type ThreadPriority = 0 | 1 | 2 | 3 | 4

export interface ThreadLifecycle {
  settledAt?: number
  snoozedUntil?: number
  unsettledAt?: number
  readAt?: number
  priority?: ThreadPriority
  labels?: string[]
}

export interface WorkspaceDiffFile {
  path: string
  patch: string
  additions: number
  deletions: number
}

export interface WorkspaceDiff {
  status: 'idle' | 'loading' | 'ready' | 'error'
  branch: string
  files: WorkspaceDiffFile[]
  additions: number
  deletions: number
  error?: string
}

export interface LiveBlock {
  index: number
  kind: 'text' | 'thinking'
  text: string
}

export interface LiveAssistant {
  id: string
  blocks: LiveBlock[]
}

export interface ToolRun {
  id: string
  name: string
  args?: unknown | undefined
  argsText?: string | undefined
  output?: string | undefined
  details?: unknown | undefined
  status: 'preparing' | 'running' | 'complete'
  isError: boolean
}

export interface ExtensionDialog {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor' | 'tree'
  title: string
  message?: string
  options?: string[]
  treeOptions?: PiSessionTreeOption[]
  placeholder?: string
  prefill?: string
  timeout?: number
  createdAt: number
  deadlineAt?: number
}

export interface ExtensionWidget {
  key: string
  lines: string[]
  placement: 'aboveEditor' | 'belowEditor'
}

export type WorkbenchUiRequest =
  | { id: number; kind: 'settings' | 'sessions' | 'model' | 'thinking' | 'quit' }
  | { id: number; kind: 'copy'; text: string }

export interface WorkbenchState {
  workspacePath: string
  connection: ConnectionState
  connectionMessage: string
  session: PiSessionState
  models: PiModel[]
  thinkingLevels: ThinkingLevel[]
  messages: PiMessage[]
  messagesHasOlder: boolean
  messagesLoadingEarlier: boolean
  forkMessages: PiForkMessage[]
  sessions: PiSessionSummary[]
  sessionsLoading: boolean
  sessionsHasMore: boolean
  liveAssistant: LiveAssistant | undefined
  liveTools: ToolRun[]
  activity: string
  queue: WorkbenchQueueState
  stats: PiSessionStats | undefined
  notices: Notice[]
  statusLines: StatusLine[]
  threadLifecycle: Record<string, ThreadLifecycle>
  /** Live turn signal per session file, tracked from each session's own harness. */
  sessionActivity: Record<string, boolean>
  workspaceDiff: WorkspaceDiff
  statusItems: Record<string, string>
  widgets: Record<string, ExtensionWidget>
  dialog: ExtensionDialog | undefined
  dialogQueue: ExtensionDialog[]
  commands: SlashCommand[]
  uiRequest: WorkbenchUiRequest | undefined
  questionnaireSubmitting: string | undefined
  questionnaireCollapsed: string | undefined
  editorText: string
  editorImages: ComposerImage[]
  windowTitle: string
}

let noticeId = 0
let statusLineId = 0

export function createInitialState(workspacePath: string): WorkbenchState {
  return {
    workspacePath,
    connection: 'idle',
    connectionMessage: 'Not connected',
    session: { model: null, thinkingLevel: 'off', isStreaming: false },
    models: [],
    thinkingLevels: ['off'],
    messages: [],
    messagesHasOlder: false,
    messagesLoadingEarlier: false,
    forkMessages: [],
    sessions: [],
    sessionsLoading: false,
    sessionsHasMore: false,
    liveAssistant: undefined,
    liveTools: [],
    activity: 'Ready',
    queue: createQueueState(),
    notices: [],
    statusLines: [],
    threadLifecycle: {},
    sessionActivity: {},
    workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
    stats: undefined,
    statusItems: {},
    widgets: {},
    dialog: undefined,
    dialogQueue: [],
    commands: [...BUILTIN_SLASH_COMMANDS],
    uiRequest: undefined,
    questionnaireSubmitting: undefined,
    questionnaireCollapsed: undefined,
    editorText: '',
    editorImages: [],
    windowTitle: 'Heddlework',
  }
}

export function applyRpcEvent(state: WorkbenchState, event: RpcRecord): WorkbenchState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, session: { ...state.session, isStreaming: true }, activity: 'Working' }
    case 'agent_end':
      return event.willRetry ? { ...state, activity: 'Retrying' } : state
    case 'agent_settled':
      return { ...state, session: { ...state.session, isStreaming: false }, activity: 'Ready' }
    case 'turn_start':
      return { ...state, activity: 'Thinking' }
    case 'message_start':
      return beginMessage(state, event)
    case 'message_update':
      return updateMessage(state, event)
    case 'tool_execution_start':
      return updateTool(state, String(event.toolCallId ?? ''), (current) => ({
        id: String(event.toolCallId ?? current?.id ?? ''),
        name: String(event.toolName ?? current?.name ?? 'tool'),
        args: event.args ?? current?.args,
        output: current?.output,
        details: current?.details,
        status: 'running',
        isError: false,
      }))
    case 'tool_execution_update': {
      const partial = asRecord(event.partialResult)
      return updateTool(state, String(event.toolCallId ?? ''), (current) => ({
        id: String(event.toolCallId ?? current?.id ?? ''),
        name: String(event.toolName ?? current?.name ?? 'tool'),
        args: event.args ?? current?.args,
        output: contentText(partial.content),
        details: partial.details,
        status: 'running',
        isError: false,
      }))
    }
    case 'tool_execution_end': {
      const result = asRecord(event.result)
      return updateTool(state, String(event.toolCallId ?? ''), (current) => ({
        id: String(event.toolCallId ?? current?.id ?? ''),
        name: String(event.toolName ?? current?.name ?? 'tool'),
        args: current?.args,
        output: contentText(result.content),
        details: result.details,
        status: 'complete',
        isError: Boolean(event.isError),
      }))
    }
    case 'queue_update':
      return {
        ...state,
        queue: {
          ...state.queue,
          steering: stringArray(event.steering),
          followUp: stringArray(event.followUp),
        },
      }
    case 'compaction_start':
      return { ...state, activity: 'Compacting context' }
    case 'compaction_end':
      return { ...state, activity: 'Ready' }
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
      return { ...state, activity: 'Retrying' }
    case 'auto_retry_end':
    case 'summarization_retry_finished':
      return { ...state, activity: 'Ready' }
    case 'extension_error':
      return addNotice(state, 'error', String(event.error ?? event.message ?? 'A Pi extension failed'))
    case 'transport_parse_error':
      return addNotice(state, 'warning', 'Pi wrote a non-JSON line to its RPC stream')
    default:
      return state
  }
}

export function addNotice(state: WorkbenchState, kind: NoticeKind, message: string, transcriptPosition?: number): WorkbenchState {
  const notice: Notice = {
    id: ++noticeId,
    kind,
    message,
    createdAt: Date.now(),
    ...(transcriptPosition === undefined ? {} : { transcriptTurn: Math.max(0, currentTurn(state)), transcriptPosition }),
  }
  return { ...state, notices: [...state.notices, notice] }
}

/**
 * Pi's `showExtensionNotify` sends `info` notifies to `showStatus`, which appends a dim line to the
 * session chat and rewrites the previous line when statuses arrive back to back. Heddlework keeps
 * that line with the session instead of the notification ledger, and replaces the turn's line when
 * an extension re-reports the same turn (pi-tps corrects a turn once its cost is known).
 */
export function addStatusLine(state: WorkbenchState, text: string): WorkbenchState {
  const turn = currentTurn(state)
  const line: StatusLine = { id: ++statusLineId, text, createdAt: Date.now(), turn }
  const index = state.statusLines.findIndex((candidate) => candidate.turn === turn)
  return {
    ...state,
    statusLines: index === -1 ? [...state.statusLines, line] : state.statusLines.map((candidate, at) => (at === index ? line : candidate)),
  }
}

/**
 * Turn index of the newest loaded user message, -1 when no turn is loaded yet. Notices and
 * status lines share this anchor so both read the same turn numbering.
 */
function currentTurn(state: WorkbenchState): number {
  return state.messages.filter((message) => message.role === 'user').length - 1
}

function beginMessage(state: WorkbenchState, event: RpcRecord): WorkbenchState {
  const message = asRecord(event.message)
  if (message.role !== 'assistant') return state
  return {
    ...state,
    liveAssistant: {
      id: `live-${String(message.timestamp ?? Date.now())}`,
      blocks: initialLiveBlocks(message.content),
    },
  }
}

function updateMessage(state: WorkbenchState, event: RpcRecord): WorkbenchState {
  const delta = asRecord(event.assistantMessageEvent)
  const type = String(delta.type ?? '')
  const index = Number(delta.contentIndex ?? 0)
  if (type === 'text_delta' || type === 'thinking_delta') {
    const kind = type === 'text_delta' ? 'text' : 'thinking'
    const current = state.liveAssistant ?? { id: `live-${Date.now()}`, blocks: [] }
    const existing = current.blocks.find((block) => block.index === index)
    const block: LiveBlock = {
      index,
      kind,
      text: `${existing?.text ?? ''}${String(delta.delta ?? '')}`,
    }
    return {
      ...state,
      liveAssistant: {
        ...current,
        blocks: [...current.blocks.filter((candidate) => candidate.index !== index), block].sort((a, b) => a.index - b.index),
      },
    }
  }
  if (type === 'toolcall_start') {
    return updateTool(state, String(delta.id ?? `tool-${index}`), (current) => ({
      id: String(delta.id ?? current?.id ?? `tool-${index}`),
      name: String(delta.toolName ?? current?.name ?? 'tool'),
      argsText: current?.argsText ?? '',
      status: 'preparing',
      isError: false,
    }))
  }
  if (type === 'toolcall_delta') {
    const toolId = String(delta.id ?? state.liveTools.at(-1)?.id ?? `tool-${index}`)
    return updateTool(state, toolId, (current) => ({
      id: toolId,
      name: String(delta.toolName ?? current?.name ?? 'tool'),
      args: current?.args,
      argsText: `${current?.argsText ?? ''}${String(delta.delta ?? '')}`,
      output: current?.output,
      details: current?.details,
      status: current?.status ?? 'preparing',
      isError: current?.isError ?? false,
    }))
  }
  if (type === 'toolcall_end') {
    const call = asRecord(delta.toolCall)
    const toolId = String(call.id ?? delta.id ?? state.liveTools.at(-1)?.id ?? `tool-${index}`)
    return updateTool(state, toolId, (current) => ({
      id: toolId,
      name: String(call.name ?? delta.toolName ?? current?.name ?? 'tool'),
      args: call.arguments ?? current?.args,
      argsText: current?.argsText,
      output: current?.output,
      details: current?.details,
      status: current?.status ?? 'preparing',
      isError: current?.isError ?? false,
    }))
  }
  return state
}

function updateTool(state: WorkbenchState, id: string, update: (current: ToolRun | undefined) => ToolRun): WorkbenchState {
  if (!id) return state
  const current = state.liveTools.find((tool) => tool.id === id)
  const next = update(current)
  const tools = current
    ? state.liveTools.map((tool) => (tool.id === id ? next : tool))
    : [...state.liveTools, next]
  return { ...state, liveTools: tools }
}

function initialLiveBlocks(value: unknown): LiveBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: LiveBlock[] = []
  value.forEach((candidate, index) => {
    const block = asRecord(candidate)
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ index, kind: 'text', text: block.text })
    if (block.type === 'thinking' && typeof block.thinking === 'string') blocks.push({ index, kind: 'thinking', text: block.thinking })
  })
  return blocks
}

export function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((candidate) => {
      const block = asRecord(candidate)
      if (typeof block.text === 'string') return block.text
      if (typeof block.thinking === 'string') return block.thinking
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}
