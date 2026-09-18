import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureProcessOutput, classifyPickerExit, directoryPickerCommand, directoryPickerCommands, openExternal, openPath, pickWorkspaceDirectory, runPickerCommand, systemTargetCommand } from '../src/ui/open-external.ts'

describe('external targets', () => {
  it('passes Windows URLs as one argument without invoking a command shell', () => {
    const target = 'https://example.com/?next=a&then=b|c'
    expect(systemTargetCommand(target, 'win32')).toEqual({ command: 'explorer.exe', args: [target] })
    expect(systemTargetCommand(target, 'darwin')).toEqual({ command: '/usr/bin/open', args: [target] })
  })
})

describe('external launch reporting', () => {
  it('refuses a scheme it must not hand to the system opener', async () => {
    expect(await openExternal('file:///etc/passwd')).toBe(false)
    expect(await openExternal('javascript:alert(1)')).toBe(false)
    expect(await openExternal('not a url at all')).toBe(false)
  })

  it('reports whether the launcher started, without starting one', async () => {
    // The launcher is injectable so this stays a real spawn without opening a browser here.
    expect(await openExternal('https://example.com', { command: { command: '/bin/true', args: [] } })).toBe(true)
    expect(await openExternal('https://example.com', { command: { command: '/dev/null/heddlework-opener', args: [] } })).toBe(false)
    expect(await openPath('/tmp/project', { command: { command: '/dev/null/heddlework-opener', args: [] } })).toBe(false)
  }, 10_000)
})

