export const TERMINAL_COPY_SOURCE = 'HEDDLEWORK_TERMINAL_COPY_SOURCE'
export const TERMINAL_PASTE_ECHO = 'HEDDLEWORK_TERMINAL_PASTE_ECHO:'
export const TERMINAL_INTERRUPT_MARKER = 'HEDDLEWORK_TERMINAL_INTERRUPT_OK'
export const TERMINAL_EVIDENCE_TEST_ID = 'terminal-evidence'

/**
 * Deterministic PTY child shared by the Linux compositor smoke and the headless PTY test.
 *
 * It prints one copyable marker, echoes a pasted line back only when that line carries the marker,
 * and turns SIGINT into a third marker. Emitting a marker only for matching lines keeps the
 * transcript short enough that every assertion reads the live viewport no matter how far the paste
 * scrolled, and it makes the paste assertion exact: the child saw the bytes the clipboard returned.
 */
export const TERMINAL_SMOKE_SHELL = [
  `trap 'printf "\\n%s\\n" ${TERMINAL_INTERRUPT_MARKER}; exit 0' INT`,
  `printf '%s\\n' ${TERMINAL_COPY_SOURCE}`,
  `while IFS= read -r line; do case "$line" in *${TERMINAL_COPY_SOURCE}*) printf '%s%s\\n' ${TERMINAL_PASTE_ECHO} "$line";; esac; done`,
].join('\n')

export interface TerminalSmokeEvidence {
  readonly text: string
  readonly status: 'running' | 'exited'
  readonly exitCode?: number | null
  readonly copyCalls: number
  readonly wroteClipboard: boolean
  readonly copiedMarker: boolean
}

export function parseTerminalSmokeEvidence(value: string): TerminalSmokeEvidence {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Invalid terminal smoke evidence JSON: ${value}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid terminal smoke evidence: ${value}`)
  const evidence = parsed as Record<string, unknown>
  if (typeof evidence.text !== 'string') throw new Error(`Terminal smoke evidence has no text: ${value}`)
  if (evidence.status !== 'running' && evidence.status !== 'exited') throw new Error(`Terminal smoke evidence has invalid status: ${value}`)
  if (!Number.isInteger(evidence.copyCalls) || Number(evidence.copyCalls) < 0) throw new Error(`Terminal smoke evidence has invalid copyCalls: ${value}`)
  if (typeof evidence.wroteClipboard !== 'boolean') throw new Error(`Terminal smoke evidence has invalid wroteClipboard: ${value}`)
  if (typeof evidence.copiedMarker !== 'boolean') throw new Error(`Terminal smoke evidence has invalid copiedMarker: ${value}`)
  if (evidence.exitCode !== undefined && evidence.exitCode !== null && !Number.isInteger(evidence.exitCode)) {
    throw new Error(`Terminal smoke evidence has invalid exitCode: ${value}`)
  }
  return evidence as unknown as TerminalSmokeEvidence
}

export function countOccurrences(value: string, search: string): number {
  if (!search) return 0
  let count = 0
  let offset = 0
  while ((offset = value.indexOf(search, offset)) !== -1) {
    count += 1
    offset += search.length
  }
  return count
}