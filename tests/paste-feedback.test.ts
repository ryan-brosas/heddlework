import { describe, expect, it } from 'bun:test'
import { PASTE_FAILED_MESSAGE, createPasteAction } from '../src/ui/paste-feedback.ts'

describe('paste feedback action', () => {
  it('returns the clipboard text for an attempt that read something', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.resolve('from the clipboard'), onFailure: (failure) => failures.push(failure) })
    expect(await action.paste()).toBe('from the clipboard')
    expect(failures).toEqual([undefined])
  })

  it('reports an empty clipboard with the shared message instead of dropping the gesture', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.resolve(undefined), onFailure: (failure) => failures.push(failure) })
    expect(await action.paste()).toBeUndefined()
    expect(failures).toEqual([undefined, PASTE_FAILED_MESSAGE])
  })

  it('treats an empty string as nothing pasted', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.resolve(''), onFailure: (failure) => failures.push(failure) })
    expect(await action.paste()).toBeUndefined()
    expect(failures).toEqual([undefined, PASTE_FAILED_MESSAGE])
  })

  it('converts a rejected read into the same reported failure', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.reject(new Error('no clipboard helper')), onFailure: (failure) => failures.push(failure) })
    expect(await action.paste()).toBeUndefined()
    expect(failures).toEqual([undefined, PASTE_FAILED_MESSAGE])
  })

  it('uses a surface-specific message when one is given', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.resolve(undefined), onFailure: (failure) => failures.push(failure), message: 'Could not paste into the page.' })
    await action.paste()
    expect(failures).toEqual([undefined, 'Could not paste into the page.'])
  })

  it('gives a superseded attempt no text to insert', async () => {
    const failures: Array<string | undefined> = []
    let releaseFirst: (value: string) => void = () => undefined
    const first = new Promise<string>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const action = createPasteAction({
      read: () => (++calls === 1 ? first : Promise.resolve('newest')),
      onFailure: (failure) => failures.push(failure),
    })
    const stale = action.paste()
    expect(await action.paste()).toBe('newest')
    releaseFirst('older')
    expect(await stale).toBeUndefined()
    // Each attempt clears the previous failure, and the superseded attempt adds nothing after it.
    expect(failures).toEqual([undefined, undefined])
  })

  it('resolves every attempt after disposal without publishing', async () => {
    const failures: Array<string | undefined> = []
    const action = createPasteAction({ read: () => Promise.resolve('text'), onFailure: (failure) => failures.push(failure) })
    action.dispose()
    expect(await action.paste()).toBeUndefined()
    expect(failures).toEqual([])
  })
})
