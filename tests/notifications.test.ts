import { describe, expect, it } from 'bun:test'
import { addNotice, addStatusLine, createInitialState, type WorkbenchState } from '../src/workbench/state.ts'

describe('notification ledger state', () => {
  it('retains notification history with timestamps instead of only active toasts', () => {
    let state = createInitialState('/tmp/project')
    for (let index = 0; index < 8; index += 1) state = addNotice(state, 'info', `Notice ${index}`)

    expect(state.notices).toHaveLength(8)
    expect(state.notices[0]?.message).toBe('Notice 0')
    expect(state.notices.at(-1)?.message).toBe('Notice 7')
    expect(state.notices.every((notice) => notice.createdAt > 0)).toBe(true)
  })

  it('keeps a turn status line out of the notification ledger and replaces it when re-reported', () => {
    let state = createInitialState('/tmp/project')
    state = addNotice(state, 'error', 'A Pi extension failed')
    state = addStatusLine(state, 'TPS 25.6 tok/s')
    state = addStatusLine(state, 'TPS 25.9 tok/s')

    expect(state.statusLines.map((line) => line.text)).toEqual(['TPS 25.9 tok/s'])
    expect(state.statusLines[0]).toMatchObject({ turn: 0 })
    expect(state.notices.map((notice) => notice.message)).toEqual(['A Pi extension failed'])

    const messages: WorkbenchState['messages'] = [
      { role: 'user', content: 'First turn', timestamp: 1 },
      { role: 'assistant', content: 'Answered', timestamp: 2 },
      { role: 'user', content: 'Next turn', timestamp: 3 },
    ]
    state = addStatusLine({ ...state, messages }, 'TPS 30.1 tok/s')
    expect(state.statusLines.map((line) => line.text)).toEqual(['TPS 25.9 tok/s', 'TPS 30.1 tok/s'])
  })
})
