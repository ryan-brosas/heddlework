import { describe, expect, it } from 'bun:test'
import type { TimelineItem } from '../src/workbench/timeline.ts'
import { currentWorkWave, groupWorkItems, liveWorkTraceId, pendingWorkTraceId, projectTranscriptRows } from '../src/ui/transcript-projection.ts'

describe('transcript projection', () => {
  const items: TimelineItem[] = [
    { id: 'user', kind: 'user', text: 'Prompt', images: [] },
    { id: 'thinking', kind: 'thinking', text: 'Plan' },
    { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    { id: 'edit', kind: 'tool', tool: { id: 'edit', name: 'edit', args: { path: 'src/a.ts' }, status: 'complete', isError: false } },
    { id: 'answer', kind: 'assistant', text: 'Done' },
  ]

  it('keeps collapsed work as one semantic header plus its changed-files row', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')
    expect(trace).toMatchObject({ id: 'work-trace-edit', kind: 'work-trace', changedPaths: ['src/a.ts'] })

    const rows = projectTranscriptRows(grouped, new Set(), new Map())
    expect(rows.map((row) => row.kind)).toEqual(['timeline-item', 'trace-header', 'trace-files', 'timeline-item'])
  })

  it('renders a session status line as its own row instead of trace content', () => {
    const status: TimelineItem = { id: 'status-line-3', kind: 'status', text: 'TPS 25.6 tok/s', timestamp: 5 }
    const grouped = groupWorkItems([...items.slice(0, 3), status, ...items.slice(3)])
    // `TraceTimelineItem` excludes status entries by type, so a status line can only stay top level.
    expect(grouped.filter((item) => item.kind === 'status')).toHaveLength(1)

    const rows = projectTranscriptRows(grouped, new Set(), new Map())
    expect(rows.filter((row) => row.kind === 'timeline-item' && row.item.kind === 'status')).toHaveLength(1)
  })

  it('keeps a boundary trace ID stable while live work appends', () => {
    const liveThinking: TimelineItem = { id: 'live-thinking', kind: 'thinking', text: 'Planning', streaming: true }
    const liveTool: TimelineItem = { id: 'live-tool', kind: 'tool', tool: { id: 'live-tool', name: 'read', status: 'running', isError: false } }
    const preparing = groupWorkItems([items[0]!, liveThinking])
    const running = groupWorkItems([items[0]!, liveThinking, liveTool])
    expect(preparing.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
    expect(running.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
  })

  it('reuses the pending work-trace id when the first tool arrives', () => {
    const user: TimelineItem = { id: 'user', kind: 'user', text: 'Prompt', images: [] }
    const preparing = groupWorkItems([user], true)
    const running = groupWorkItems([user, { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'running', isError: false } }], true)
    expect(pendingWorkTraceId(preparing, true)).toBe('work-trace-after-user')
    expect(liveWorkTraceId(running, true)).toBe('work-trace-after-user')
  })

  it('keeps the current-turn work-trace id stable when a tool finishes and another starts', () => {
    const user: TimelineItem = { id: 'user', kind: 'user', text: 'Prompt', images: [] }
    const first: TimelineItem = { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } }
    const second: TimelineItem = { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'running', isError: false } }
    const finished = groupWorkItems([user, first], true)
    const next = groupWorkItems([user, first, second], true)
    expect(finished.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
    expect(next.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
  })

  it('projects only the requested trace prefix and one continuation seam', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, 2]]))

    expect(rows.map((row) => row.kind)).toEqual([
      'timeline-item',
      'trace-header',
      'trace-entry',
      'trace-entry',
      'trace-continuation',
      'trace-files',
      'timeline-item',
    ])
    expect(rows.find((row) => row.kind === 'trace-continuation')).toMatchObject({ remaining: 1 })
  })

  it('removes the continuation after every semantic entry is projected', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, trace.items.length]]))

    expect(rows.filter((row) => row.kind === 'trace-entry')).toHaveLength(3)
    expect(rows.some((row) => row.kind === 'trace-continuation')).toBe(false)
  })

  it('clamps an oversized first-expansion limit to the trace that exists', () => {
    // The transcript only knows a trace's item count for traces it has already expanded, so a
    // first expansion asks for the default limit; the projection has to clamp it to the trace.
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const exact = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, trace.items.length]]))
    const generous = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, 64]]))

    expect(generous.map((row) => row.kind)).toEqual(exact.map((row) => row.kind))
    expect(generous.some((row) => row.kind === 'trace-continuation')).toBe(false)
  })

  it('does not treat a compaction CoT as the live Working header', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'compact', kind: 'compaction', text: 'Summarized earlier work.', tokensBefore: 150000 },
    ], true)
    expect(liveWorkTraceId(grouped, true)).toBeUndefined()
    expect(pendingWorkTraceId(grouped, true)).toBeUndefined()
  })

  it('keeps compaction as a standalone work-trace instead of merging it into adjacent work', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'compact', kind: 'compaction', text: 'Summarized earlier work.', tokensBefore: 150000 },
      { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ])
    expect(grouped.map((item) => item.kind)).toEqual(['user', 'work-trace', 'work-trace', 'work-trace', 'assistant'])
    expect(grouped[1]).toMatchObject({ kind: 'work-trace', items: [{ id: 'thinking' }, { id: 'read' }] })
    expect(grouped[2]).toMatchObject({ kind: 'work-trace', id: 'work-trace-compact', items: [{ kind: 'compaction', tokensBefore: 150000 }] })
    expect(grouped[3]).toMatchObject({ kind: 'work-trace', items: [{ id: 'grep' }] })
  })

  it('groups only adjacent notifications emitted close together', () => {
    const notices: TimelineItem[] = [
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'One', createdAt: 1_000 } },
      { id: 'notice-2', kind: 'notice', notice: { id: 2, kind: 'info', message: 'Two', createdAt: 2_000 } },
      { id: 'notice-3', kind: 'notice', notice: { id: 3, kind: 'info', message: 'Three', createdAt: 8_000 } },
    ]
    const grouped = groupWorkItems([items[0]!, items[1]!, ...notices, items[2]!])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map())
    const notificationRows = rows.filter((row) => row.kind === 'trace-notices')

    expect(notificationRows).toHaveLength(2)
    expect(notificationRows.map((row) => row.notices.length)).toEqual([2, 1])
    expect(rows.map((row) => row.kind)).toEqual(['timeline-item', 'trace-header', 'trace-entry', 'trace-notices', 'trace-notices', 'trace-entry'])
  })

  it('keeps notices out of the collapsed trace rows', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'TPS 25.6 tok/s', createdAt: 1_000 } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ])
    const rows = projectTranscriptRows(grouped, new Set(), new Map())
    expect(rows.map((row) => row.kind)).toEqual(['timeline-item', 'trace-header', 'timeline-item'])
  })

  it('keeps the running preview on reasoning when a notice trails the work wave', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan', streaming: true },
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'TPS 25.6 tok/s', createdAt: 1_000 } },
    ])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    expect(currentWorkWave(trace.items).preview).toMatchObject({ id: 'thinking', kind: 'thinking' })
  })

  it('folds intermediate assistant replies into the work trace and keeps the settled response', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'first', kind: 'assistant', text: 'I will inspect the repo.' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'second', kind: 'assistant', text: 'There is a session-switch path.' },
      { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'complete', isError: false } },
      { id: 'final', kind: 'assistant', text: 'Here is the answer.' },
    ])

    expect(grouped.map((item) => item.kind)).toEqual(['user', 'work-trace', 'assistant'])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    expect(trace.items.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    expect(grouped.at(-1)).toMatchObject({ kind: 'assistant', text: 'Here is the answer.' })
  })

  it('keeps a live assistant reply visible until later work appears', () => {
    const streaming: TimelineItem = { id: 'live', kind: 'assistant', text: 'I will inspect the repo.', streaming: true }
    const preparing = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      streaming,
    ])
    const running = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'live', kind: 'assistant', text: 'I will inspect the repo.' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'running', isError: false } },
    ])

    expect(preparing.map((item) => item.kind)).toEqual(['user', 'assistant'])
    expect(running.map((item) => item.kind)).toEqual(['user', 'work-trace'])
    expect(running.find((item) => item.kind === 'work-trace')?.items.map((item) => item.kind)).toEqual(['assistant', 'tool'])
  })

  it('keeps the current-turn work trace live while streaming before a response', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    ])
    expect(liveWorkTraceId(grouped, true)).toBe('work-trace-read')
    expect(liveWorkTraceId(grouped, false)).toBeUndefined()
  })

  it('keeps the current-turn work-trace id while a streaming assistant follows', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done', streaming: true },
    ], true)
    expect(grouped.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
  })

  it('does not pending-Working after a settled assistant while still streaming', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ], true)
    expect(liveWorkTraceId(grouped, true)).toBeUndefined()
    expect(pendingWorkTraceId(grouped, true)).toBeUndefined()
  })

  it('ends the live work header when an assistant response starts', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done', streaming: true },
    ])
    expect(liveWorkTraceId(grouped, true)).toBeUndefined()
  })

  it('keeps a work-trace id stable when notices append', () => {
    const tools: TimelineItem[] = [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    ]
    const withNotice = groupWorkItems([
      ...tools,
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'One', createdAt: 1_000 } },
    ])
    expect(withNotice.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-read')
  })

  it('only includes tools after the last assistant in the current work wave', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'first', kind: 'assistant', text: 'Checking.' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'second', kind: 'assistant', text: 'Continuing.' },
      { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'running', isError: false } },
    ])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    expect(currentWorkWave(trace.items).tools.map((item) => item.tool.id)).toEqual(['grep'])
  })

  it('does not revive a previous turn work trace after a new user prompt', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
      { id: 'follow-up', kind: 'user', text: 'Continue', images: [] },
    ])
    expect(liveWorkTraceId(grouped, true)).toBeUndefined()
  })

  it('keeps displayable custom type messages inside the work trace', () => {
    const grouped = groupWorkItems([
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'capability', kind: 'context-injection', text: 'pi-fovea · 4 tools matched your prompt.', images: [], source: 'pi-fabric-capability' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'final', kind: 'assistant', text: 'Done.' },
    ])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    expect(trace.items.map((item) => item.kind)).toEqual(['context-injection', 'tool'])
    expect(trace.items[0]).toMatchObject({ source: 'pi-fabric-capability' })
  })
})