describe('bounded CLI picker fallback', () => {
  it('bounds a picker that never settles instead of leaving Open project pending', async () => {
    const started = performance.now()
    const output = await captureProcessOutput('/bin/sh', ['-c', 'sleep 30'], 200)
    expect(output).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(2_000)
  }, 6_000)

  it('still returns the output of a picker that finishes inside the bound', async () => {
    expect(await captureProcessOutput('/bin/sh', ['-c', 'printf /tmp/from-picker'], 5_000)).toBe('/tmp/from-picker')
  }, 8_000)

  it('escalates to SIGKILL when a picker ignores SIGTERM', async () => {
    // A blocked KDE/Qt service can leave kdialog alive past its bound; the escalation must outlive the
    // settled result, so this asserts the child is really gone rather than just that the promise resolved.
    const directory = mkdtempSync(join(tmpdir(), 'hw-picker-kill-'))
    const pidPath = join(directory, 'pid')
    let pid: number | undefined
    const alive = (): boolean => {
      if (pid === undefined) return false
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      const output = await captureProcessOutput('/bin/sh', ['-c', `printf '%s' "$$" > "${pidPath}"; trap '' TERM; while :; do sleep 1; done`], 300)
      pid = Number(readFileSync(pidPath, 'utf8'))
      expect(output).toBeUndefined()
      const deadline = performance.now() + 2_000
      while (alive() && performance.now() < deadline) await Bun.sleep(20)
      expect(alive()).toBe(false)
    } finally {
      if (alive()) process.kill(pid!, 'SIGKILL')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 6_000)
})

describe('workspace directory picker', () => {
  it('uses each platform native folder chooser instead of a path text form', () => {
    expect(directoryPickerCommand('darwin')).toMatchObject({ command: '/usr/bin/osascript' })
    expect(directoryPickerCommand('darwin')?.args.join(' ')).toContain('choose folder')
    expect(directoryPickerCommand('win32')).toMatchObject({ command: 'powershell.exe' })
    expect(directoryPickerCommand('win32')?.args.join(' ')).toContain('FolderBrowserDialog')
    expect(directoryPickerCommand('linux')).toMatchObject({ command: 'kdialog' })
    expect(directoryPickerCommand('linux')?.args).toContain('--getexistingdirectory')
  })

  it('falls back from kdialog to zenity on Linux when the first picker cannot run', () => {
    const pickers = directoryPickerCommands('linux')
    expect(pickers).toHaveLength(2)
    expect(pickers[0]).toMatchObject({ command: 'kdialog' })
    expect(pickers[1]).toMatchObject({ command: 'zenity' })
    expect(pickers[1]?.args).toContain('--file-selection')
  })

  it('uses the first picker that selects a folder and never opens a second dialog', async () => {
    const opened: string[] = []
    const result = await pickWorkspaceDirectory('linux', {
      runPicker: async (picker) => {
        opened.push(picker.command)
        return { kind: 'selected', path: '/tmp/heddlework-project' }
      },
    })
    expect(result).toEqual({ path: '/tmp/heddlework-project' })
    expect(opened).toEqual(['kdialog'])
  })

  it('treats a dismissal as no selection and reports no error', async () => {
    const opened: string[] = []
    const result = await pickWorkspaceDirectory('linux', {
      runPicker: async (picker) => {
        opened.push(picker.command)
        return { kind: 'cancelled' }
      },
    })
    expect(result).toEqual({})
    expect(opened).toEqual(['kdialog'])
  })

  it('falls through to the next picker when the first one cannot run', async () => {
    const opened: string[] = []
    const result = await pickWorkspaceDirectory('linux', {
      runPicker: async (picker) => {
        opened.push(picker.command)
        return picker.command === 'kdialog' ? { kind: 'unavailable' } : { kind: 'selected', path: '/tmp/from-zenity' }
      },
    })
    expect(opened).toEqual(['kdialog', 'zenity'])
    expect(result.path).toBe('/tmp/from-zenity')
  })

  it('reports an error only when no picker can run', async () => {
    const result = await pickWorkspaceDirectory('linux', { runPicker: async () => ({ kind: 'unavailable' }) })
    expect(result.error).toContain('kdialog')
  })

  it('offers a single picker on macOS and Windows', () => {
    expect(directoryPickerCommands('darwin')).toHaveLength(1)
    expect(directoryPickerCommands('win32')).toHaveLength(1)
  })
})
describe('picker outcome classification', () => {
  it('reads a selection from a picker that printed a path', async () => {
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'printf /tmp/chosen'] })).toEqual({ kind: 'selected', path: '/tmp/chosen' })
  })

  it('ignores output from a picker that exited with a failure status', async () => {
    // kdialog prints diagnostics before failing; that text must not become the chosen folder.
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'printf /tmp/not-chosen; exit 2'] })).toEqual({ kind: 'unavailable' })
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'printf /tmp/chosen; exit 0'] })).toEqual({ kind: 'selected', path: '/tmp/chosen' })
  })

  it('reads a dismissal from a picker that was dismissed without output', async () => {
    // kdialog exits 1 with no output when its dialog is dismissed: a decision, not a failure.
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'exit 1'] })).toEqual({ kind: 'cancelled' })
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'exit 0'] })).toEqual({ kind: 'cancelled' })
  })

  it('reports a picker that cannot be spawned as unavailable', async () => {
    expect(await runPickerCommand({ command: '/dev/null/heddlework-picker', args: [] })).toEqual({ kind: 'unavailable' })
  })

  it('separates a dismissal from a picker that ran and failed', async () => {
    // kdialog exits 1 when its dialog is dismissed; any other status is the picker failing, and
    // reading it as a dismissal swallowed the failure and made Open project look like a no-op.
    expect(classifyPickerExit(0)).toEqual({ kind: 'cancelled' })
    expect(classifyPickerExit(1)).toEqual({ kind: 'cancelled' })
    expect(classifyPickerExit(2)).toEqual({ kind: 'unavailable' })
    expect(classifyPickerExit(undefined)).toEqual({ kind: 'unavailable' })
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'exit 1'] })).toEqual({ kind: 'cancelled' })
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'exit 2'] })).toEqual({ kind: 'unavailable' })
    // A picker that failed and printed nothing must not be read as a dismissal either.
    expect(await runPickerCommand({ command: '/bin/sh', args: ['-c', 'exit 3'] })).toEqual({ kind: 'unavailable' })
  })
})
