import { describe, expect, it } from 'bun:test'
import { classifyNativeResult, pickProjectDirectory, type NativeDirectoryDialog, type NativeDirectoryResult } from '../src/ui/native-directory-picker.ts'

/** A stand-in for the pinned runtime's window-parented dialog. */
function fakeDialog(results: NativeDirectoryResult[]) {
  const titles: string[] = []
  let disposals = 0
  const dialog: NativeDirectoryDialog = {
    open(_renderer, options, listener) {
      titles.push(options.title ?? '(untitled)')
      for (const result of results) listener(result)
      return { dispose() { disposals += 1 } }
    },
  }
  return { dialog, titles, disposals: () => disposals }
}

describe('native directory dialog outcomes', () => {
  it('reads a selection, a dismissal, and a transport failure apart', () => {
    expect(classifyNativeResult({ status: 'selected', path: '/tmp/project' })).toEqual({ kind: 'selected', path: '/tmp/project' })
    expect(classifyNativeResult({ status: 'cancelled' })).toEqual({ kind: 'cancelled' })
    // A success without a path is not a selection.
    expect(classifyNativeResult({ status: 'selected' })).toMatchObject({ kind: 'unavailable' })
    expect(classifyNativeResult({ status: 'unavailable', reason: 'portal lost', safeToFallback: true })).toEqual({ kind: 'unavailable', reason: 'portal lost', safeToFallback: true })
    // Only an explicit verdict authorizes opening a second dialog.
    expect(classifyNativeResult({ status: 'unavailable', reason: 'dialog may be open' })).toMatchObject({ safeToFallback: false })
  })
})

describe('project folder picking', () => {
  it('returns the selection and never runs the CLI fallback', async () => {
    const fake = fakeDialog([{ status: 'selected', path: '/tmp/my folder \u00e9' }])
    let fallbackCalls = 0
    const result = await pickProjectDirectory({}, {
      title: 'Open project in Heddlework',
      dialog: fake.dialog,
      fallback: async () => { fallbackCalls += 1; return { path: '/tmp/from-cli' } },
    })
    expect(result).toEqual({ path: '/tmp/my folder \u00e9' })
    expect(fallbackCalls).toBe(0)
    expect(fake.titles).toEqual(['Open project in Heddlework'])
    expect(fake.disposals()).toBe(1)
  })

  it('treats a dismissal as a decision, not a reason to open a second dialog', async () => {
    const fake = fakeDialog([{ status: 'cancelled' }])
    let fallbackCalls = 0
    const result = await pickProjectDirectory({}, { dialog: fake.dialog, fallback: async () => { fallbackCalls += 1; return { path: '/tmp/from-cli' } } })
    expect(result).toEqual({})
    expect(fallbackCalls).toBe(0)
    expect(fake.disposals()).toBe(1)
  })

  it('falls back only when the runtime says no dialog was opened', async () => {
    const safe = fakeDialog([{ status: 'unavailable', reason: 'no portal', safeToFallback: true }])
    expect(await pickProjectDirectory({}, { dialog: safe.dialog, fallback: async () => ({ path: '/tmp/from-cli' }) })).toEqual({ path: '/tmp/from-cli' })

    const unsafe = fakeDialog([{ status: 'unavailable', reason: 'the open request timed out', safeToFallback: false }])
    let fallbackCalls = 0
    const result = await pickProjectDirectory({}, { dialog: unsafe.dialog, fallback: async () => { fallbackCalls += 1; return { path: '/tmp/from-cli' } } })
    expect(result).toEqual({ error: 'the open request timed out' })
    expect(fallbackCalls).toBe(0)
  })

  it('ignores a late result after the gesture already settled, and still disposes once', async () => {
    const fake = fakeDialog([{ status: 'selected', path: '/tmp/first' }, { status: 'cancelled' }])
    expect(await pickProjectDirectory({}, { dialog: fake.dialog, fallback: async () => ({}) })).toEqual({ path: '/tmp/first' })
    expect(fake.disposals()).toBe(1)
  })

  it('reports a runtime without the capability, and a call that throws, through the CLI fallback', async () => {
    expect(await pickProjectDirectory({}, { fallback: async () => ({ error: 'Could not open a folder picker (kdialog not available)' }) }))
      .toEqual({ error: 'Could not open a folder picker (kdialog not available)' })
    const throwing: NativeDirectoryDialog = { open() { throw new Error('renderer is gone') } }
    expect(await pickProjectDirectory({}, { dialog: throwing, fallback: async () => ({ path: '/tmp/from-cli' }) })).toEqual({ path: '/tmp/from-cli' })
  })
})
