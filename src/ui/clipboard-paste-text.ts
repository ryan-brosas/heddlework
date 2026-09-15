/**
 * What a submit should do while a paste may be pending.
 *
 * The renderer keeps several ways to submit the composer, and they can arrive while the same paste is still
 * being read: Enter pressed twice, or Enter followed by the Send button. The first submit claims the paste;
 * a second one that arrives while that submit is still waiting must be dropped, or the same draft is sent
 * twice (`send` is idempotent only for an empty draft).
 */
export type PasteSubmitPlan =
  | { readonly action: 'send'; readonly text: string }
  | { readonly action: 'wait' }
  | { readonly action: 'ignore' }

export function planPasteSubmit(input: {
  readonly pending: Promise<unknown> | null
  readonly claimed: boolean
  readonly eventValue: string
}): PasteSubmitPlan {
  if (input.pending === null) return { action: 'send', text: input.eventValue }
  if (input.claimed) return { action: 'ignore' }
  return { action: 'wait' }
}

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

/**
 * Whether a paste or submit still belongs to the thread it started in.
 *
 * The clipboard read is asynchronous and the composer is not remounted when the user clicks a thread, so a
 * read, an attached image, or a waiting submit can outlive the session it began in. Comparing the session
 * file - not the session object identity - is what keeps a late result from being written into the thread
 * the user is looking at now, where it would look like the paste went to the wrong place.
 */
export function pasteTargetsSameSession(startedSessionFile: string, currentSessionFile: string): boolean {
  return startedSessionFile === currentSessionFile
}

/**
 * The draft as it was before the native paste action inserted `inserted`.
 *
 * A runtime that owns the clipboard keys inserts at the caret and then reports the inserted text, so the
 * draft it produced is the only record of that insertion. Inverting exactly that text - rather than
 * guessing from a path-shaped string - is what lets the image half compare against the pre-paste draft and
 * drop a pasted image path once the image itself is attached.
 */
export function draftBeforeNativePaste(current: string, inserted: string): string {
  if (inserted === '' || !current.endsWith(inserted)) return current
  return current.slice(0, current.length - inserted.length)
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
