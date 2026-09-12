import { describe, expect, it } from 'bun:test'
import { addNotice, addStatusLine, createInitialState, shiftTurnAnchors, type WorkbenchState } from '../src/workbench/state.ts'

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
    // Nothing is loaded yet, so the line is tail-anchored until the transcript arrives.
    expect(state.statusLines[0]).toMatchObject({ turn: -1 })
    expect(state.notices.map((notice) => notice.message)).toEqual(['A Pi extension failed'])


    const messages: WorkbenchState['messages'] = [
      { role: 'user', content: 'First turn', timestamp: 1 },
      { role: 'assistant', content: 'Answered', timestamp: 2 },
      { role: 'user', content: 'Next turn', timestamp: 3 },
    ]
    state = addStatusLine({ ...state, messages }, 'TPS 30.1 tok/s')
    expect(state.statusLines.map((line) => line.text)).toEqual(['TPS 25.9 tok/s', 'TPS 30.1 tok/s'])
  })

  it('leaves a notice unanchored while no turn is loaded, instead of claiming turn 0', () => {
    const empty = addNotice(createInitialState('/tmp/project'), 'warning', 'Disk almost full', 0)
    expect(empty.notices[0]?.transcriptTurn).toBeUndefined()

    const loaded: WorkbenchState = { ...empty, messages: [{ role: 'user', content: 'First turn', timestamp: 1 }] }
    expect(addNotice(loaded, 'warning', 'Disk almost full', 0).notices.at(-1)).toMatchObject({ transcriptTurn: 0, transcriptPosition: 0 })
  })

  it('moves turn anchors with the messages when earlier history prepends', () => {
    const messages: WorkbenchState['messages'] = [
      { role: 'user', content: 'Second turn', timestamp: 3 },
      { role: 'assistant', content: 'Answered', timestamp: 4 },
      { role: 'user', content: 'Third turn', timestamp: 5 },
    ]
    let state: WorkbenchState = { ...createInitialState('/tmp/project'), messages }
    state = addStatusLine(state, 'TPS 25.6 tok/s')
    state = addNotice(state, 'warning', 'Disk almost full', 1)
    // Two user messages are loaded, so the newest turn is index 1.
    expect(state.statusLines[0]?.turn).toBe(1)

    const shifted = shiftTurnAnchors(state, 12)
    expect(shifted.statusLines[0]?.turn).toBe(13)
    expect(shifted.notices[0]?.transcriptTurn).toBe(13)
    // A no-op load and a tail anchor keep their positions.
    expect(shiftTurnAnchors(state, 0)).toBe(state)
    expect(shiftTurnAnchors({ ...state, statusLines: [{ id: 9, text: 'TPS 1 tok/s', createdAt: 1, turn: -1 }] }, 12).statusLines[0]?.turn).toBe(-1)
  })
})
