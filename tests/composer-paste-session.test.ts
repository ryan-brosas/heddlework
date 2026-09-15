import { describe, expect, it } from 'bun:test'
import type { ComposerImage } from '../src/pi/types.ts'
import { attachClipboardImage, hasSubmittableDraft, pasteTargetsSameSession } from '../src/ui/clipboard-paste-text.ts'

const image: ComposerImage = { type: 'image', data: 'AA==', mimeType: 'image/png', id: 'clipboard-1', fileName: 'clipboard.png', size: 1 }

/** A clipboard read whose result this test decides, standing in for the asynchronous helper. */
function deferredRead() {
  let resolve: (value: ComposerImage | undefined) => void = () => {}
  const promise = new Promise<ComposerImage | undefined>((settle) => { resolve = settle })
  return { read: () => promise, resolve }
}

describe('clipboard image paste and the open thread', () => {
  it('attaches the image when the thread did not change during the read', async () => {
    const attached: ComposerImage[] = []
    const outcome = await attachClipboardImage({
      startedSessionFile: '/sessions/one.jsonl',
      currentSessionFile: () => '/sessions/one.jsonl',
      readImage: async () => image,
      attachImage: (value) => attached.push(value),
    })
    expect(outcome).toBe('attached')
    expect(attached).toEqual([image])
  })

  it('drops an image whose read finished after the user switched threads', async () => {
    // The regression: the composer tracked the thread in a ref that a React effect updates after the render
    // that switched sessions, so a read resolving inside that window attached the previous thread's image
    // to the thread now on screen. The guard re-reads the current thread instead of comparing a captured one.
    const attached: ComposerImage[] = []
    const read = deferredRead()
    let currentSessionFile = '/sessions/one.jsonl'
    const pending = attachClipboardImage({
      startedSessionFile: currentSessionFile,
      currentSessionFile: () => currentSessionFile,
      readImage: read.read,
      attachImage: (value) => attached.push(value),
    })
    // The switch publishes the new session before the clipboard helper answers.
    currentSessionFile = '/sessions/two.jsonl'
    read.resolve(image)
    expect(await pending).toBe('stale')
    expect(attached).toEqual([])
  })

  it('reports a clipboard with no image without blaming the thread', async () => {
    const attached: ComposerImage[] = []
    const outcome = await attachClipboardImage({
      startedSessionFile: '/sessions/one.jsonl',
      currentSessionFile: () => '/sessions/one.jsonl',
      readImage: async () => undefined,
      attachImage: (value) => attached.push(value),
    })
    expect(outcome).toBe('unavailable')
    expect(attached).toEqual([])
  })

  it('keeps the guard the same for a switch that keeps the same session file', () => {
    expect(pasteTargetsSameSession('/sessions/one.jsonl', '/sessions/one.jsonl')).toBe(true)
    expect(pasteTargetsSameSession('/sessions/one.jsonl', '/sessions/two.jsonl')).toBe(false)
  })

  it('counts an image attached while a submit waited as a submittable draft', () => {
    // The regression: the submit that waited for a paste ran in the closure of the render before the image
    // existed, so an image-only paste found an empty text and a stale empty attachment list and sent nothing.
    expect(hasSubmittableDraft('', [image])).toBe(true)
    expect(hasSubmittableDraft('   ', [image])).toBe(true)
    expect(hasSubmittableDraft('text', [])).toBe(true)
    expect(hasSubmittableDraft('   ', [])).toBe(false)
  })

  it('decides a submit from the live attachments, not from render state', async () => {
    const source = await Bun.file(new URL('../src/ui/composer.tsx', import.meta.url)).text()
    expect(source).toContain('if (!hasSubmittableDraft(value, controller.getSnapshot().editorImages))')
  })

  it('reads the open thread from the controller, not from React state', async () => {
    // The unit above proves the guard works when it is given the live thread; this proves the composer gives
    // it the live thread. Both are needed: a stale value passed in would pass the guard.
    const source = await Bun.file(new URL('../src/ui/composer.tsx', import.meta.url)).text()
    // The live thread comes from the controller snapshot, which the switch updates synchronously...
    expect(source).toContain('const currentSessionFile = (): string => controller.getSnapshot().session.sessionFile')
    // ...and the asynchronous checks no longer compare against the ref a React effect updates.
    expect(source).not.toMatch(/pasteTargetsSameSession\([^)]*sessionFileRef\.current/u)
    expect(source).toContain('currentSessionFile,')
  })
})
