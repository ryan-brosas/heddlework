import { describe, expect, it } from 'bun:test'
import { RemoteWorkbenchController } from '../src/dom/remote-controller.ts'
import { notifyFailure } from '../src/ui/failure-notice.ts'
import type { NoticeKind } from '../src/workbench/state.ts'
import type { WorkspaceClient } from '../src/web/client.ts'

interface RecordedNotice { kind: NoticeKind; message: string }

function recordingController(notices: RecordedNotice[]): { notify(kind: NoticeKind, message: string): void } {
  return { notify: (kind, message) => { notices.push({ kind, message }) } }
}

/**
 * The desktop host routes \`unhandledRejection\` to \`shutdown\`, which exits the process, so a
 * UI affordance that cannot await its promise has to report the failure itself. These tests pin
 * that contract and the rejectable surface that makes it necessary.
 */
describe('fire-and-forget UI failures', () => {
  it('reports a rejected affordance as an error notice', async () => {
    const notices: RecordedNotice[] = []
    void Promise.reject(new Error('no folder picker is available'))
      .catch(notifyFailure(recordingController(notices), 'Could not open the folder picker'))
    await Bun.sleep(0)
    expect(notices).toEqual([{ kind: 'error', message: 'Could not open the folder picker: no folder picker is available' }])
  })

  it('stringifies rejections that are not Error instances', async () => {
    const notices: RecordedNotice[] = []
    void Promise.reject('plain string').catch(notifyFailure(recordingController(notices), 'Could not send the message'))
    await Bun.sleep(0)
    expect(notices).toEqual([{ kind: 'error', message: 'Could not send the message: plain string' }])
  })

  it('keeps the rejection away from the process-level net that shuts the host down', async () => {
    let escaped = 0
    const onEscape = (): void => { escaped += 1 }
    process.on('unhandledRejection', onEscape)
    try {
      void Promise.reject(new Error('clipboard unavailable'))
        .catch(notifyFailure(recordingController([]), 'Could not copy to clipboard'))
      await Bun.sleep(0)
      await Bun.sleep(0)
    } finally {
      process.off('unhandledRejection', onEscape)
    }
    expect(escaped).toBe(0)
  })

  it('rejects from the remote workbench surface, which is why UI call sites guard it', async () => {
    const reported: unknown[] = []
    const client = {
      getSnapshot: () => ({ state: undefined }),
      subscribe: () => () => {},
      send: async () => { throw new Error('socket closed') },
      reportError: (error: unknown) => { reported.push(error) },
      reconnect: () => {},
    } as unknown as WorkspaceClient
    const controller = new RemoteWorkbenchController(client)
    await expect(controller.submit('hello')).rejects.toThrow('socket closed')
    expect(reported).toHaveLength(1)
  })
})
