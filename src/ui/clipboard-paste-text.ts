/**
 * Text a submit should send while a paste is still in flight.
 *
 * A clipboard read is asynchronous and the `Shift+Insert` path starts it without blocking the composer, so
 * an Enter that arrives first would submit the *pre-paste* draft: the paste never reaches the harness and
 * its text then appears in the composer afterwards, which reads as "paste did nothing". The submit waits
 * for the pending paste and sends what the draft really holds; the renderer's own value for the key event
 * is used when nothing is pending.
 */
export async function resolveSubmittedText(options: {
  readonly pending: Promise<unknown> | null
  readonly eventValue: string
  readonly currentDraft: () => string
}): Promise<string> {
  if (options.pending === null) return options.eventValue
  await options.pending.catch(() => undefined)
  return options.currentDraft() || options.eventValue
}

/** Pure paste-path classifier shared by src/ui/clipboard-media.ts and its web alias src/dom/shims/clipboard-media.ts. */
export function editorTextAfterImagePaste(previous: string, current: string): string {
  if (previous === current) return current
  let prefix = 0
  while (prefix < previous.length && previous[prefix] === current[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < previous.length - prefix
    && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
  ) suffix += 1
  const inserted = current.slice(prefix, current.length - suffix).trim().replace(/^['"]|['"]$/g, '')
  const normalized = inserted.toLowerCase()
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some((extension) => normalized.endsWith(extension))
  const isPath = normalized.startsWith('file://') || normalized.includes('/') || normalized.includes('\\')
  return isImage && isPath ? previous : current
}
