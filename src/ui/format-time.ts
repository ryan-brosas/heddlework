/**
 * Shared Intl formatters.
 *
 * Constructing an Intl.DateTimeFormat or Intl.NumberFormat per call re-resolves
 * the locale database every time a transcript row, sidebar row, or notice renders;
 * one module-level instance per format makes the repeat cost a plain format()
 * call, and the minute-granularity stamp cache keeps repeat renders of the same
 * row allocation-free.
 */
const timeOfDayFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const tokenCountFormatter = new Intl.NumberFormat()
const timeOfDayCache = new Map<number, string>()

/** `10:44 AM` for a transcript timestamp, sidebar snooze hint, or notice stamp. */
export function formatTimeOfDay(timestamp: number): string {
  let text = timeOfDayCache.get(timestamp)
  if (text === undefined) {
    text = timeOfDayFormatter.format(timestamp)
    if (timeOfDayCache.size >= 512) timeOfDayCache.clear()
    timeOfDayCache.set(timestamp, text)
  }
  return text
}

/** `1,234` for compaction token counts. */
export function formatTokenCount(value: number): string {
  return tokenCountFormatter.format(value)
}
