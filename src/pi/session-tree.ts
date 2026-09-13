import type { PiMessage } from './types.ts'

export interface PiSessionEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string | number | undefined
  message?: PiMessage | undefined
  content?: PiMessage['content'] | undefined
  summary?: string | undefined
  customType?: string | undefined
  command?: string | undefined
  [key: string]: unknown
}

export interface PiSessionTreeNode {
  entry: PiSessionEntry
  children: PiSessionTreeNode[]
  label?: string | undefined
  labelTimestamp?: string | number | undefined
}

export interface PiSessionTree {
  tree: PiSessionTreeNode[]
  leafId: string | null
}

export type PiSessionTreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'assistant-only' | 'labeled-only' | 'all'
export type PiSessionTreeEntryKind = 'user' | 'assistant' | 'tool' | 'context' | 'summary' | 'metadata'

export const PI_SESSION_TREE_FILTER_MODES: readonly PiSessionTreeFilterMode[] = ['default', 'no-tools', 'user-only', 'assistant-only', 'labeled-only', 'all']

export interface PiSessionTreeOption {
  entryId: string
  parentEntryId: string | null
  title: string
  detail: string
  entryType: string
  kind: PiSessionTreeEntryKind
  settings: boolean
  toolResult: boolean
  label?: string | undefined
  labelTimestamp?: string | number | undefined
  active: boolean
  onActivePath: boolean
}

export interface PiSessionTreeRow extends PiSessionTreeOption {
  depth: number
  guides: number[]
  connection: 'root' | 'chain' | 'branch'
  hasChildren: boolean
}

export function sessionTreeFrom(value: unknown): PiSessionTree | undefined {
  const record = asRecord(value)
  if (!Array.isArray(record.tree) || (record.leafId !== null && typeof record.leafId !== 'string')) return undefined
  return {
    tree: treeNodesFrom(record.tree),
    leafId: record.leafId,
  }
}

export function sessionTreeOptions(sessionTree: PiSessionTree): PiSessionTreeOption[] {
  const entries = new Map<string, PiSessionEntry>()
  visitNodes(sessionTree.tree, (node) => entries.set(node.entry.id, node.entry))

  const activePath = new Set<string>()
  let pathCursor: string | null | undefined = sessionTree.leafId
  while (pathCursor !== null && pathCursor !== undefined && !activePath.has(pathCursor)) {
    activePath.add(pathCursor)
    pathCursor = entries.get(pathCursor)?.parentId
  }

  let activeDisplayId = sessionTree.leafId
  const activeDisplayVisited = new Set<string>()
  while (activeDisplayId && !entryDisplay(entries.get(activeDisplayId), activeDisplayId === sessionTree.leafId) && !activeDisplayVisited.has(activeDisplayId)) {
    activeDisplayVisited.add(activeDisplayId)
    activeDisplayId = entries.get(activeDisplayId)?.parentId ?? null
  }

  const options: PiSessionTreeOption[] = []
  const stack = [...sessionTree.tree].reverse().map((node) => ({ node, parentEntryId: null as string | null }))
  while (stack.length > 0) {
    const current = stack.pop()!
    const display = entryDisplay(current.node.entry, current.node.entry.id === activeDisplayId)
    const parentEntryId = display ? current.node.entry.id : current.parentEntryId
    if (display) {
      options.push({
        entryId: current.node.entry.id,
        parentEntryId: current.parentEntryId,
        title: display.title,
        detail: display.detail,
        entryType: current.node.entry.type,
        kind: display.kind,
        settings: display.settings,
        toolResult: display.toolResult,
        ...(current.node.label ? { label: compactText(current.node.label, 32) } : {}),
        ...(current.node.labelTimestamp !== undefined ? { labelTimestamp: current.node.labelTimestamp } : {}),
        active: current.node.entry.id === activeDisplayId,
        onActivePath: activePath.has(current.node.entry.id),
      })
    }
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index]!, parentEntryId })
    }
  }
  return options
}

export function cycleSessionTreeFilterMode(mode: PiSessionTreeFilterMode, direction: 1 | -1): PiSessionTreeFilterMode {
  const index = PI_SESSION_TREE_FILTER_MODES.indexOf(mode)
  return PI_SESSION_TREE_FILTER_MODES[(index + direction + PI_SESSION_TREE_FILTER_MODES.length) % PI_SESSION_TREE_FILTER_MODES.length]!
}

export function sessionTreeFilterLabel(mode: PiSessionTreeFilterMode): string {
  if (mode === 'no-tools') return 'No tools'
  if (mode === 'user-only') return 'User'
  if (mode === 'assistant-only') return 'Assistant'
  if (mode === 'labeled-only') return 'Labeled'
  if (mode === 'all') return 'All'
  return 'Default'
}

