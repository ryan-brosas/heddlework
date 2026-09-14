import { describe, expect, it } from 'bun:test'
import {
  countOccurrences,
  parseTerminalSmokeEvidence,
  TERMINAL_COPY_SOURCE,
  TERMINAL_EVIDENCE_TEST_ID,
  TERMINAL_INTERRUPT_MARKER,
  TERMINAL_PASTE_ECHO,
  TERMINAL_SMOKE_SHELL,
} from '../scripts/linux-terminal-smoke-contract.ts'

/** Loosely typed on purpose: several cases deliberately build evidence the parser must reject. */
function evidence(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: '',
    status: 'running',
    copyCalls: 0,
    wroteClipboard: false,
    copiedMarker: false,
    ...patch,
  })
}

describe('linux terminal smoke contract', () => {
  it('exposes the ids and markers the compositor fixture and driver share', () => {
    expect(TERMINAL_EVIDENCE_TEST_ID).toBe('terminal-evidence')
    for (const marker of [TERMINAL_COPY_SOURCE, TERMINAL_PASTE_ECHO, TERMINAL_INTERRUPT_MARKER]) {
      expect(TERMINAL_SMOKE_SHELL).toContain(marker)
    }
    // Paste is observable only because the child echoes a matching pasted line back, and the
    // interrupt marker is observable only because the child traps SIGINT instead of dying silently.
    expect(TERMINAL_SMOKE_SHELL).toContain('while IFS= read -r line')
    expect(TERMINAL_SMOKE_SHELL).toContain('trap')
    // Only matching lines are echoed: a per-line firehose would scroll the paste marker out of the
    // visible viewport that the driver asserts on.
    expect(TERMINAL_SMOKE_SHELL).toContain('case "$line" in *' + TERMINAL_COPY_SOURCE + '*)')
  })

  it('parses the evidence the compositor driver asserts on', () => {
    expect(parseTerminalSmokeEvidence(
      evidence({ status: 'exited', exitCode: 0, copyCalls: 1, wroteClipboard: true, copiedMarker: true }),
    )).toEqual({
      text: '',
      status: 'exited',
      exitCode: 0,
      copyCalls: 1,
      wroteClipboard: true,
      copiedMarker: true,
    })
  })

  it('rejects malformed evidence instead of weakening a native failure', () => {
    expect(() => parseTerminalSmokeEvidence('{')).toThrow('Invalid terminal smoke evidence JSON')
    expect(() => parseTerminalSmokeEvidence('null')).toThrow('Invalid terminal smoke evidence: ')
    expect(() => parseTerminalSmokeEvidence(evidence({ status: 'unknown' }))).toThrow('invalid status')
    expect(() => parseTerminalSmokeEvidence(evidence({ copyCalls: '1' }))).toThrow('invalid copyCalls')
    expect(() => parseTerminalSmokeEvidence(evidence({ copyCalls: -1 }))).toThrow('invalid copyCalls')
    expect(() => parseTerminalSmokeEvidence(evidence({ wroteClipboard: undefined }))).toThrow('invalid wroteClipboard')
    expect(() => parseTerminalSmokeEvidence(evidence({ copiedMarker: 'yes' }))).toThrow('invalid copiedMarker')
    expect(() => parseTerminalSmokeEvidence(evidence({ exitCode: 1.5 }))).toThrow('invalid exitCode')
    expect(() => parseTerminalSmokeEvidence(JSON.stringify({ status: 'running', copyCalls: 0, wroteClipboard: false, copiedMarker: false }))).toThrow('has no text')
  })

  it('counts an exact PTY echo once', () => {
    expect(countOccurrences(`${TERMINAL_PASTE_ECHO}payload\\n`, TERMINAL_PASTE_ECHO)).toBe(1)
    expect(countOccurrences(`${TERMINAL_PASTE_ECHO}a\\n${TERMINAL_PASTE_ECHO}b`, TERMINAL_PASTE_ECHO)).toBe(2)
    expect(countOccurrences(TERMINAL_PASTE_ECHO, '')).toBe(0)
  })
})