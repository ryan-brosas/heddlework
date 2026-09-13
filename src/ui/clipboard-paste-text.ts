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
