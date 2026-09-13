import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { DEFAULT_REMOTE_TERMINAL_APPEARANCE } from '../src/client/remote-terminal-service.ts'
import { DEFAULT_TERMINAL_APPEARANCE } from '../src/terminal/appearance.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'

describe('terminal appearance persistence', () => {
  it('applies settings at runtime and restores them for the next service', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-terminal-'))
    const path = join(directory, 'terminal.json')
    try {
      const first = new TerminalSessionService({
        cwd: process.cwd(),
        backend: new MemoryTerminalBackend(),
        appearancePath: path,
      })
      first.setAppearance({
        fontFamily: 'Fira Code',
        nerdFontFamily: 'Symbols Nerd Font',
        ligaturesEnabled: false,
        nerdFontEnabled: true,
        muteEmojiColors: false,
      })
      expect(first.getSnapshot().appearance).toEqual({
        fontFamily: 'Fira Code',
        nerdFontFamily: 'Symbols Nerd Font',
        ligaturesEnabled: false,
        nerdFontEnabled: true,
        muteEmojiColors: false,
      })
      expect(JSON.parse(readFileSync(path, 'utf8')).fontFamily).toBe('Fira Code')
      await first.dispose()

      const second = new TerminalSessionService({
        cwd: process.cwd(),
        backend: new MemoryTerminalBackend(),
        appearancePath: path,
      })
      expect(second.getSnapshot().appearance.fontFamily).toBe('Fira Code')
      expect(second.getSnapshot().appearance.nerdFontEnabled).toBe(true)
      await second.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('terminal appearance defaults', () => {
  it('differs between the native terminal and the browser client only in fontFamily', () => {
    const fields = Object.keys(DEFAULT_TERMINAL_APPEARANCE) as (keyof typeof DEFAULT_TERMINAL_APPEARANCE)[]
    expect(fields.filter((field) => DEFAULT_TERMINAL_APPEARANCE[field] !== DEFAULT_REMOTE_TERMINAL_APPEARANCE[field])).toEqual(['fontFamily'])
  })
})
