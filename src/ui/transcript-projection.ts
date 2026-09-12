import type { TimelineItem } from '../workbench/timeline.ts'

export type TraceTimelineItem = Extract<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' | 'notice' | 'assistant' | 'compaction' }>

export type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' | 'notice' | 'compaction' }> | {
  id: string
  kind: 'work-trace'
  items: TraceTimelineItem[]
  changedPaths: string[]
  identity: 'boundary' | 'terminal'
  boundaryId?: string
  revertEntryId?: string
}

export type TranscriptProjectionRow =
  | { id: string; kind: 'timeline-item'; item: Exclude<DisplayTimelineItem, { kind: 'work-trace' }> }
  | { id: string; kind: 'trace-header'; trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }> }
  | { id: string; kind: 'trace-entry'; traceId: string; item: Exclude<TraceTimelineItem, { kind: 'notice' }> }
  | { id: string; kind: 'trace-notices'; traceId: string; notices: Array<Extract<TraceTimelineItem, { kind: 'notice' }>> }
  | { id: string; kind: 'trace-files'; traceId: string; paths: string[] }
  | { id: string; kind: 'trace-continuation'; traceId: string; remaining: number }

export function isActiveTraceEntry(item: TraceTimelineItem): boolean {
  return item.kind === 'thinking' ? Boolean(item.streaming) : item.kind === 'tool' ? item.tool.status !== 'complete' : false
}

export function isCompactionWorkTrace(item: DisplayTimelineItem): boolean {
  return item.kind === 'work-trace'
    && item.items.some((entry) => entry.kind === 'compaction')
    && item.items.every((entry) => entry.kind === 'compaction' || entry.kind === 'notice')
}

export function groupWorkItems(items: TimelineItem[], isStreaming = false): DisplayTimelineItem[] {
  const absorbedAssistants = intermediateAssistantIds(items)
  const grouped: DisplayTimelineItem[] = []
  let boundaryId: string | undefined
  for (const item of items) {
    if (item.kind === 'compaction') {
      grouped.push({
        id: `work-trace-${item.id}`,
        kind: 'work-trace',
        items: [item],
        changedPaths: [],
        identity: 'terminal',
        ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}),
      })
      continue
    }
    if (!isTraceItem(item, absorbedAssistants)) {
      grouped.push(item)
      boundaryId = item.id
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'work-trace' && previous.items.every((entry) => entry.kind !== 'compaction')) {
      previous.items.push(item)
      if (item.kind !== 'notice') previous.id = `work-trace-${item.id}`
      if (item.revertEntryId) previous.revertEntryId = item.revertEntryId
      const path = changedPath(item)
      if (path && !previous.changedPaths.includes(path)) previous.changedPaths.push(path)
    } else {
      const path = changedPath(item)
      grouped.push({
        id: `work-trace-${item.id}`,
        kind: 'work-trace',
        items: [item],
        changedPaths: path ? [path] : [],
        identity: 'terminal',
        ...(boundaryId ? { boundaryId } : {}),
        ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}),
      })
    }
  }
  let lastUser = -1
  for (let index = 0; index < grouped.length; index += 1) {
    if (grouped[index]!.kind === 'user') lastUser = index
  }
  // `currentTurn` asks whether anything after `index` ends the turn. The previous
  // `grouped.slice(index + 1).every(...)` allocated a suffix array per boundary trace.
  const userAfter = new Array<boolean>(grouped.length + 1).fill(false)
  const settledAssistantAfter = new Array<boolean>(grouped.length + 1).fill(false)
  for (let index = grouped.length - 1; index >= 0; index -= 1) {
    const entry = grouped[index]!
    userAfter[index] = userAfter[index + 1]! || entry.kind === 'user'
    settledAssistantAfter[index] = settledAssistantAfter[index + 1]! || (entry.kind === 'assistant' && !entry.streaming)
  }

  for (let index = 0; index < grouped.length; index += 1) {
    const item = grouped[index]!
    if (item.kind !== 'work-trace' || !item.boundaryId || item.items.some((entry) => entry.kind === 'compaction')) continue
    const currentTurn = index > lastUser && !userAfter[index + 1]! && !settledAssistantAfter[index + 1]!
    if (!item.items.some(isActiveTraceEntry) && !(isStreaming && currentTurn)) continue
    item.id = `work-trace-after-${item.boundaryId}`
    item.identity = 'boundary'
  }
  return grouped
}

