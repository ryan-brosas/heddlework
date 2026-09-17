import { describe, expect, it } from 'bun:test'
import { portalResponseMatchesToken, portalResponseRecordIsComplete, portalSignalForToken, requestPortalDirectory, runPortalMonitor } from '../src/ui/portal-file-chooser.ts'
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
    monitor: async (_command, _args, _timeoutMs, token) =>
      (response === undefined ? undefined : signalHeader(token) + '\n' + response),
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
    const monitor: NonNullable<PortalPickerProbe['monitor']> = async (command, _args, _timeoutMs, armed) => {
      commands.push(command)
      return signalHeader(armed) + "\nuint32 0\n  string 'file:///home/user/project'"
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

/** One dbus-monitor Response record header, as Wayland prints it (unquoted request path). */
function signalHeader(requestToken: string): string {
  return 'signal sender=:1.42 -> dest=(unset) serial=9 path=/org/freedesktop/portal/desktop/request/1_555/'
    + requestToken + '; interface=org.freedesktop.portal.Request; member=Response'
}

function responseRecord(requestToken: string, code: number, uri?: string): string {
  const header = signalHeader(requestToken)
  if (!uri) return [header, '   uint32 ' + code].join('\n')
  return [
    header,
    '   uint32 ' + code,
    '   array [',
    '      dict entry(',
    '         string "uris"',
    '         variant             array [',
    '               string "' + uri + '"',
    '            ]',
    '      )',
    '   ]',
  ].join('\n')
}

// dbus-monitor is session-wide, so a probe must be able to answer with the token it was armed for.
function probeWithResponse(response: (token: string) => string | undefined): PortalPickerProbe {
  return {
    run: async (_command, args) => {
      const token = args.at(-1)?.match(/'handle_token': <'([^']+)'>/u)?.[1]
      return token ? "(objectpath '" + handleFor(token) + "',)" : undefined
    },
    monitor: async (_command, _args, _timeoutMs, token) => response(token),
  }
}

describe('portal response ownership', () => {
  it('ignores another application response mixed into the same capture', async () => {
    // A faster portal client (a browser's own file picker, a GTK dialog) can land its Response in the
    // capture before ours. Reading the first uint32/URI out of the whole buffer adopts a stranger's
    // selection as the picked folder, so only the record carrying our handle_token may be read.
    const result = await requestPortalDirectory(probeWithResponse((token) => [
      responseRecord('heddlework_other', 0, 'file:///tmp/OTHER-APP-PICK'),
      responseRecord(token, 1),
    ].join('\n')))
    expect(result.status).toBe('cancelled')
    expect(result.path).toBeUndefined()
  })

  it('reports unavailable when the capture holds no response for this request', async () => {
    const result = await requestPortalDirectory(
      probeWithResponse(() => responseRecord('heddlework_other', 0, 'file:///tmp/OTHER-APP-PICK')),
    )
    expect(result.status).toBe('unavailable')
  })

  it('reads this request own response even when a stranger answered first', async () => {
    const result = await requestPortalDirectory(probeWithResponse((token) => [
      responseRecord('heddlework_other', 0, 'file:///tmp/OTHER-APP-PICK'),
      responseRecord(token, 0, 'file:///tmp/OUR-PICK'),
    ].join('\n')))
    expect(result.status).toBe('selected')
    expect(result.path).toBe('/tmp/OUR-PICK')
  })

  it('selects the record whose request path carries the token', () => {
    const capture = [responseRecord('heddlework_other', 0, 'file:///tmp/OTHER-APP-PICK'), responseRecord('heddlework_mine', 1)].join('\n')
    expect(portalSignalForToken(capture, 'heddlework_mine')).toContain('uint32 1')
    expect(portalSignalForToken(capture, 'heddlework_mine')).not.toContain('OTHER-APP-PICK')
    expect(portalSignalForToken(capture, 'heddlework_missing')).toBeUndefined()
  })
})

describe('portal response completeness', () => {
  it('holds a success record back until its body closes, and accepts a code-only dismissal', () => {
    const header = signalHeader('heddlework_complete')
    // A success carries the selection in its body, so the code line alone is balanced but empty.
    expect(portalResponseRecordIsComplete([header, '   uint32 0'].join('\n'), 0)).toBe(false)
    expect(portalResponseRecordIsComplete([header, '   uint32 0', '   array [', '      dict entry('].join('\n'), 0)).toBe(false)
    expect(portalResponseRecordIsComplete([header, '   uint32 1'].join('\n'), 1)).toBe(true)
    expect(portalResponseRecordIsComplete([
      header,
      '   uint32 0',
      '   array [',
      '      dict entry(',
      '         string "uris"',
      '         variant             array [',
      '               string "file:///tmp/project [bracketed]"',
      '            ]',
      '      )',
      '   ]',
    ].join('\n'), 0)).toBe(true)
  })

  it('waits for a body that arrives after the response code', async () => {
    // One stdout write per element, with the handle token expanded from $1.
    const writes = [
      ['"signal sender=:1.42 -> dest=(unset) serial=9 path=/org/freedesktop/portal/desktop/request/1_555/$1; interface=org.freedesktop.portal.Request; member=Response"', "'   uint32 0'"],
      ["'   array ['", "''", "'      dict entry('", "''", "'         string \"uris\"'", "''", "'         variant             array ['", "''", "'               string \"file:///tmp/split-project\"'", "''", "'            ]'", "''", "'      )'", "''", "'   ]'"],
    ]
    const script = writes
      .map((args, index) => "printf '%s\\n' " + args.join(' ') + (index < writes.length - 1 ? '\nsleep 0.4' : ''))
      .join('\n')
    const token = 'heddlework_split_body'
    const capture = await runPortalMonitor('/bin/sh', ['-c', script, 'heddlework-probe', token], 5_000, token, new AbortController().signal)
    // Settling on the first write would return a record with no URI at all.
    expect(capture ?? '').toContain('file:///tmp/split-project')
  }, 10_000)

  it('reports the selection through requestPortalDirectory when the URI trails the code', async () => {
    const writes = [
      ['"signal sender=:1.42 -> dest=(unset) serial=9 path=/org/freedesktop/portal/desktop/request/1_555/$1; interface=org.freedesktop.portal.Request; member=Response"', "'   uint32 0'"],
      ["'   array ['", "''", "'      dict entry('", "''", "'         string \"uris\"'", "''", "'         variant             array ['", "''", "'               string \"file:///tmp/split-project\"'", "''", "'            ]'", "''", "'      )'", "''", "'   ]'"],
    ]
    const script = writes
      .map((args, index) => "printf '%s\\n' " + args.join(' ') + (index < writes.length - 1 ? '\nsleep 0.4' : ''))
      .join('\n')
    const result = await requestPortalDirectory({
      run: async (_command, args) => {
        const opened = args.at(-1)?.match(/'handle_token': <'([^']+)'>/u)?.[1]
        return opened ? "(objectpath '" + handleFor(opened) + "',)" : undefined
      },
      monitor: (_command, _args, timeoutMs, token, signal) =>
        runPortalMonitor('/bin/sh', ['-c', script, 'heddlework-probe', token], timeoutMs, token, signal),
    })
    expect(result.status).toBe('selected')
    expect(result.path).toBe('/tmp/split-project')
  }, 10_000)
})
