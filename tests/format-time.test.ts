import { describe, expect, it } from 'bun:test'
import { formatTimeOfDay, formatTokenCount } from '../src/ui/format-time.ts'

describe('shared time formatters', () => {
  it('formats a stamp identically on repeat calls (cache hit)', () => {
    const stamp = Date.UTC(2026, 8, 12, 2, 44, 0)
    const first = formatTimeOfDay(stamp)
    expect(first).toMatch(/^\d{1,2}:\d{2}/)
    expect(formatTimeOfDay(stamp)).toBe(first)
  })

  it('keeps distinct stamps distinct across the cache', () => {
    const a = formatTimeOfDay(Date.UTC(2026, 8, 12, 2, 44, 0))
    const b = formatTimeOfDay(Date.UTC(2026, 8, 12, 14, 30, 0))
    expect(a).not.toBe(b)
  })

  it('groups token counts like toLocaleString', () => {
    expect(formatTokenCount(1234)).toMatch(/^1[,.]234$/)
  })
})