export function pendingWorkTraceId(items: readonly DisplayTimelineItem[], isStreaming: boolean): string | undefined {
  if (!isStreaming || liveWorkTraceId(items, isStreaming)) return undefined
  let lastUser = -1
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'user') lastUser = index
  }
  if (lastUser < 0) return undefined
  for (let index = lastUser + 1; index < items.length; index += 1) {
    const item = items[index]!
    if (item.kind === 'assistant' || item.kind === 'work-trace') return undefined
  }
  return `work-trace-after-${items[lastUser]!.id}`
}

export function emptyWorkTrace(id: string): Extract<DisplayTimelineItem, { kind: 'work-trace' }> {
  const boundaryId = id.startsWith('work-trace-after-') ? id.slice('work-trace-after-'.length) : id
  return { id, kind: 'work-trace', items: [], changedPaths: [], identity: 'boundary', boundaryId }
}

export function liveWorkTraceId(items: readonly DisplayTimelineItem[], isStreaming: boolean): string | undefined {
  let lastUser = -1
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'user') lastUser = index
  }
  for (let index = items.length - 1; index > lastUser; index -= 1) {
    const item = items[index]!
    if (item.kind === 'assistant') return undefined
    if (item.kind !== 'work-trace') continue
    if (isCompactionWorkTrace(item)) return undefined
    if (isStreaming) return item.id
    return undefined
  }
  return undefined
}

export function currentWorkWave(items: readonly TraceTimelineItem[]): {
  tools: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>
  preview: TraceTimelineItem | undefined
} {
  let start = 0
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'assistant') start = index + 1
  }
  const wave = items.slice(start)
  return {
    tools: wave.filter((item): item is Extract<TraceTimelineItem, { kind: 'tool' }> => item.kind === 'tool'),
    preview: wave.at(-1),
  }
}

export function projectTranscriptRows(items: DisplayTimelineItem[], expandedTraceIds: ReadonlySet<string>, traceLimits: ReadonlyMap<string, number>): TranscriptProjectionRow[] {
  const rows: TranscriptProjectionRow[] = []
  for (const item of items) {
    if (item.kind !== 'work-trace') {
      rows.push(reuseRow({ id: item.id, kind: 'timeline-item', item }))
      continue
    }
    rows.push(reuseRow({ id: item.id, kind: 'trace-header', trace: item }))
    if (expandedTraceIds.has(item.id)) {
      const limit = Math.min(item.items.length, Math.max(0, traceLimits.get(item.id) ?? item.items.length))
      const entries = item.items.slice(0, limit)
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (entry.kind !== 'notice') {
          rows.push(reuseRow({ id: `${item.id}:entry:${entry.id}`, kind: 'trace-entry', traceId: item.id, item: entry }))
          continue
        }
        const notices = [entry]
        while (entries[index + 1]?.kind === 'notice') {
          const next = entries[index + 1] as Extract<TraceTimelineItem, { kind: 'notice' }>
          const previous = notices.at(-1)!
          if (next.notice.createdAt - previous.notice.createdAt > 5_000) break
          notices.push(next)
          index += 1
        }
        rows.push(reuseRow({ id: `${item.id}:notices:${notices[0]!.id}`, kind: 'trace-notices', traceId: item.id, notices }))
      }
      if (limit < item.items.length) rows.push(reuseRow({ id: `${item.id}:continuation`, kind: 'trace-continuation', traceId: item.id, remaining: item.items.length - limit }))
    }
    if (item.changedPaths.length > 0) rows.push(reuseRow({ id: `${item.id}:files`, traceId: item.id, kind: 'trace-files', paths: item.changedPaths }))
  }
  rememberProjectedRows(rows)
  return rows
}

