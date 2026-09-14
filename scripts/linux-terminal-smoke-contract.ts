export const TERMINAL_COPY_SOURCE = 'HEDDLEWORK_TERMINAL_COPY_SOURCE'
export const TERMINAL_PASTE_ECHO = 'HEDDLEWORK_TERMINAL_PASTE_ECHO:'
export const TERMINAL_INTERRUPT_MARKER = 'HEDDLEWORK_TERMINAL_INTERRUPT_OK'
export const TERMINAL_EVIDENCE_TEST_ID = 'terminal-evidence'

/**
 * Deterministic PTY child shared by the Linux compositor smoke and the headless PTY tests.
 *
 * It prints one copyable marker, then reads raw bytes from the PTY and reports two things: the
 * marker coming back on stdin (the paste payload the clipboard returned), and the ETX byte that
 * plain Ctrl+C writes. The marker is echoed only when it appears, which keeps the transcript short
 * enough that every assertion reads the live viewport no matter how far the paste scrolled.
 *
 * Everything is byte-level on purpose. Ctrl+C reaches a real shell as SIGINT only when the PTY
 * slave has a foreground process group (`tpgid`), which requires the child to own the controlling
 * terminal; that holds for a desktop launch but not in a container or CI-lane environment, where
 * the kernel echoes the ETX byte and delivers no signal (measured: `tpgid=-1`, child survives, on
 * Docker with and without `--privileged`). Asserting the byte our dispatch owns keeps this lane
 * meaningful everywhere and leaves tty signal delivery to manual compositor acceptance.
 */
export const TERMINAL_SMOKE_SHELL = [
  `ETX=$(printf '\\003')`,
  `MARKER=${TERMINAL_COPY_SOURCE}`,
  `stty -isig -icanon min 1 time 0 -echo 2>/dev/null`,
  `printf 'HEDDLEWORK_TERMINAL_TTY pgrp_session_tpgid='; cut -d' ' -f5,6,8 /proc/$$/stat`,
  `printf '%s\\n' "$MARKER"`,
  `window=''`,
  `while :; do`,
  `  chunk=$(dd bs=4096 count=1 2>/dev/null)`,
  `  window="$window$chunk"`,
  `  # Plain Ctrl+C must arrive as exactly one ETX and nothing else: a shortcut that leaked the`,
  `  # interrupt byte would otherwise still look like a passing interrupt.`,
  `  case "$window" in`,
  `    "$ETX") printf '\\n%s\\n' ${TERMINAL_INTERRUPT_MARKER}; exit 0;;`,
  `    *"$ETX"*) printf '\\n%s\\nunexpected-bytes=%s\\n' ${TERMINAL_INTERRUPT_MARKER} "$(printf '%s' "$window" | wc -c)"; exit 3;;`,
  `  esac`,
  `  case "$window" in *"$MARKER"*) printf '%s%s\\n' ${TERMINAL_PASTE_ECHO} "$MARKER"; window='';; esac`,
  `  [ -n "$chunk" ] || break`,
  `  [ "\${#window}" -le 4096 ] || window=$(printf '%s' "$window" | tail -c 4096)`,
  `done`,
].join('\n')

export interface TerminalSmokeEvidence {
  readonly text: string
  readonly status: 'running' | 'exited'
  readonly exitCode?: number | null
  readonly copyCalls: number
  readonly wroteClipboard: boolean
  readonly copiedMarker: boolean
}

export interface TerminalSmokeCopyState {
  readonly calls: number
  readonly wroteClipboard: boolean
  readonly text: string
}

/**
 * Single source for the evidence document's field names and derived flags. The native fixture, the
 * lane harness and the parser all agree through this function instead of duplicating the shape.
 */
export function formatTerminalSmokeEvidence(input: {
  readonly text: string
  readonly status: 'running' | 'exited'
  readonly exitCode?: number | null
  readonly copy: TerminalSmokeCopyState
}): string {
  return JSON.stringify({
    text: input.text,
    status: input.status,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    copyCalls: input.copy.calls,
    wroteClipboard: input.copy.wroteClipboard,
    copiedMarker: input.copy.text.includes(TERMINAL_COPY_SOURCE),
  })
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