export function markdownSourceWithNewlines(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/(```[\s\S]*?```)|([^\n])\n(?!\n)/g, (_chunk, fence: string | undefined, character: string | undefined) => (
    fence ?? `${character}  \n`
  ))
}