type WorkTrace = Extract<DisplayTimelineItem, { kind: 'work-trace' }>

/** Row objects are rebuilt on every render, but only the live turn changes.
 * Reuse the previous row when its backing data is unchanged so memoized row
 * components can skip settled history entirely. */
const ROW_IDENTITY_LIMIT = 2_048
const rowIdentity = new Map<string, TranscriptProjectionRow>()

function sameTraceContent(left: WorkTrace, right: WorkTrace): boolean {
  if (left === right) return true
  if (left.id !== right.id || left.identity !== right.identity || left.boundaryId !== right.boundaryId || left.revertEntryId !== right.revertEntryId) return false
  if (left.items.length !== right.items.length || left.changedPaths.length !== right.changedPaths.length) return false
  for (let index = 0; index < left.items.length; index += 1) {
    if (left.items[index] !== right.items[index]) return false
  }
  for (let index = 0; index < left.changedPaths.length; index += 1) {
    if (left.changedPaths[index] !== right.changedPaths[index]) return false
  }
  return true
}

function sameRowContent(previous: TranscriptProjectionRow, next: TranscriptProjectionRow): boolean {
  if (previous.kind !== next.kind) return false
  switch (next.kind) {
    case 'timeline-item':
      return (previous as Extract<TranscriptProjectionRow, { kind: 'timeline-item' }>).item === next.item
    case 'trace-header':
      return sameTraceContent((previous as Extract<TranscriptProjectionRow, { kind: 'trace-header' }>).trace, next.trace)
    case 'trace-entry':
      return (previous as Extract<TranscriptProjectionRow, { kind: 'trace-entry' }>).item === next.item
    case 'trace-notices': {
      const before = (previous as Extract<TranscriptProjectionRow, { kind: 'trace-notices' }>).notices
      if (before.length !== next.notices.length) return false
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] !== next.notices[index]) return false
      }
      return true
    }
    case 'trace-continuation':
      return (previous as Extract<TranscriptProjectionRow, { kind: 'trace-continuation' }>).remaining === next.remaining
    case 'trace-files':
      return (previous as Extract<TranscriptProjectionRow, { kind: 'trace-files' }>).paths === next.paths
  }
}

function reuseRow<T extends TranscriptProjectionRow>(row: T): T {
  const previous = rowIdentity.get(row.id)
  if (previous !== undefined && sameRowContent(previous, row)) return previous as T
  return row
}

function rememberProjectedRows(rows: readonly TranscriptProjectionRow[]): void {
  rowIdentity.clear()
  for (const row of rows) {
    if (rowIdentity.size >= ROW_IDENTITY_LIMIT) return
    rowIdentity.set(row.id, row)
  }
}

/** Test-facing: forget the reused row objects. */
export function resetRowIdentityCache(): void {
  rowIdentity.clear()
}

function isTraceItem(item: TimelineItem, absorbedAssistants: ReadonlySet<string>): item is TraceTimelineItem {
  if (item.kind === 'thinking' || item.kind === 'context-injection' || item.kind === 'tool' || item.kind === 'notice' || item.kind === 'compaction') return true
  return item.kind === 'assistant' && absorbedAssistants.has(item.id)
}

function intermediateAssistantIds(items: readonly TimelineItem[]): ReadonlySet<string> {
  const ids = new Set<string>()
  let pending: string[] = []
  const absorbPending = () => {
    for (const id of pending) ids.add(id)
    pending = []
  }
  for (const item of items) {
    if (item.kind === 'user') {
      pending = []
      continue
    }
    if (item.kind === 'assistant') {
      pending.push(item.id)
      continue
    }
    if (item.kind === 'tool') absorbPending()
  }
  return ids
}

function changedPath(item: TraceTimelineItem): string | undefined {
  if (item.kind !== 'tool' || (item.tool.name !== 'edit' && item.tool.name !== 'write')) return undefined
  const args = item.tool.args && typeof item.tool.args === 'object' ? item.tool.args as Record<string, unknown> : {}
  return typeof args.path === 'string' ? args.path : undefined
}
