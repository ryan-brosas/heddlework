import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { clipboardTextCommands, createComposerImage, editorTextAfterImagePaste, hydrateMessageImages, runClipboardProcess } from '../src/ui/clipboard-media.ts'
import { draftBeforeNativePaste, pasteTargetsSameSession, planPasteSubmit, resolveSubmittedText } from '../src/ui/clipboard-paste-text.ts'

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

describe('native paste bookkeeping', () => {
  it('uses the draft the runtime reported before the insertion', () => {
    // The runtime that performed the insertion is the only owner of "what the draft was": a caret insertion
    // cannot be inverted from the inserted text, and a replacing paste cannot be inverted at all.
    expect(draftBeforeNativePaste({ contentBefore: 'explain ' }, 'explain /tmp/a.png')).toBe('explain ')
    expect(draftBeforeNativePaste({ contentBefore: '' }, 'path')).toBe('')
  })

  it('falls back to the current draft when no pre-paste report arrived', () => {
    // A DOM paste performs the insertion in the browser and reports nothing, and an older runtime has no such
    // field: neither inserted anything the composer needs to undo.
    expect(draftBeforeNativePaste({}, 'current')).toBe('current')
    expect(draftBeforeNativePaste({ contentBefore: 7 }, 'current')).toBe('current')
  })
})

