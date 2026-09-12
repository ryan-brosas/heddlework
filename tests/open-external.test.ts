import { describe, expect, it } from 'bun:test'
import { directoryPickerCommand, directoryPickerCommands, pickWorkspaceDirectory, systemTargetCommand } from '../src/ui/open-external.ts'

describe('external targets', () => {
  it('passes Windows URLs as one argument without invoking a command shell', () => {
    const target = 'https://example.com/?next=a&then=b|c'
    expect(systemTargetCommand(target, 'win32')).toEqual({ command: 'explorer.exe', args: [target] })
    expect(systemTargetCommand(target, 'darwin')).toEqual({ command: '/usr/bin/open', args: [target] })
  })
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
    const result = await pickWorkspaceDirectory(
      'linux',
      async () => ({ status: 'selected', path: '/tmp/heddlework-project' }),
      async () => {
        throw new Error('CLI fallback must not run after a portal selection')
      },
    )
    expect(result).toEqual({ path: '/tmp/heddlework-project' })
  })

  it('treats a portal cancel as a dismiss and does not open a CLI fallback', async () => {
    const result = await pickWorkspaceDirectory(
      'linux',
      async () => ({ status: 'cancelled' }),
      async () => {
        throw new Error('CLI fallback must not run after a portal cancel')
      },
    )
    expect(result).toEqual({})
  })

  it('degrades to kdialog when the portal is unavailable', async () => {
    const commands: string[] = []
    const result = await pickWorkspaceDirectory(
      'linux',
      async () => ({ status: 'unavailable', error: 'File dialog portal is not reachable' }),
      async (command) => {
        commands.push(command)
        return command === 'kdialog' ? '/tmp/from-kdialog\n' : undefined
      },
    )
    expect(commands[0]).toBe('kdialog')
    expect(result.path).toBe('/tmp/from-kdialog')
  })

  it('offers a single picker on macOS and Windows', () => {
    expect(directoryPickerCommands('darwin')).toHaveLength(1)
    expect(directoryPickerCommands('win32')).toHaveLength(1)
  })
})