function sessionTreeOptionMatchesFilter(option: PiSessionTreeOption, mode: PiSessionTreeFilterMode): boolean {
  if (mode === 'user-only') return option.kind === 'user'
  if (mode === 'assistant-only') return option.kind === 'assistant'
  if (mode === 'no-tools') return !option.settings && !option.toolResult
  if (mode === 'labeled-only') return option.label !== undefined
  if (mode === 'all') return true
  return !option.settings
}

export function layoutSessionTreeOptions(options: readonly PiSessionTreeOption[], query = '', filterMode: PiSessionTreeFilterMode = 'default'): PiSessionTreeRow[] {
  const terms = normalizeSearch(query).split(' ').filter(Boolean)
  const projected = options.filter((option) => sessionTreeOptionMatchesFilter(option, filterMode))
  const visible = terms.length === 0
    ? projected
    : projected.filter((option) => {
      const haystack = normalizeSearch(`${option.title} ${option.detail} ${option.label ?? ''} ${option.entryType} ${option.kind} ${option.active ? 'active current' : ''}`)
      return terms.every((term) => haystack.includes(term))
    })
  if (visible.length === 0) return []

  const allById = new Map(options.map((option) => [option.entryId, option]))
  const visibleIds = new Set(visible.map((option) => option.entryId))
  const children = new Map<string | null, PiSessionTreeOption[]>()
  const originalOrder = new Map(options.map((option, index) => [option.entryId, index]))
  const nearestVisibleParent = (option: PiSessionTreeOption): string | null => {
    let cursor = option.parentEntryId
    const visited = new Set<string>()
    while (cursor !== null && !visibleIds.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor)
      cursor = allById.get(cursor)?.parentEntryId ?? null
    }
    return cursor !== null && visibleIds.has(cursor) ? cursor : null
  }

  for (const option of visible) {
    const parentId = nearestVisibleParent(option)
    const siblings = children.get(parentId) ?? []
    siblings.push(option)
    children.set(parentId, siblings)
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => Number(left.onActivePath) - Number(right.onActivePath)
      || (originalOrder.get(left.entryId) ?? 0) - (originalOrder.get(right.entryId) ?? 0))
  }

  interface PendingRow {
    option: PiSessionTreeOption
    depth: number
    guides: number[]
    connection: PiSessionTreeRow['connection']
  }

  const rows: PiSessionTreeRow[] = []
  const roots = children.get(null) ?? []
  const pending: PendingRow[] = []
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    pending.push({ option: roots[index]!, depth: 0, guides: [], connection: 'root' })
  }
  while (pending.length > 0) {
    const current = pending.pop()!
    const childOptions = children.get(current.option.entryId) ?? []
    rows.push({ ...current.option, depth: current.depth, guides: current.guides, connection: current.connection, hasChildren: childOptions.length > 0 })
    if (childOptions.length === 1) {
      pending.push({ option: childOptions[0]!, depth: current.depth, guides: current.guides, connection: 'chain' })
      continue
    }
    for (let index = childOptions.length - 1; index >= 0; index -= 1) {
      const last = index === childOptions.length - 1
      pending.push({
        option: childOptions[index]!,
        depth: current.depth + 1,
        guides: last ? current.guides : [...current.guides, current.depth],
        connection: 'branch',
      })
    }
  }
  return rows
}

export function treeNavigationLeavesBranch(sessionTree: PiSessionTree, targetId: string): boolean {
  const oldLeafId = sessionTree.leafId
  if (!oldLeafId || oldLeafId === targetId) return false
  const parents = new Map<string, string | null>()
  visitNodes(sessionTree.tree, (node) => parents.set(node.entry.id, node.entry.parentId))
  if (!parents.has(targetId) || !parents.has(oldLeafId)) return false

  let cursor: string | null | undefined = targetId
  const visited = new Set<string>()
  while (cursor !== null && cursor !== undefined && !visited.has(cursor)) {
    if (cursor === oldLeafId) return false
    visited.add(cursor)
    cursor = parents.get(cursor)
  }
  return true
}

function treeNodesFrom(values: readonly unknown[]): PiSessionTreeNode[] {
  const roots: PiSessionTreeNode[] = []
  const pending: Array<{ values: readonly unknown[]; target: PiSessionTreeNode[] }> = [{ values, target: roots }]
  while (pending.length > 0) {
    const current = pending.pop()!
    const childGroups: Array<{ values: readonly unknown[]; target: PiSessionTreeNode[] }> = []
    for (const value of current.values) {
      const record = asRecord(value)
      const entry = sessionEntryFrom(record.entry)
      if (!entry || !Array.isArray(record.children)) continue
      const node: PiSessionTreeNode = {
        entry,
        children: [],
        ...(typeof record.label === 'string' ? { label: record.label } : {}),
        ...((typeof record.labelTimestamp === 'string' || typeof record.labelTimestamp === 'number') ? { labelTimestamp: record.labelTimestamp } : {}),
      }
      current.target.push(node)
      childGroups.push({ values: record.children, target: node.children })
    }
    for (let index = childGroups.length - 1; index >= 0; index -= 1) pending.push(childGroups[index]!)
  }
  return roots
}

