import { describe, expect, it } from 'bun:test'
import { buildTimeline } from '../src/workbench/timeline.ts'
import type { PiMessage } from '../src/pi/types.ts'

describe('buildTimeline', () => {
  it('pairs tool results with their assistant tool calls', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'List files', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
      {
        role: 'toolResult',
        timestamp: 3,
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'README.md' }],
        isError: false,
      },
    ]

    const items = buildTimeline(messages, undefined, [])
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    const tool = items[2]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.args).toEqual({ command: 'ls' })
      expect(tool.tool.output).toBe('README.md')
      expect(tool.tool.status).toBe('complete')
    }
  })

  it('merges live execution state into a replayed tool call', () => {
    const messages: PiMessage[] = [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'a.ts' } }],
    }]
    const items = buildTimeline(messages, undefined, [{
      id: 'call-2',
      name: 'read',
      args: { path: 'a.ts' },
      output: 'const value = 1',
      status: 'running',
      isError: false,
    }])
    const tool = items[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') expect(tool.tool.output).toBe('const value = 1')
  })

  it('mirrors Pi by omitting hidden custom messages while retaining displayable ones', () => {
    const items = buildTimeline([
      { role: 'custom', customType: 'hidden-retry', content: 'Retry the previous request.', display: false, timestamp: 1 },
      { role: 'custom', customType: 'visible-status', content: [{ type: 'text', text: 'Visible extension context' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], display: true, timestamp: 2 },
    ], undefined, [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'context-injection', source: 'visible-status', text: 'Visible extension context', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] })
  })

  it('matches persisted suffix turns by entry ID instead of catalog position', () => {
    const messages: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'tail-user', content: 'Tail prompt', timestamp: 10 },
      { role: 'assistant', workbenchEntryId: 'tail-assistant', content: [{ type: 'thinking', thinking: 'Tail reasoning' }], timestamp: 11 },
    ]
    const items = buildTimeline(messages, undefined, [], [
      { entryId: 'older-user', text: 'Older prompt' },
      { entryId: 'tail-user', text: 'Tail prompt' },
    ])

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'user', revertEntryId: 'tail-user' })
    expect(items[1]).toMatchObject({ kind: 'thinking', revertEntryId: 'tail-user' })
  })

  it('attaches image blocks and the nearest branchable prompt to every turn row', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', previewPath: '/tmp/image.png' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'I can see it.' }, { type: 'toolCall', id: 'tool', name: 'read', arguments: { path: 'a.ts' } }], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tool', toolName: 'read', content: [{ type: 'text', text: 'value' }], timestamp: 3 },
    ]
    const items = buildTimeline(messages, undefined, [], [{ entryId: 'entry-user', text: 'Inspect this' }])
    const user = items.find((item) => item.kind === 'user')
    const assistant = items.find((item) => item.kind === 'assistant')
    const tool = items.find((item) => item.kind === 'tool')
    expect(user).toMatchObject({ kind: 'user', text: 'Inspect this', revertEntryId: 'entry-user' })
    if (user?.kind === 'user') expect(user.images).toHaveLength(1)
    expect(assistant).toMatchObject({ kind: 'assistant', revertEntryId: 'entry-user' })
    expect(tool).toMatchObject({ kind: 'tool', revertEntryId: 'entry-user' })
  })
  it('interleaves extension notifications between reasoning and tool calls in their turn', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'Inspect the project', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'thinking', thinking: 'I should inspect the files.' },
          { type: 'toolCall', id: 'call-notice', name: 'read', arguments: { path: 'README.md' } },
        ],
      },
    ]
    const notices = [{ id: 7, kind: 'info' as const, message: 'TPS 25.6 tok/s', createdAt: 3, transcriptTurn: 0, transcriptPosition: 1 }]

    const items = buildTimeline(messages, undefined, [], [], 0, notices)

    expect(items.map((item) => item.kind)).toEqual(['user', 'thinking', 'notice', 'tool'])
    expect(items[2]).toMatchObject({ kind: 'notice', notice: { message: 'TPS 25.6 tok/s' } })
  })

  it('leaves a notice without a captured turn position out of the feed', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'Inspect the project', timestamp: 1 },
      { role: 'assistant', content: 'Done.', timestamp: 2 },
    ]
    const notices = [{ id: 9, kind: 'info' as const, message: 'TPS 25.6 tok/s', createdAt: 3 }]

    const items = buildTimeline(messages, undefined, [], [], 0, notices)

    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant'])
  })

  it('appends a turn status line after the turn content, like Pi showStatus', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'First', timestamp: 1 },
      { role: 'assistant', content: 'First answer', timestamp: 2 },
      { role: 'user', content: 'Second', timestamp: 3 },
    ]
    const statusLines = [{ id: 3, text: 'TPS 25.6 tok/s', createdAt: 4, turn: 0 }]

    const items = buildTimeline(messages, undefined, [], [], 0, [], statusLines)

    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'status', 'user'])
    expect(items[2]).toMatchObject({ kind: 'status', text: 'TPS 25.6 tok/s' })
  })

  it('keeps only the latest status line for a turn', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'First', timestamp: 1 },
      { role: 'assistant', content: 'First answer', timestamp: 2 },
    ]
    const statusLines = [
      { id: 3, text: 'TPS 25.6 tok/s', createdAt: 3, turn: 0 },
      { id: 4, text: 'TPS 25.9 tok/s', createdAt: 4, turn: 0 },
    ]

    const items = buildTimeline(messages, undefined, [], [], 0, [], statusLines)

    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'status'])
    expect(items[2]).toMatchObject({ text: 'TPS 25.9 tok/s' })
  })
  it('orders notifications at their captured trace positions and by time within a position', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'Inspect the project', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'First reasoning' }, { type: 'toolCall', id: 'first-tool', name: 'read', arguments: {} }], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'first-tool', toolName: 'read', content: 'done', timestamp: 3 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Second reasoning' }, { type: 'toolCall', id: 'second-tool', name: 'grep', arguments: {} }], timestamp: 4 },
    ]
    const notices = [
      { id: 3, kind: 'info' as const, message: 'Third', createdAt: 30, transcriptTurn: 0, transcriptPosition: 3 },
      { id: 1, kind: 'info' as const, message: 'First', createdAt: 10, transcriptTurn: 0, transcriptPosition: 1 },
      { id: 2, kind: 'info' as const, message: 'Second', createdAt: 20, transcriptTurn: 0, transcriptPosition: 3 },
    ]

    const items = buildTimeline(messages, undefined, [], [], 0, notices)

    expect(items.map((item) => item.kind)).toEqual(['user', 'thinking', 'notice', 'tool', 'thinking', 'notice', 'notice', 'tool'])
    expect(items.filter((item) => item.kind === 'notice').map((item) => item.notice.message)).toEqual(['First', 'Second', 'Third'])
  })

  it('renders compaction summaries as their own timeline items', () => {
    const items = buildTimeline([
      { role: 'user', content: 'Inspect the repo', timestamp: 1 },
      { role: 'assistant', content: 'Done.', timestamp: 2 },
      { role: 'compaction', content: 'User inspected the repo.', tokensBefore: 150000, timestamp: 3 },
    ], undefined, [])
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'compaction'])
    expect(items[2]).toMatchObject({ kind: 'compaction', text: 'User inspected the repo.', tokensBefore: 150000 })
  })

  it('completes abandoned tools from earlier turns after a later user message', () => {
    const items = buildTimeline([
      { role: 'user', content: 'First', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'stale', name: 'bash', arguments: { command: 'sleep 30' } }], timestamp: 2 },
      { role: 'user', content: 'Continue', timestamp: 3 },
      { role: 'assistant', content: 'Done.', timestamp: 4 },
    ], undefined, [])
    const tool = items.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') expect(tool.tool.status).toBe('complete')
  })

  it('reads Pi compactionSummary messages from the summary field', () => {
    const items = buildTimeline([
      { role: 'compactionSummary', summary: '[Session Goal]\nShip the compaction CoT.', tokensBefore: 228942, timestamp: 4 },
    ], undefined, [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'compaction', text: '[Session Goal]\nShip the compaction CoT.', tokensBefore: 228942 })
  })
})
