import { describe, expect, it } from 'bun:test'
import { resolveInsertKeyCommand } from '../src/ui/insert-key.ts'

// Omarchy/Hyprland deliver clipboard shortcuts as insert keystrokes; a regression here makes copy
// or paste silently do nothing on that desktop while every other platform keeps working.
describe('resolveInsertKeyCommand', () => {
  it('pastes on Shift+Insert', () => {
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { shift: true } })).toBe('paste')
    expect(resolveInsertKeyCommand({ key: 'Insert', modifiers: { shift: true } })).toBe('paste')
  })

  it('copies on Ctrl+Insert and Cmd+Insert', () => {
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { ctrl: true } })).toBe('copy')
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { cmd: true } })).toBe('copy')
  })

  it('ignores insert without a clipboard modifier', () => {
    expect(resolveInsertKeyCommand({ key: 'insert' })).toBe('none')
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: {} })).toBe('none')
  })

  it('ignores insert combined with a conflicting or editing modifier', () => {
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { shift: true, ctrl: true } })).toBe('none')
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { shift: true, alt: true } })).toBe('none')
    expect(resolveInsertKeyCommand({ key: 'insert', modifiers: { ctrl: true, alt: true } })).toBe('none')
  })

  it('leaves other keys alone', () => {
    expect(resolveInsertKeyCommand({ key: 'v', modifiers: { ctrl: true } })).toBe('none')
    expect(resolveInsertKeyCommand({ key: 'c', modifiers: { ctrl: true } })).toBe('none')
    expect(resolveInsertKeyCommand({})).toBe('none')
  })
})
