import { describe, expect, it } from 'bun:test'
import { COPY_FAILED_MESSAGE, createCopyAction } from '../src/ui/copy-feedback.ts'

describe('copy feedback action', () => {
  it('reports success and publishes no failure', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => true, onFailure: (failure) => failures.push(failure) })
    expect(await action.copy('text')).toBe(true)
    expect(failures).toEqual([undefined])
  })

  it('reports a definite write failure with the shared message', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => false, onFailure: (failure) => failures.push(failure) })
    expect(await action.copy('text')).toBe(false)
    expect(failures).toEqual([undefined, COPY_FAILED_MESSAGE])
  })

  it('converts a thrown writer into the same generic failure', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({
      writer: () => { throw new Error('boom') },
      onFailure: (failure) => failures.push(failure),
    })
    expect(await action.copy('text')).toBe(false)
    expect(failures).toEqual([undefined, COPY_FAILED_MESSAGE])
  })

  it('lets the newest attempt win over an older one still in flight', async () => {
    const failures: Array<string | undefined> = []
    let releaseFirst: (value: boolean) => void = () => undefined
    const first = new Promise<boolean>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const action = createCopyAction({
      writer: () => (++calls === 1 ? first : false),
      onFailure: (failure) => failures.push(failure),
    })
    const stale = action.copy('old')
    expect(await action.copy('new')).toBe(false)
    releaseFirst(false)
    expect(await stale).toBe(false)
    // Each attempt clears the previous failure before resolving, and the stale completion
    // publishes nothing: the last value the sink ever saw is the newest attempt's failure.
    expect(failures).toEqual([undefined, undefined, COPY_FAILED_MESSAGE])
  })

  it('ignores completions after disposal', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => false, onFailure: (failure) => failures.push(failure) })
    action.dispose()
    expect(await action.copy('text')).toBe(false)
    expect(failures).toEqual([])
  })
})
