import { describe, expect, it } from 'bun:test'
import { syntheticActiveSession } from '../src/ui/sidebar.tsx'
import { createInitialState } from '../src/workbench/state.ts'

describe('sidebar current thread', () => {
  it('shows the thread Pi is holding before it has any message', () => {
    const state = createInitialState('/tmp/project')
    const row = syntheticActiveSession({
      ...state,
      messages: [],
      session: { ...state.session, sessionFile: '/tmp/project/session-1.jsonl', sessionId: 'session-1', sessionName: 'Fresh thread' },
    })
    expect(row).toMatchObject({ path: '/tmp/project/session-1.jsonl', cwd: '/tmp/project', title: 'Fresh thread', messageCount: 0 })
  })

  it('titles a blank, unnamed thread without inventing a first message', () => {
    const state = createInitialState('/tmp/project')
    const row = syntheticActiveSession({
      ...state,
      messages: [],
      session: { ...state.session, sessionFile: '/tmp/project/session-2.jsonl', sessionId: 'session-2' },
    })
    expect(row).toMatchObject({ title: 'New thread', firstMessage: '(no messages)', messageCount: 0 })
  })

  it('shows a thread identified only by its session id', () => {
    const state = createInitialState('/tmp/project')
    const row = syntheticActiveSession({
      ...state,
      messages: [],
      session: { ...state.session, sessionId: 'session-3' },
    })
    expect(row).toMatchObject({ path: 'current:session-3', title: 'New thread', messageCount: 0 })
  })

  it('shows nothing while Pi holds no thread and no message exists', () => {
    // The initial state is exactly that: no session file, no session id.
    expect(syntheticActiveSession(createInitialState('/tmp/project'))).toBeNull()
  })

  it('keeps naming a thread from its first user message once it has one', () => {
    const state = createInitialState('/tmp/project')
    const row = syntheticActiveSession({
      ...state,
      messages: [{ role: 'user', content: 'Fix the Linux picker', timestamp: 1 }],
    })
    expect(row).toMatchObject({ title: 'Fix the Linux picker', firstMessage: 'Fix the Linux picker', messageCount: 1 })
  })
})