describe('submitting while a paste is pending', () => {
  it('sends the renderer value when no paste is pending', () => {
    expect(planPasteSubmit({ pending: null, claimed: false, eventValue: 'typed' })).toEqual({ action: 'send', text: 'typed' })
  })

  it('waits for a paste that no submit has claimed yet', () => {
    expect(planPasteSubmit({ pending: Promise.resolve(), claimed: false, eventValue: 'typed' })).toEqual({ action: 'wait' })
  })

  it('ignores a second submit for the same paste', () => {
    // Enter pressed twice, or Enter followed by the Send button, must not send the same draft twice.
    expect(planPasteSubmit({ pending: Promise.resolve(), claimed: true, eventValue: 'typed' })).toEqual({ action: 'ignore' })
  })

  it('uses the renderer value when nothing is pending', async () => {
    expect(await resolveSubmittedText({ pending: null, eventValue: 'typed', currentDraft: () => 'stale' })).toBe('typed')
  })

  it('waits for the paste and submits the draft it produced', async () => {
    // Without the wait, Enter sends the pre-paste draft and the pasted text reappears in the composer.
    let draft = 'pre-paste'
    const pending = (async () => { await Bun.sleep(20); draft = 'pre-paste-pasted' })()
    expect(await resolveSubmittedText({ pending, eventValue: draft, currentDraft: () => draft })).toBe('pre-paste-pasted')
  })

  it('keeps the renderer value when the paste added nothing', async () => {
    const pending = (async () => { await Bun.sleep(10) })()
    expect(await resolveSubmittedText({ pending, eventValue: 'kept', currentDraft: () => '' })).toBe('kept')
  })

  it('still submits when the paste read failed', async () => {
    const pending = Promise.reject(new Error('clipboard read failed'))
    expect(await resolveSubmittedText({ pending, eventValue: 'typed', currentDraft: () => 'typed' })).toBe('typed')
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

  itUnix("waits for a reader's stdout to end, because that output is the payload", async () => {
    // The helper exits immediately while a descendant keeps writing to the inherited stdout. An
    // exit-based answer would return only PAYLOAD; a reader's result is complete only once stdout ends.
    const result = await runClipboardProcess(
      '/bin/sh',
      ['-c', 'printf PAYLOAD; (sleep 0.4; printf TAIL) & exit 0'],
      { completion: 'stdout-end' },
    )
    expect(result.ok).toBe(true)
    expect(result.stdout.toString('utf8')).toBe('PAYLOADTAIL')
  }, 8_000)

  it('bounds a helper that never exits and discards incomplete output', async () => {
    const started = performance.now()
    const result = await runClipboardProcess(process.execPath, ['-e', 'process.stdout.write("partial"); setTimeout(() => {}, 1500)'], {
      completion: 'stdout-end', timeoutMs: 200,
    })
    expect(result).toEqual({ ok: false, stdout: Buffer.alloc(0) })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('rejects output exceeding the bound without returning a truncated payload', async () => {
    const result = await runClipboardProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], {
      completion: 'stdout-end', maxBytes: 32,
    })
    expect(result).toEqual({ ok: false, stdout: Buffer.alloc(0) })
  })

  for (const failure of ['timeout', 'output-limit'] as const) {
    itUnix(`kills a helper that ignores SIGTERM after ${failure}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'hw-clipboard-kill-'))
      const pidPath = join(directory, 'pid')
      let pid: number | undefined
      const alive = (): boolean => {
        if (pid === undefined) return false
        try { process.kill(pid, 0); return true } catch { return false }
      }
      try {
        const script = [
          "const { writeFileSync } = require('node:fs')",
          "process.on('SIGTERM', () => {})",
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
          'setInterval(() => {}, 100)',
          failure === 'output-limit' ? 'setTimeout(() => process.stdout.write("x".repeat(8192)), 50)' : '',
        ].join(';')
        const result = await runClipboardProcess(process.execPath, ['-e', script], {
          completion: 'stdout-end', timeoutMs: 1_000, maxBytes: 32,
        })
        pid = Number(readFileSync(pidPath, 'utf8'))
        expect(result).toEqual({ ok: false, stdout: Buffer.alloc(0) })
        const deadline = performance.now() + 1_000
        while (alive() && performance.now() < deadline) await Bun.sleep(20)
        expect(alive()).toBe(false)
      } finally {
        if (alive()) process.kill(pid!, 'SIGKILL')
        rmSync(directory, { recursive: true, force: true })
      }
    }, 5_000)
  }

  it('does not block on noisy stderr or include it in the clipboard payload', async () => {
    const result = await runClipboardProcess(process.execPath, ['-e', 'process.stderr.write("x".repeat(1024 * 1024)); process.stdout.write("ok")'], {
      completion: 'stdout-end', timeoutMs: 1_000,
    })
    expect(result).toEqual({ ok: true, stdout: Buffer.from('ok') })
  }, 3_000)

  itUnix('bounds a reader whose stdio a survivor never releases', async () => {
    // A reader whose stdout is inherited by a long-lived descendant must not wedge the clipboard read:
    // the bound releases the captured output instead of waiting for a stream that never ends.
    const started = Date.now()
    const result = await runClipboardProcess(
      '/bin/sh',
      ['-c', 'printf PAYLOAD; (sleep 8) & exit 0'],
      { completion: 'stdout-end' },
    )
    expect(result.ok).toBe(false)
    expect(result.stdout.byteLength).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)
})

describe('clipboard text readers', () => {
  it('reads Wayland text without the newline wl-paste would add', () => {
    // Bare `wl-paste` appends a newline that was never on the clipboard, so every paste carried a
    // trailing line the user never copied.
    expect(clipboardTextCommands('linux')).toEqual([
      ['wl-paste', '--no-newline', '--type', 'text'],
      ['xclip', '-selection', 'clipboard', '-target', 'UTF8_STRING', '-o'],
    ])
  })

  it('keeps one reader shape per supported platform', () => {
    expect(clipboardTextCommands('darwin')).toEqual([['/usr/bin/pbpaste']])
    const windows = clipboardTextCommands('win32')[0] ?? []
    expect(windows[0]).toBe('powershell')
    expect(windows[3]).toBe('Get-Clipboard -Raw')
  })
})

describe('paste lifecycle across threads', () => {
  it('keeps a paste with the thread it started in', () => {
    // The composer is not remounted on a switch, so a read that finishes later must be dropped instead of
    // being written into the thread the user is looking at now.
    expect(pasteTargetsSameSession('/tmp/a.jsonl', '/tmp/a.jsonl')).toBe(true)
    expect(pasteTargetsSameSession('/tmp/a.jsonl', '/tmp/b.jsonl')).toBe(false)
    expect(pasteTargetsSameSession('', '/tmp/b.jsonl')).toBe(false)
  })
})
