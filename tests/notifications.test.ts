import { describe, expect, it } from 'bun:test'
import { addNotice, addTransientNotice, createInitialState, isDurableNotice } from '../src/workbench/state.ts'

describe('notification ledger state', () => {
  it('retains notification history with timestamps instead of only active toasts', () => {
    let state = createInitialState('/tmp/project')
    for (let index = 0; index < 8; index += 1) state = addNotice(state, 'info', `Notice ${index}`)

    expect(state.notices).toHaveLength(8)
    expect(state.notices[0]?.message).toBe('Notice 0')
    expect(state.notices.at(-1)?.message).toBe('Notice 7')
    expect(state.notices.every((notice) => notice.createdAt > 0)).toBe(true)
  })

  it('marks extension banners transient so the ledger keeps only durable history', () => {
    let state = createInitialState('/tmp/project')
    state = addNotice(state, 'error', 'A Pi extension failed')
    state = addTransientNotice(state, 'info', 'TPS 25.6 tok/s')

    expect(state.notices.map((notice) => isDurableNotice(notice))).toEqual([true, false])
    expect(state.notices[1]).toMatchObject({ kind: 'info', message: 'TPS 25.6 tok/s', transient: true })
    expect(state.notices[1]?.transcriptTurn).toBeUndefined()
    expect(state.notices[1]?.transcriptPosition).toBeUndefined()
  })
})
