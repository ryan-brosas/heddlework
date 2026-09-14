import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ComposerImage, PiMessage } from '../pi/types.ts'

const IMAGE_CACHE_DIRECTORY = join(tmpdir(), 'heddlework-images-v1')
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024
const APPLE_FILE_SCRIPT = `set clipboardFile to the clipboard as alias
return POSIX path of clipboardFile
`
const APPLE_SCRIPT = `on run argv
  set targetPath to item 1 of argv
  set imageData to the clipboard as «class PNGf»
  set fileRef to open for access POSIX file targetPath with write permission
  try
    set eof fileRef to 0
    write imageData to fileRef
  on error errorMessage number errorNumber
    close access fileRef
    error errorMessage number errorNumber
  end try
  close access fileRef
  return targetPath
end run
`

export async function readClipboardImage(): Promise<ComposerImage | undefined> {
  try {
    if (process.platform === 'darwin') return await readMacClipboardImage()
    if (process.platform === 'win32') return await readWindowsClipboardImage()
    return await readLinuxClipboardImage()
  } catch {
    return undefined
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  const input = Buffer.from(text, 'utf8')
  if (process.platform === 'darwin') return (await runClipboardProcess('/usr/bin/pbcopy', [], { input })).ok
  if (process.platform === 'win32') return (await runClipboardProcess('clip.exe', [], { input })).ok
  for (const [command, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]] as const) {
    const result = await runClipboardProcess(command, [...args], { input })
    if (result.ok) return true
  }
  return false
}

/**
 * Read plain text from the clipboard, using the same helpers as the write direction so both agree on
 * which tool owns the clipboard per platform. Readers answer from stdout, so a helper that hands its
 * stdio to a surviving selection owner still terminates.
 */
export async function readClipboardText(): Promise<string | undefined> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) return (await navigator.clipboard.readText()) || undefined
    if (process.platform === 'darwin') {
      const proc = Bun.spawn(['/usr/bin/pbpaste'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    if (process.platform === 'win32') {
      const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', 'Get-Clipboard'], { stdout: 'pipe' })
      return (await new Response(proc.stdout).text()) || undefined
    }
    for (const command of [['wl-paste'], ['xclip', '-selection', 'clipboard', '-o']] as const) {
      try {
        const proc = Bun.spawn([...command], { stdout: 'pipe' })
        const text = await new Response(proc.stdout).text()
        if (text) return text
      } catch {
        // try the next clipboard command
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export { editorTextAfterImagePaste } from './clipboard-paste-text.ts'


export function createComposerImage(bytes: Uint8Array, mimeType?: string, fileName?: string): ComposerImage {
  if (bytes.byteLength === 0) throw new Error('Clipboard image is empty')
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('Clipboard image exceeds 20 MB')
  const detectedMime = mimeType ?? sniffImageMime(bytes)
  if (!detectedMime) throw new Error('Clipboard does not contain a supported image')
  const extension = imageExtension(detectedMime)
  const id = `image-${randomUUID()}`
  const previewPath = writePreview(bytes, `${id}.${extension}`)
  return {
    id,
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: detectedMime,
    previewPath,
    fileName: fileName?.trim() || `Pasted image.${extension}`,
    size: bytes.byteLength,
  }
}

export function hydrateMessageImages(messages: PiMessage[]): PiMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string' || block.previewPath) return block
      const previewPath = materializeImagePreview(block.data, block.mimeType)
      if (!previewPath) return block
      changed = true
      return { ...block, previewPath }
    })
    return changed ? { ...message, content } : message
  })
}

function materializeImagePreview(data: string, mimeType: string): string | undefined {
  try {
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return undefined
    const extension = imageExtension(mimeType)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
    return writePreview(bytes, `${hash}.${extension}`)
  } catch {
    return undefined
  }
}

async function readMacClipboardImage(): Promise<ComposerImage | undefined> {
  ensureImageDirectory()
  const path = join(IMAGE_CACHE_DIRECTORY, `clipboard-${randomUUID()}.png`)
  const result = await runClipboardProcess('/usr/bin/osascript', ['-', path], { input: Buffer.from(APPLE_SCRIPT), completion: 'stdout-end' })
  if (result.ok && existsSync(path)) {
    const bytes = readFileSync(path)
    rmSync(path, { force: true })
    if (bytes.byteLength > 0 && bytes.byteLength <= MAX_CLIPBOARD_IMAGE_BYTES) return createComposerImage(bytes, 'image/png')
  } else {
    rmSync(path, { force: true })
  }

  const fileResult = await runClipboardProcess('/usr/bin/osascript', ['-e', APPLE_FILE_SCRIPT], { completion: 'stdout-end' })
  if (!fileResult.ok) return undefined
  const filePath = fileResult.stdout.toString('utf8').trim()
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return undefined
  return createComposerImage(readFileSync(filePath), undefined, basename(filePath))
}

