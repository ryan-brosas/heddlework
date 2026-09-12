import { describe, expect, it } from 'bun:test'
import { portalResponseMatchesToken, requestPortalDirectory } from '../src/ui/portal-file-chooser.ts'
import type { PortalPickerProbe } from '../src/ui/portal-file-chooser.ts'

function handleFor(token: string): string {
  return '/org/freedesktop/portal/desktop/request/1_555/' + token
}

// The portal module drives gdbus/dbus-monitor subprocesses. These tests inject
// a deterministic runner so the status/URI mapping is verified without a live
// desktop session or a real tool dialog.
function portalProbe(response: string | undefined): PortalPickerProbe {
  return {
    run: async (_command, args) => {
      const token = args.at(-1)?.match(/'handle_token': <'([^']+)'>/u)?.[1]
      return token ? "(objectpath '" + handleFor(token) + "',)" : undefined
    },
    monitor: async () => response,
  }
}

describe('requestPortalDirectory', () => {
  it('returns a resolved path for a successful selection', async () => {
    const result = await requestPortalDirectory(portalProbe("uint32 0\n  string 'file:///home/user/project'"))
    expect(result.status).toBe('selected')
    expect(result.path).toBe('/home/user/project')
  })

  it('reports a cancellation without a path', async () => {
    const result = await requestPortalDirectory(portalProbe('uint32 1'))
    expect(result.status).toBe('cancelled')
    expect(result.path).toBeUndefined()
  })

  it('treats a missing handle as unavailable', async () => {
    const result = await requestPortalDirectory({ run: async () => undefined, monitor: async () => undefined })
    expect(result.status).toBe('unavailable')
  })

  it('treats a timed-out or empty response as unavailable', async () => {
    const result = await requestPortalDirectory(portalProbe(undefined))
    expect(result.status).toBe('unavailable')
  })

  it('arms the response monitor before opening the portal', async () => {
    const commands: string[] = []
    let releaseOpen: (() => void) | undefined
    let token = ''
    const run: NonNullable<PortalPickerProbe['run']> = async (command, args) => {
      commands.push(command)
      if (command !== 'gdbus') return undefined
      token = args.at(-1)?.match(/'handle_token': <'([^']+)'>/u)?.[1] ?? ''
      return await new Promise<string>((resolve) => { releaseOpen = () => resolve("(objectpath '" + handleFor(token) + "',)") })
    }
    const monitor: NonNullable<PortalPickerProbe['monitor']> = async (command) => {
      commands.push(command)
      return "uint32 0\n  string 'file:///home/user/project'"
    }

    const pending = requestPortalDirectory({ run, monitor })
    await Bun.sleep(0)
    const commandsBeforeOpenReturns = [...commands]
    releaseOpen?.()
    const result = await pending

    expect(commandsBeforeOpenReturns).toEqual(['dbus-monitor', 'gdbus'])
    expect(result.status).toBe('selected')
  })

  it('matches unquoted dbus-monitor Request paths used on Wayland', async () => {
    const token = 'heddlework_deadbeef'
    const unquoted = [
      `signal sender=:1.42 -> dest=(unset) serial=9 path=/org/freedesktop/portal/desktop/request/1_555/${token}; interface=org.freedesktop.portal.Request; member=Response`,
      '   uint32 0',
      '   array [',
      '      dict entry(',
      '         string "uris"',
      '         variant             array [',
      '               string "file:///tmp/project"',
      '            ]',
      '      )',
      '   ]',
    ].join('\n')
    expect(portalResponseMatchesToken(unquoted, token)).toBe(true)
    expect(portalResponseMatchesToken(unquoted, 'heddlework_other')).toBe(false)
    expect(portalResponseMatchesToken(`path='/org/freedesktop/portal/desktop/request/1_555/${token}'`, token)).toBe(true)

    const result = await requestPortalDirectory({
      run: async (_command, args) => {
        const opened = args.at(-1)?.match(/'handle_token': <'([^']+)'>/u)?.[1]
        return opened ? "(objectpath '" + handleFor(opened) + "',)" : undefined
      },
      monitor: async (_command, _args, _timeout, opened) => unquoted.replace(token, opened),
    })
    expect(result.status).toBe('selected')
    expect(result.path).toBe('/tmp/project')
  })
})
