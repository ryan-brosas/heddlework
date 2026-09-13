import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ComposerImage, PiContentBlock, PiMessage } from '../pi/types.ts'

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
  if (process.platform === 'darwin') return (await runProcess('/usr/bin/pbcopy', [], input)).ok
  if (process.platform === 'win32') return (await runProcess('clip.exe', [], input)).ok
  for (const [command, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]] as const) {
    const result = await runProcess(command, [...args], input)
    if (result.ok) return true
  }
  return false
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

export function imageBlocks(message: PiMessage): Array<PiContentBlock & { type: 'image'; data: string; mimeType: string }> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((block): block is PiContentBlock & { type: 'image'; data: string; mimeType: string } => (
    block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
  ))
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
  const result = await runProcess('/usr/bin/osascript', ['-', path], Buffer.from(APPLE_SCRIPT))
  if (result.ok && existsSync(path)) {
    const bytes = readFileSync(path)
    rmSync(path, { force: true })
    if (bytes.byteLength > 0 && bytes.byteLength <= MAX_CLIPBOARD_IMAGE_BYTES) return createComposerImage(bytes, 'image/png')
  } else {
    rmSync(path, { force: true })
  }

  const fileResult = await runProcess('/usr/bin/osascript', ['-e', APPLE_FILE_SCRIPT])
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
    const result = await runProcess(command, args)
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
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
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

async function runProcess(command: string, args: string[], input?: Uint8Array): Promise<{ ok: boolean; stdout: Buffer }> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: { ok: boolean; stdout: Buffer }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      finish({ ok: false, stdout: Buffer.alloc(0) })
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish({ ok: false, stdout: Buffer.alloc(0) }))
    child.on('close', (code) => finish({ ok: code === 0, stdout: Buffer.concat(chunks) }))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}
