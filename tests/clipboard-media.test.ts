import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createComposerImage, editorTextAfterImagePaste, hydrateMessageImages, runClipboardProcess } from '../src/ui/clipboard-media.ts'

const PNG = readFileSync(resolve(import.meta.dir, 'fixtures/pasted-image.png'))

describe('clipboard media', () => {
  it('removes a native pasted image path only after thumbnail ingestion', () => {
    expect(editorTextAfterImagePaste('Explain ', 'Explain /tmp/screenshot.png')).toBe('Explain ')
    expect(editorTextAfterImagePaste('before after', 'before file:///tmp/screenshot.webp after')).toBe('before after')
    expect(editorTextAfterImagePaste('Explain ', 'Explain ordinary pasted text')).toBe('Explain ordinary pasted text')
  })

  it('creates Pi-compatible image blocks and materializes persisted previews', () => {
    const image = createComposerImage(PNG, 'image/png')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', size: PNG.length })
    expect(existsSync(image.previewPath!)).toBe(true)
    expect(statSync(image.previewPath!).size).toBe(PNG.length)

    const messages = hydrateMessageImages([{
      role: 'user',
      content: [{ type: 'text', text: 'Look' }, { type: 'image', data: image.data, mimeType: image.mimeType }],
    }])
    const content = messages[0]!.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) expect(content[1]?.previewPath).toBeTruthy()
  })
})

describe('clipboard helper completion', () => {
  const itUnix = process.platform === 'win32' ? it.skip : it

  itUnix("resolves on the helper's own exit when a daemonized descendant keeps stdio open", async () => {
    // `wl-copy` and `xclip` fork a selection owner that inherits this process's stdio, so waiting for
    // `close` never fired and every Linux clipboard write stayed pending: terminal copy silently did
    // nothing. Completion must follow the helper's own exit.
    const started = Date.now()
    const result = await runClipboardProcess('/bin/sh', ['-c', 'printf PAYLOAD; (sleep 1) & exit 0'])
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(result.stdout.toString('utf8')).toBe('PAYLOAD')
    expect(elapsed).toBeLessThan(900)
  }, 5_000)

  itUnix('captures the full stdout of a well-behaved helper', async () => {
    const result = await runClipboardProcess('/bin/sh', ['-c', 'printf A; sleep 0.05; printf B'])
    expect(result.ok).toBe(true)
    expect(result.stdout.toString('utf8')).toBe('AB')
  })

  itUnix('treats a nonzero helper exit as a failure', async () => {
    const result = await runClipboardProcess('/bin/sh', ['-c', 'exit 3'])
    expect(result.ok).toBe(false)
  })
})
