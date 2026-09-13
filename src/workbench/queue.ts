import { parseBuiltinSlashCommand, type BuiltinSlashCommandName } from '../pi/slash-commands.ts'
import type { ComposerImage } from '../pi/types.ts'
import type { FlowQueueMetadata } from '../flows/types.ts'

export type QueueLane = 'steer' | 'followUp'
export type QueuePauseReason = 'abort' | 'error' | 'manual' | 'recovery'
export type QueueBlockingActivity = 'fabric-prewalk' | 'fabric-await'

export type QueuedControl =
  | { kind: 'compact'; instructions?: string | undefined }
  | { kind: 'reload' }
  | { kind: 'new' }
  | { kind: 'model'; target?: string | undefined }
  | { kind: 'thinking'; level?: string | undefined }
  | { kind: 'fabric-prewalk' }
  | { kind: 'fabric-await'; peer?: string | undefined }
  | { kind: 'builtin'; name: BuiltinSlashCommandName; argument?: string | undefined }

export interface QueueInputDraft {
  text: string
  images?: readonly ComposerImage[] | undefined
  lane?: QueueLane | undefined
  paused?: boolean | undefined
  flow?: FlowQueueMetadata | undefined
}

export interface QueuedInput {
  id: string
  text: string
  images: ComposerImage[]
  createdAt: number
  lane?: QueueLane | undefined
  paused?: boolean | undefined
  flow?: FlowQueueMetadata | undefined
}

export interface WorkbenchQueueState {
  items: QueuedInput[]
  steering: string[]
  followUp: string[]
  paused: boolean
  pauseReason: QueuePauseReason | undefined
  dispatchingId: string | undefined
  blockingActivity: QueueBlockingActivity | undefined
  blockingNote: string | undefined
}

export function createQueueState(): WorkbenchQueueState {
  return {
    items: [],
    steering: [],
    followUp: [],
    paused: false,
    pauseReason: undefined,
    dispatchingId: undefined,
    blockingActivity: undefined,
    blockingNote: undefined,
  }
}

export function parseQueuedControl(text: string): QueuedControl | undefined {
  const trimmed = text.trim()
  if (trimmed === '/reload') return { kind: 'reload' }
  if (trimmed === '/new') return { kind: 'new' }
  if (trimmed === '/model') return { kind: 'model' }
  if (trimmed.startsWith('/model ')) {
    const target = trimmed.slice('/model '.length).trim()
    return { kind: 'model', ...(target ? { target } : {}) }
  }
  if (trimmed === '/thinking') return { kind: 'thinking' }
  if (trimmed.startsWith('/thinking ')) {
    const level = trimmed.slice('/thinking '.length).trim()
    return { kind: 'thinking', ...(level ? { level } : {}) }
  }
  if (/^\/fabric\s+prewalk$/.test(trimmed)) return { kind: 'fabric-prewalk' }
  const fabricAwait = /^\/fabric\s+await(?:\s+(\S+))?$/.exec(trimmed)
  if (fabricAwait) return { kind: 'fabric-await', ...(fabricAwait[1] ? { peer: fabricAwait[1] } : {}) }
  if (trimmed === '/compact') return { kind: 'compact' }
  if (trimmed.startsWith('/compact ')) {
    const instructions = trimmed.slice('/compact '.length).trim()
    return { kind: 'compact', ...(instructions ? { instructions } : {}) }
  }
  const builtin = parseBuiltinSlashCommand(trimmed)
  return builtin ? { kind: 'builtin', name: builtin.name, ...(builtin.argument ? { argument: builtin.argument } : {}) } : undefined
}

export function queuedInputControl(item: Pick<QueuedInput, 'text' | 'images'>): QueuedControl | undefined {
  return item.images.length === 0 ? parseQueuedControl(item.text) : undefined
}

export function queueLane(item: Pick<QueuedInput, 'lane'>): QueueLane {
  return item.lane === 'steer' ? 'steer' : 'followUp'
}

export function queueLaneItems(items: readonly QueuedInput[], lane: QueueLane): QueuedInput[] {
  return items.filter((item) => queueLane(item) === lane)
}

export function queueItemsInDeliveryOrder(items: readonly QueuedInput[]): QueuedInput[] {
  return [...queueLaneItems(items, 'steer'), ...queueLaneItems(items, 'followUp')]
}

export function queueLaneHead(items: readonly QueuedInput[], lane: QueueLane): QueuedInput | undefined {
  return items.find((item) => queueLane(item) === lane)
}

export function queueHasFlow(items: readonly QueuedInput[], runId: string): boolean {
  return items.some((item) => item.flow?.runId === runId)
}

