import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureProcessOutput, directoryPickerCommand, directoryPickerCommands, pickWorkspaceDirectory, systemTargetCommand } from '../src/ui/open-external.ts'

describe('external targets', () => {
  it('passes Windows URLs as one argument without invoking a command shell', () => {
    const target = 'https://example.com/?next=a&then=b|c'
    expect(systemTargetCommand(target, 'win32')).toEqual({ command: 'explorer.exe', args: [target] })
    expect(systemTargetCommand(target, 'darwin')).toEqual({ command: '/usr/bin/open', args: [target] })
  })
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

  it('falls back from kdialog to zenity on Linux after the portal is unavailable', () => {
    const pickers = directoryPickerCommands('linux')
    expect(pickers).toHaveLength(2)
    expect(pickers[0]).toMatchObject({ command: 'kdialog' })
    expect(pickers[1]).toMatchObject({ command: 'zenity' })
    expect(pickers[1]?.args).toContain('--file-selection')
  })

  it('uses the portal selection on Linux and does not open a CLI fallback', async () => {
    const result = await pickWorkspaceDirectory('linux', {
      requestPortal: async () => ({ status: 'selected', path: '/tmp/heddlework-project' }),
      capture: async () => {
        throw new Error('CLI fallback must not run after a portal selection')
      },
    })
    expect(result).toEqual({ path: '/tmp/heddlework-project' })
  })

  it('treats a portal cancel as a dismiss and does not open a CLI fallback', async () => {
    const result = await pickWorkspaceDirectory('linux', {
      requestPortal: async () => ({ status: 'cancelled' }),
      capture: async () => {
        throw new Error('CLI fallback must not run after a portal cancel')
      },
    })
    expect(result).toEqual({})
  })

  it('degrades to kdialog when the portal is unavailable', async () => {
    const commands: string[] = []
    const result = await pickWorkspaceDirectory('linux', {
      requestPortal: async () => ({ status: 'unavailable', error: 'File dialog portal is not reachable' }),
      capture: async (command) => {
        commands.push(command)
        return command === 'kdialog' ? '/tmp/from-kdialog\n' : undefined
      },
    })
    expect(commands[0]).toBe('kdialog')
    expect(result.path).toBe('/tmp/from-kdialog')
  })

  it('offers a single picker on macOS and Windows', () => {
    expect(directoryPickerCommands('darwin')).toHaveLength(1)
    expect(directoryPickerCommands('win32')).toHaveLength(1)
  })
})