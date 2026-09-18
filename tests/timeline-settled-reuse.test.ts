import { describe, expect, it } from 'bun:test'

import type { PiForkMessage } from '../src/pi/types.ts'
import type { PiMessage } from '../src/pi/types.ts'
import type { Notice } from '../src/workbench/state.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'

// Live deltas must not rebuild settled timeline items: that rebuild was the
// per-token O(transcript) cost behind the streaming lag. The cache keys on
// identity exactly like the controller snapshot does, so these tests pass the
// same stable arrays the app passes. The assertions are clock-free, so they
// gate the property on any machine.

const NO_FORK: PiForkMessage[] = []
const NO_NOTICES: Notice[] = []

function conversation(length: number): PiMessage[] {
  const messages: PiMessage[] = []
  for (let index = 0; index < length; index += 1) {
    messages.push({ role: 'user', content: `question ${index}`, timestamp: index * 10 })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }], timestamp: index * 10 + 1 })
  }
  return messages
}

describe('settled timeline reuse', () => {
  it('returns identical settled items when only the live projection changes', () => {
    const messages = conversation(40)
    const settled = buildTimeline(messages, undefined, [], NO_FORK, 0, NO_NOTICES)
    const withLive = buildTimeline(
      messages,
      { id: 'live-1', blocks: [{ index: 0, kind: 'text', text: 'streaming token' }] },
      [],
      NO_FORK,
      0,
      NO_NOTICES,
    )
    expect(withLive.length).toBe(settled.length + 1)
    for (let index = 0; index < settled.length; index += 1) {
      expect(withLive[index]).toBe(settled[index]!)
    }
  })

  it('rebuilds items when the authoritative transcript changes', () => {
    const messages = conversation(40)
    const settled = buildTimeline(messages, undefined, [], NO_FORK, 0, NO_NOTICES)
    const grown = buildTimeline([...messages], undefined, [], NO_FORK, 0, NO_NOTICES)
    expect(grown[0]).not.toBe(settled[0]!)
  })

  it('keeps live tool merges off the cached settled array', () => {
    const messages: PiMessage[] = [{
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'toolCall', id: 'tool-a', name: 'read', arguments: { path: 'a.ts' } }],
    }]
    const settled = buildTimeline(messages, undefined, [], NO_FORK, 0, NO_NOTICES)
    const withTool = buildTimeline(
      messages,
      undefined,
      [{ id: 'tool-a', name: 'read', args: { path: 'a.ts' }, output: 'done', status: 'complete', isError: false }],
      NO_FORK,
      0,
      NO_NOTICES,
    )
    expect(withTool[0]).not.toBe(settled[0]!)
    const settledTool = settled[0]
    expect(settledTool?.kind === 'tool' ? settledTool.tool.status : undefined).toBe('preparing')
    const again = buildTimeline(messages, undefined, [], NO_FORK, 0, NO_NOTICES)
    expect(again[0]).toBe(settledTool!)
  })
})
