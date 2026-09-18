import { beforeEach, describe, expect, it } from 'bun:test'

import { projectTranscriptRows, resetRowIdentityCache, type DisplayTimelineItem } from '../src/ui/transcript-projection.ts'

function assistant(id: string, text: string): DisplayTimelineItem {
  return { id, kind: 'assistant', text }
}

function user(id: string, text: string): DisplayTimelineItem {
  return { id, kind: 'user', text, images: [] }
}

describe('transcript projection row identity', () => {
  beforeEach(() => resetRowIdentityCache())

  it('reuses rows whose backing items are unchanged', () => {
    const items = [user('u1', 'hi'), assistant('a1', 'one'), assistant('a2', 'two')]
    const first = projectTranscriptRows(items, new Set(), new Map())
    const second = projectTranscriptRows([...items], new Set(), new Map())
    expect(second).toHaveLength(first.length)
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]!)
    }
  })

  it('replaces only the row whose item changed', () => {
    const items = [user('u1', 'hi'), assistant('a1', 'one'), assistant('a2', 'two')]
    const first = projectTranscriptRows(items, new Set(), new Map())
    const grew = [items[0]!, assistant('a1', 'one plus a token'), items[2]!]
    const second = projectTranscriptRows(grew, new Set(), new Map())
    expect(second[0]).toBe(first[0]!)
    expect(second[1]).not.toBe(first[1]!)
    expect(second[2]).toBe(first[2]!)
  })

  it('keeps a trace header stable while its entries grow', () => {
    // Entry objects stay identical across renders in the app because the settled
    // timeline pass is reused; only the array that holds them grows.
    const entryA = { id: 't0', kind: 'assistant' as const, text: 'a' }
    const entryB = { id: 't1', kind: 'assistant' as const, text: 'b' }
    const traceOf = (items: Array<{ id: string; kind: 'assistant'; text: string }>): DisplayTimelineItem => ({
      id: 'work-trace-1',
      kind: 'work-trace',
      identity: 'boundary',
      changedPaths: [],
      items,
    })
    const expanded = new Set(['work-trace-1'])
    const limits = new Map<string, number>()
    const first = projectTranscriptRows([traceOf([entryA])], expanded, limits)
    const second = projectTranscriptRows([traceOf([entryA, entryB])], expanded, limits)
    expect(second[0]).not.toBe(first[0]!)
    expect(second[1]).toBe(first[1]!)

    const third = projectTranscriptRows([traceOf([entryA, entryB])], expanded, limits)
    expect(third[0]).toBe(second[0]!)
    expect(third[1]).toBe(second[1]!)
  })

  it('forgets reused rows after a session switch reset', () => {
    const first = projectTranscriptRows([user('u1', 'old thread')], new Set(), new Map())
    resetRowIdentityCache()
    const second = projectTranscriptRows([user('u1', 'new thread')], new Set(), new Map())
    expect(second[0]).not.toBe(first[0]!)
    expect(second[0]).toMatchObject({ id: 'u1', kind: 'timeline-item' })
  })
})