function sessionEntryFrom(value: unknown): PiSessionEntry | undefined {
  const record = asRecord(value)
  if (typeof record.type !== 'string' || typeof record.id !== 'string') return undefined
  if (record.parentId !== null && typeof record.parentId !== 'string') return undefined
  return {
    ...record,
    type: record.type,
    id: record.id,
    parentId: record.parentId,
  }
}

interface EntryDisplay {
  title: string
  detail: string
  kind: PiSessionTreeEntryKind
  settings: boolean
  toolResult: boolean
}

function entryDisplay(entry: PiSessionEntry | undefined, active = false): EntryDisplay | undefined {
  if (!entry) return undefined
  if (entry.type === 'message') return messageDisplay(entry.message, active)
  if (entry.type === 'custom_message') return { title: entry.customType ? `Context: ${entry.customType}` : 'Context', detail: compactText(contentText(entry.content)), kind: 'context', settings: false, toolResult: false }
  if (entry.type === 'compaction') return { title: 'Compaction', detail: compactText(entry.summary ?? ''), kind: 'summary', settings: false, toolResult: false }
  if (entry.type === 'branch_summary') return { title: 'Branch summary', detail: compactText(entry.summary ?? ''), kind: 'summary', settings: false, toolResult: false }
  if (entry.type === 'model_change') return { title: 'Model', detail: compactText(typeof entry.modelId === 'string' ? entry.modelId : ''), kind: 'metadata', settings: true, toolResult: false }
  if (entry.type === 'thinking_level_change') return { title: 'Thinking', detail: compactText(typeof entry.thinkingLevel === 'string' ? entry.thinkingLevel : ''), kind: 'metadata', settings: true, toolResult: false }
  if (entry.type === 'custom') return { title: 'Custom', detail: compactText(entry.customType ?? ''), kind: 'metadata', settings: true, toolResult: false }
  if (entry.type === 'label') return { title: 'Label', detail: compactText(typeof entry.label === 'string' ? entry.label : '(cleared)'), kind: 'metadata', settings: true, toolResult: false }
  if (entry.type === 'session_info') return { title: 'Title', detail: compactText(typeof entry.name === 'string' ? entry.name : '(empty)'), kind: 'metadata', settings: true, toolResult: false }
  return undefined
}

function messageDisplay(message: PiMessage | undefined, active: boolean): EntryDisplay | undefined {
  if (!message) return undefined
  if (message.role === 'user') return { title: 'user', detail: compactText(contentText(message.content)), kind: 'user', settings: false, toolResult: false }
  if (message.role === 'assistant') {
    const text = compactText(contentText(message.content))
    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : ''
    const error = typeof message.errorMessage === 'string' ? compactText(message.errorMessage) : ''
    const abnormal = Boolean(stopReason && stopReason !== 'stop' && stopReason !== 'toolUse')
    if (!text && !active && !abnormal && !error) return undefined
    const detail = text || error || (stopReason === 'aborted' ? '(aborted)' : '(no content)')
    return { title: 'assistant', detail, kind: 'assistant', settings: false, toolResult: false }
  }
  if (message.role === 'toolResult') return { title: `Tool: ${String(message.toolName ?? 'result')}`, detail: compactText(contentText(message.content)), kind: 'tool', settings: false, toolResult: true }
  if (message.role === 'bashExecution') return { title: 'Shell', detail: compactText(message.command ?? message.output ?? ''), kind: 'tool', settings: false, toolResult: false }
  if (message.role === 'custom') return { title: message.customType ? `Context: ${message.customType}` : 'Context', detail: compactText(contentText(message.content)), kind: 'context', settings: false, toolResult: false }
  return { title: message.role, detail: compactText(contentText(message.content)), kind: 'context', settings: false, toolResult: false }
}

function contentText(value: PiMessage['content'] | undefined): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((candidate) => typeof candidate.text === 'string' ? [candidate.text] : []).join('\n')
}

function compactText(value: string, limit = 100): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : normalized
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function visitNodes(nodes: readonly PiSessionTreeNode[], visit: (node: PiSessionTreeNode) => void): void {
  const pending = [...nodes].reverse()
  while (pending.length > 0) {
    const node = pending.pop()!
    visit(node)
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
