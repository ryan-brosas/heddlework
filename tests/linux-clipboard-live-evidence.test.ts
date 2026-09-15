import { describe, expect, it } from 'bun:test'
import { clipboardStageError, classifyNativeCopy, describeArtifact } from '../scripts/linux-clipboard-live-evidence.ts'

// This is the pinned runtime's diagnostic, not a helper failure or a primary-selection warning.
const noSerial = 'Skipping Wayland clipboard ownership request because no keyboard or pointer press serial has been received'
const selection = 'selected text\nwith Unicode: café 🧵'
const sentinel = 'different clipboard sentinel'
const result = (stdout: string, code = 0, stderrSinceGesture = '') => classifyNativeCopy({
  selectedText: selection, sentinel, read: { stdout, code }, stderrSinceGesture,
})

describe('live clipboard staging evidence', () => {
  it('accepts only a successful write and byte-exact successful read', () => {
    expect(clipboardStageError({ code: 0 }, { code: 0, stdout: sentinel }, sentinel)).toBeUndefined()
    expect(clipboardStageError({ code: 0 }, { code: 0, stdout: `${sentinel}\n` }, sentinel)).toBeDefined()
  })

  it('rejects a failed writer even when old clipboard bytes match', () => {
    expect(clipboardStageError({ code: 1 }, { code: 0, stdout: sentinel }, sentinel)).toBeDefined()
  })

  it('rejects failed and signalled readers even when stdout matches', () => {
    for (const code of [1, -1]) {
      expect(clipboardStageError({ code: 0 }, { code, stdout: sentinel }, sentinel)).toBeDefined()
    }
  })
})

describe('native copy evidence', () => {
  it('passes only an exact successful external read', () => {
    expect(result(selection).status).toBe('pass')
    expect(result(`${selection}\n`).status).toBe('fail')
  })

  it('never passes or skips a failed helper, regardless of its stdout', () => {
    for (const code of [1, -1]) {
      for (const stdout of [selection, sentinel, '']) {
        expect(result(stdout, code, noSerial).status).toBe('inconclusive')
      }
    }
  })

  it('requires a nonempty selection distinct from the staged sentinel', () => {
    for (const selectedText of ['', sentinel]) {
      expect(classifyNativeCopy({ selectedText, sentinel, read: { code: 0, stdout: selectedText }, stderrSinceGesture: '' }).status).toBe('inconclusive')
    }
  })

  it('reports unchanged bytes as a named manual skip, recording which reason was observed', () => {
    const measured = result(sentinel, 0, `runtime: ${noSerial}\n`)
    expect(measured.status).toBe('skip')
    expect(measured.evidence).toContain('physical')
    expect(measured.evidence).toContain('reported no keyboard or pointer press serial')
    // Measured on the installed build: the runtime's diagnostic does not reach stderr today, so the skip must
    // say the reason is source-documented instead of implying the warning was seen.
    const documented = result(sentinel)
    expect(documented.status).toBe('skip')
    expect(documented.evidence).toContain('not observable')
    // The primary-selection warning is a different claim and must not be read as this one.
    expect(result(sentinel, 0, noSerial.replace('clipboard', 'primary selection')).evidence).toContain('not observable')
  })

  it('does not mask wrong bytes with a missing-serial warning', () => {
    expect(result('wrong bytes', 0, noSerial).status).toBe('fail')
  })
})

describe('live probe wiring', () => {
  it('decides the copy check through the classifier and gates both stages by exit status', async () => {
    // Without this, a probe edit could quietly restore a byte-only verdict that accepts a failed helper.
    const source = await Bun.file(new URL('../scripts/linux-clipboard-live-probe.ts', import.meta.url)).text()
    expect(source).toContain('classifyNativeCopy({ selectedText, sentinel, read, stderrSinceGesture: gestureLog })')
    expect(source).toContain('clipboardStageError(pasteWrite, staged, pasteMarker)')
    expect(source).toContain('clipboardStageError(sentinelWrite, stagedBeforeCopy, sentinel)')
  })
})

describe('artifact provenance', () => {
  it('distinguishes a missing artifact, a launcher, and a stale running image', () => {
    expect(describeArtifact({ path: '/x', exists: false, sha256: '', runningPids: [] })).toBe('/x: missing')
    const launched = describeArtifact({ path: '/app', exists: true, sha256: 'abc', launchedFrom: '/bin/launcher', runningPids: [7], runningImage: '/app' })
    expect(launched).toContain('sha256=abc')
    expect(launched).toContain('launcher=/bin/launcher')
    expect(launched).toContain('imageMatchesArtifact=true')
    expect(describeArtifact({ path: '/app', exists: true, sha256: 'abc', runningPids: [] })).toContain('not running')
    expect(describeArtifact({ path: '/app', exists: true, sha256: 'abc', runningPids: [7], runningImage: '/stale' })).toContain('imageMatchesArtifact=false')
  })
})