export function moveQueuedInput(items: readonly QueuedInput[], id: string, targetIndex: number): QueuedInput[] {
  const ordered = queueItemsInDeliveryOrder(items)
  const item = ordered.find((candidate) => candidate.id === id)
  if (!item || ordered.length < 2) return [...items]
  const lane = queueLane(item)
  const laneItems = queueLaneItems(ordered, lane)
  const fromLaneIndex = laneItems.findIndex((candidate) => candidate.id === id)
  if (fromLaneIndex < 0 || laneItems.length < 2) return [...items]
  const boundedTarget = Math.max(0, Math.min(ordered.length - 1, targetIndex))
  const target = ordered[boundedTarget]
  let toLaneIndex = target && queueLane(target) === lane
    ? laneItems.findIndex((candidate) => candidate.id === target.id)
    : lane === 'steer' && boundedTarget >= laneItems.length
      ? laneItems.length - 1
      : 0
  toLaneIndex = Math.max(0, Math.min(laneItems.length - 1, toLaneIndex))
  if (fromLaneIndex === toLaneIndex) return [...items]
  const nextLane = [...laneItems]
  const [moved] = nextLane.splice(fromLaneIndex, 1)
  if (!moved) return [...items]
  nextLane.splice(toLaneIndex, 0, moved)
  const otherLane = queueLaneItems(ordered, lane === 'steer' ? 'followUp' : 'steer')
  return lane === 'steer' ? [...nextLane, ...otherLane] : [...otherLane, ...nextLane]
}

export function moveQueuedInputToLaneTail(items: readonly QueuedInput[], id: string, lane: QueueLane): QueuedInput[] {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) return [...items]
  const updated = { ...item, lane }
  const remaining = queueItemsInDeliveryOrder(items.filter((candidate) => candidate.id !== id))
  const steering = queueLaneItems(remaining, 'steer')
  const followUp = queueLaneItems(remaining, 'followUp')
  if (lane === 'steer') steering.push(updated)
  else followUp.push(updated)
  return [...steering, ...followUp]
}

export function queueSize(queue: WorkbenchQueueState): number {
  return queue.items.length + queue.steering.length + queue.followUp.length
}

export function serializeQueueState(queue: WorkbenchQueueState): Record<string, unknown> {
  return {
    items: queue.items,
    paused: queue.paused,
    ...(queue.pauseReason ? { pauseReason: queue.pauseReason } : {}),
    ...(queue.dispatchingId ? { dispatchingId: queue.dispatchingId } : {}),
  }
}

export function restoreQueueState(value: unknown): WorkbenchQueueState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createQueueState()
  const record = value as Record<string, unknown>
  const items = Array.isArray(record.items) ? record.items.flatMap(readQueuedInput) : []
  const wasDispatching = typeof record.dispatchingId === 'string' && items.some((item) => item.id === record.dispatchingId)
  const pauseReason = readPauseReason(record.pauseReason)
  return {
    items,
    steering: [],
    followUp: [],
    paused: wasDispatching || Boolean(record.paused),
    pauseReason: wasDispatching ? 'recovery' : pauseReason,
    dispatchingId: undefined,
    blockingActivity: undefined,
    blockingNote: undefined,
  }
}

function readQueuedInput(value: unknown): QueuedInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.createdAt !== 'number' || !Array.isArray(item.images)) return []
  const images = item.images.filter(isComposerImage)
  if (images.length !== item.images.length) return []
  const lane = item.lane === 'steer' || item.lane === 'followUp' ? item.lane : undefined
  const flow = readFlowMetadata(item.flow)
  return [{
    id: item.id,
    text: item.text,
    images,
    createdAt: item.createdAt,
    ...(lane ? { lane } : {}),
    ...(item.paused === true ? { paused: true } : {}),
    ...(flow ? { flow } : {}),
  }]
}

function isComposerImage(value: unknown): value is ComposerImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const image = value as Record<string, unknown>
  return image.type === 'image' && typeof image.id === 'string' && typeof image.data === 'string' && typeof image.mimeType === 'string' && typeof image.fileName === 'string' && typeof image.size === 'number'
}

function readFlowMetadata(value: unknown): FlowQueueMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const flow = value as Record<string, unknown>
  if (typeof flow.runId !== 'string' || typeof flow.taskId !== 'string' || typeof flow.title !== 'string') return undefined
  if (flow.mode !== 'sequential' && flow.mode !== 'parallel') return undefined
  if (flow.source !== 'manual' && flow.source !== 'scheduled') return undefined
  if (typeof flow.taskIndex !== 'number' || typeof flow.taskCount !== 'number') return undefined
  if (flow.phase !== 'new-session' && flow.phase !== 'set-model' && flow.phase !== 'set-name' && flow.phase !== 'prompt') return undefined
  return {
    runId: flow.runId,
    taskId: flow.taskId,
    title: flow.title,
    mode: flow.mode,
    source: flow.source,
    ...(typeof flow.scheduleId === 'string' ? { scheduleId: flow.scheduleId } : {}),
    taskIndex: flow.taskIndex,
    taskCount: flow.taskCount,
    phase: flow.phase,
  }
}

function readPauseReason(value: unknown): QueuePauseReason | undefined {
  return value === 'abort' || value === 'error' || value === 'manual' || value === 'recovery' ? value : undefined
}
