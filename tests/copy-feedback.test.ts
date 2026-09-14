import { describe, expect, it } from 'bun:test'
import { COPY_FAILED_MESSAGE, createCopyAction } from '../src/ui/copy-feedback.ts'

describe('copy feedback action', () => {
  it('reports a successful write as copied and publishes no failure', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => true, onFailure: (failure) => failures.push(failure) })
    expect(await action.copy('text')).toBe('copied')
    expect(failures).toEqual([undefined])
  })

  it('reports a definite write failure with the shared message', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => false, onFailure: (failure) => failures.push(failure) })
    expect(await action.copy('text')).toBe('failed')
    expect(failures).toEqual([undefined, COPY_FAILED_MESSAGE])
  })

  it('converts a thrown writer into the same generic failure', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({
      writer: () => { throw new Error('boom') },
      onFailure: (failure) => failures.push(failure),
    })
    expect(await action.copy('text')).toBe('failed')
    expect(failures).toEqual([undefined, COPY_FAILED_MESSAGE])
  })

  it('resolves a superseded attempt as stale even when it would have succeeded', async () => {
    const failures: Array<string | undefined> = []
    let releaseFirst: (value: boolean) => void = () => undefined
    const first = new Promise<boolean>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const action = createCopyAction({
      writer: () => (++calls === 1 ? first : false),
      onFailure: (failure) => failures.push(failure),
    })
    const stale = action.copy('old')
    expect(await action.copy('new')).toBe('failed')
    releaseFirst(true)
    expect(await stale).toBe('stale')
    // Each attempt clears the previous failure, and the superseded attempt adds nothing after it.
    expect(failures).toEqual([undefined, undefined, COPY_FAILED_MESSAGE])
  })

  it('resolves every attempt after disposal as stale', async () => {
    const failures: Array<string | undefined> = []
    const action = createCopyAction({ writer: () => false, onFailure: (failure) => failures.push(failure) })
    action.dispose()
    expect(await action.copy('text')).toBe('stale')
    expect(failures).toEqual([])
  })
})
