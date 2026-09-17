import { describe, expect, it } from 'bun:test'
import { TERMINAL_COPY_FAILED_MESSAGE, createTerminalCopyAction } from '../src/ui/terminal-copy-feedback.ts'

describe('terminal copy feedback action', () => {
  function setup(writer: (text: string) => void | boolean | Promise<unknown>) {
    const failures: Array<string | undefined> = []
    const action = createTerminalCopyAction({ writer, onFailure: (failure) => failures.push(failure) })
    return { action, failures }
  }

  it('reports a successful write as copied and publishes no failure', async () => {
    const { action, failures } = setup(() => true)
    expect(await action.copy('text')).toBe('copied')
    expect(failures).toEqual([undefined])
  })

  it('reports a definite write failure with the generic message', async () => {
    const { action, failures } = setup(() => false)
    expect(await action.copy('text')).toBe('failed')
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
  })

  it('converts a thrown writer into the same generic failure', async () => {
    const { action, failures } = setup(() => { throw new Error('boom') })
    expect(await action.copy('text')).toBe('failed')
    expect(failures).toEqual([undefined, TERMINAL_COPY_FAILED_MESSAGE])
  })

  it('resolves a superseded attempt as stale even when it would have succeeded', async () => {
    const failures: Array<string | undefined> = []
    let releaseFirst: (value: boolean) => void = () => undefined
    const first = new Promise<boolean>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const action = createTerminalCopyAction({
      writer: () => (++calls === 1 ? first : false),
      onFailure: (failure) => failures.push(failure),
    })
    const stale = action.copy('old')
    expect(await action.copy('new')).toBe('failed')
    releaseFirst(true)
    expect(await stale).toBe('stale')
    // Each attempt clears the previous failure, and the superseded attempt adds nothing after it.
    expect(failures).toEqual([undefined, undefined, TERMINAL_COPY_FAILED_MESSAGE])
  })

  it('resolves every attempt after disposal as stale', async () => {
    const { action, failures } = setup(() => false)
    action.dispose()
    expect(await action.copy('text')).toBe('stale')
    expect(failures).toEqual([])
  })
})
