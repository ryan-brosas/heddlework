import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
 * Request text explicitly: MIME inference can return image bytes decoded as UTF-8. On Wayland,
 * --no-newline also prevents wl-paste from appending a newline absent from the clipboard.
 */
export function clipboardTextCommands(platform: NodeJS.Platform): readonly (readonly string[])[] {
  if (platform === 'darwin') return [['/usr/bin/pbpaste']]
  if (platform === 'win32') return [['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw']]
  return [['wl-paste', '--no-newline', '--type', 'text'], ['xclip', '-selection', 'clipboard', '-target', 'UTF8_STRING', '-o']]
}

/**
 * Read plain text from the clipboard through the same bounded runner as every other clipboard helper,
 * so a helper that hangs, floods its output or exits nonzero reports "no text" instead of handing
 * partial bytes to the draft.
 */
export async function readClipboardText(): Promise<string | undefined> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) return (await navigator.clipboard.readText()) || undefined
    for (const spec of clipboardTextCommands(process.platform)) {
      const command = spec[0]
      if (!command) continue
      const result = await runClipboardProcess(command, spec.slice(1), { completion: 'stdout-end' })
      if (!result.ok) continue
      const text = result.stdout.toString('utf8')
      if (text) return text
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

/** Wall bound for a writer, whose own exit normally lands in milliseconds. */
const PROCESS_WRITE_TIMEOUT_MS = 5_000

/** Grace between the soft and hard kill of a helper that overran its bound. */
const KILL_GRACE_MS = 200

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
  options: {
    readonly input?: Uint8Array
    readonly completion?: ClipboardCompletion
    /** Wall bound from spawn: a helper that never exits must not wedge a read or a write. */
    readonly timeoutMs?: number
    /** Output bound: exceeding it fails the read instead of returning a truncated payload. */
    readonly maxBytes?: number
  } = {},
): Promise<{ ok: boolean; stdout: Buffer }> {
  const { input, completion = 'exit', maxBytes = MAX_CLIPBOARD_IMAGE_BYTES } = options
  const wallMs = options.timeoutMs ?? (completion === 'stdout-end' ? PROCESS_READ_TIMEOUT_MS : PROCESS_WRITE_TIMEOUT_MS)
  return await new Promise((resolve) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let stdoutEnded = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let wallTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: { ok: boolean; stdout: Buffer }) => {
      if (settled) return
      settled = true
      if (drainTimer) clearTimeout(drainTimer)
      if (wallTimer) clearTimeout(wallTimer)
      // A failed result may settle before the helper dies. Keep its escalation timer until exit;
      // cancelling it here would let a SIGTERM-ignoring helper survive the timeout or output bound.
      // Release the pipes too: a helper we stopped must not hold the read open through its stdio.
      if (child) {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
      resolve(value)
    }
    // A failure returns no payload at all: partial output must never look like clipboard content.
    const finishWithStatus = (code: number | null) => finish({ ok: code === 0, stdout: code === 0 ? Buffer.concat(chunks) : empty })
    let child!: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      finish({ ok: false, stdout: Buffer.alloc(0) })
      return
    }
    const chunks: Buffer[] = []
    const empty = Buffer.alloc(0)
    let totalBytes = 0
    const fail = () => finish({ ok: false, stdout: empty })
    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        // Escalate only for a helper that ignored the soft kill. A clipboard's own selection owner is
        // a separate process, so the value already written to the clipboard is not withdrawn.
        try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
    }
    // A reader's payload is complete only when stdout ends and the helper succeeded.
    const finishReader = (code: number | null, complete: boolean) => {
      const ok = code === 0 && complete
      finish({ ok, stdout: ok ? Buffer.concat(chunks) : empty })
    }
    wallTimer = setTimeout(() => {
      killChild()
      fail()
    }, wallMs)
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.from(chunk)
      totalBytes += buffer.byteLength
      // A flooding helper is stopped rather than allowed to grow the parent without bound, and its
      // partial output is reported as a failure instead of as clipboard content.
      if (totalBytes > maxBytes) {
        killChild()
        fail()
        return
      }
      chunks.push(buffer)
    })
    child.stdout.on('end', () => {
      stdoutEnded = true
      if (!exited) return
      // A reader can complete here; a writer still completes on its own exit.
      if (completion === 'stdout-end') finishReader(exitCode, true)
      else finishWithStatus(exitCode)
    })
    child.stdout.on('error', fail)
    child.stderr.on('data', () => {})
    child.stderr.on('error', () => {})
    child.stdin.on('error', () => {})
    child.on('error', fail)
    // The normal path: every pipe closed, so the captured stdout is complete.
    child.on('close', (code) => (completion === 'stdout-end' ? finishReader(code, true) : finishWithStatus(code)))
    child.on('exit', (code) => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
      exited = true
      exitCode = code
      if (completion === 'stdout-end') {
        if (stdoutEnded) finishReader(code, true)
        return
      }
      if (stdoutEnded) return finishWithStatus(code)
      // Only a writer reaches this point: its own exit is its completion signal, because a daemonized
      // selection owner keeps the inherited stdout open, so waiting for stdout end would hang. The
      // short drain window lets a helper that closes its stdout as it exits finish through `close`.
      drainTimer = setTimeout(() => finishWithStatus(code), PROCESS_DRAIN_GRACE_MS)
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}