async function readLinuxClipboardImage(): Promise<ComposerImage | undefined> {
  const attempts: Array<[string, string[], string]> = [
    ['wl-paste', ['--no-newline', '--type', 'image/png'], 'image/png'],
    ['wl-paste', ['--no-newline', '--type', 'image/jpeg'], 'image/jpeg'],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], 'image/png'],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/jpeg', '-o'], 'image/jpeg'],
  ]
  for (const [command, args, mimeType] of attempts) {
    const result = await runClipboardProcess(command, args, { completion: 'stdout-end' })
    if (result.ok && result.stdout.byteLength > 0) return createComposerImage(result.stdout, mimeType)
  }
  return undefined
}

async function readWindowsClipboardImage(): Promise<ComposerImage | undefined> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $image) { exit 2 }',
    '$stream = New-Object IO.MemoryStream',
    '$image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($stream.ToArray())',
  ].join('; ')
  const result = await runClipboardProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { completion: 'stdout-end' })
  if (!result.ok) return undefined
  const encoded = result.stdout.toString('utf8').trim()
  return encoded ? createComposerImage(Buffer.from(encoded, 'base64'), 'image/png') : undefined
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function writePreview(bytes: Uint8Array, fileName: string): string {
  ensureImageDirectory()
  const path = join(IMAGE_CACHE_DIRECTORY, fileName)
  if (!existsSync(path) || statSync(path).size !== bytes.byteLength) writeFileSync(path, bytes)
  return path
}

function ensureImageDirectory(): void {
  mkdirSync(IMAGE_CACHE_DIRECTORY, { recursive: true })
}

/**
 * How a clipboard helper reports completion.
 *
 * `exit` is the writer rule: `wl-copy` and `xclip` daemonize a selection owner that inherits this
 * process's stdio, so `close` never fires and the helper's own exit is what proves the write
 * happened. `stdout-end` is the reader rule: a reader's payload *is* its stdout, so its payload is
 * complete only once stdout ends. Answering a reader from a fixed grace window instead could
 * truncate a large clipboard image to whatever had arrived by then.
 */
type ClipboardCompletion = 'exit' | 'stdout-end'

/**
 * Short drain window for writers, whose stdout is not the payload. Normally not paid at all: a tool
 * that closes its stdout as it exits finishes through the `close` path first.
 */
const PROCESS_DRAIN_GRACE_MS = 250

/**
 * Hard bound for a reader that exited while something else still holds its stdio (a forked holder or
 * a descendant). Without it, waiting for stdout end could leave a clipboard read pending forever.
 */
const PROCESS_READ_TIMEOUT_MS = 3_000

/**
 * Run a clipboard helper and report its exit status plus stdout. Exported so the completion rule
 * itself is regression-tested with a deterministic child instead of a real compositor.
 *
 * `close` cannot be the only completion signal: `wl-copy` and `xclip` daemonize a selection owner
 * that inherits this process's stdio, so `close` never fires even though the tool itself exited 0.
 * Awaiting it left every Linux clipboard write pending forever, which made terminal copy silently do
 * nothing. Writers therefore complete on their own exit, while readers (`completion:
 * 'stdout-end'`) complete when stdout ends, because their output is the payload being returned.
 */
export async function runClipboardProcess(
  command: string,
  args: string[],
  options: { readonly input?: Uint8Array; readonly completion?: ClipboardCompletion } = {},
): Promise<{ ok: boolean; stdout: Buffer }> {
  const { input, completion = 'exit' } = options
  return await new Promise((resolve) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let stdoutEnded = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: { ok: boolean; stdout: Buffer }) => {
      if (settled) return
      settled = true
      if (drainTimer) clearTimeout(drainTimer)
      resolve(value)
    }
    const finishWithStatus = (code: number | null) => finish({ ok: code === 0, stdout: Buffer.concat(chunks) })
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      finish({ ok: false, stdout: Buffer.alloc(0) })
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.stdout.on('end', () => {
      stdoutEnded = true
      if (exited) finishWithStatus(exitCode)
    })
    child.on('error', () => finish({ ok: false, stdout: Buffer.alloc(0) }))
    // The normal path: every pipe closed, so the captured stdout is complete.
    child.on('close', (code) => finishWithStatus(code))
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (stdoutEnded) return finishWithStatus(code)
      // A reader waits for stdout to end, because that output is the payload being returned; a
      // writer only needs the short drain window, because a daemonized selection owner keeps the
      // inherited stdout open long enough that waiting for it would hang.
      drainTimer = setTimeout(
        () => finishWithStatus(code),
        completion === 'stdout-end' ? PROCESS_READ_TIMEOUT_MS : PROCESS_DRAIN_GRACE_MS,
      )
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}
