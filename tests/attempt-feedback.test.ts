import { describe, expect, it } from 'bun:test'
import { createLatestAttempt } from '../src/ui/attempt-feedback.ts'
import { LINK_FAILED_MESSAGE } from '../src/ui/external-launch.ts'

/**
 * The ordering and reporting rule shared by the clipboard and the external-link surfaces. The
 * clipboard's own behavior is pinned in `copy-feedback.test.ts`; these cases cover the launch
 * shape, where a refusal is a `false` result and a missing opener is a rejection.
 */
describe('latest attempt feedback', () => {
  it('reports a refused launch and a rejected one with the shared link message', async () => {
    const failures: Array<string | undefined> = []
    const attempt = (run: () => Promise<boolean>) => createLatestAttempt<string>({
      run,
      onFailure: (failure) => failures.push(failure),
      message: LINK_FAILED_MESSAGE,
    })
    expect(await attempt(async () => false).run('https://example.com')).toBe('failed')
    expect(await attempt(async () => { throw new Error('no opener') }).run('https://example.com')).toBe('failed')
    expect(failures).toEqual([undefined, LINK_FAILED_MESSAGE, undefined, LINK_FAILED_MESSAGE])
  })

  it('stays quiet when the launch starts', async () => {
    const failures: Array<string | undefined> = []
    const action = createLatestAttempt<string>({ run: async () => true, onFailure: (failure) => failures.push(failure), message: LINK_FAILED_MESSAGE })
    expect(await action.run('https://example.com')).toBe('done')
    expect(failures).toEqual([undefined])
  })

  it('lets the newest launch own the message when an older one completes late', async () => {
    const failures: Array<string | undefined> = []
    let release: (() => void) | undefined
    const slow = new Promise<boolean>((resolveSlow) => { release = () => resolveSlow(false) })
    let call = 0
    const action = createLatestAttempt<string>({
      run: async () => (++call === 1 ? slow : true),
      onFailure: (failure) => failures.push(failure),
      message: LINK_FAILED_MESSAGE,
    })
    const first = action.run('https://first.example.com')
    expect(await action.run('https://second.example.com')).toBe('done')
    release?.()
    expect(await first).toBe('stale')
    expect(failures).not.toContain(LINK_FAILED_MESSAGE)
  })

  it('publishes nothing after disposal', async () => {
    const failures: Array<string | undefined> = []
    const action = createLatestAttempt<string>({ run: async () => false, onFailure: (failure) => failures.push(failure), message: LINK_FAILED_MESSAGE })
    action.dispose()
    expect(await action.run('https://example.com')).toBe('stale')
    expect(failures).toEqual([])
  })
})
