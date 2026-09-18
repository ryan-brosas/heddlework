import { describe, expect, it } from 'bun:test'
import { liveFieldsOnlyChanged, TrailingNotifier } from '../src/workbench/notify-batch.ts'

describe('live notification batching', () => {
  it('distinguishes high-frequency live fields from terminal state', () => {
    const base = { messages: [], liveAssistant: { id: 'live' }, liveTools: [], activity: 'Working', session: { isStreaming: true } }
    expect(liveFieldsOnlyChanged(base, { ...base, liveAssistant: { id: 'live', text: 'Hi' } })).toBe(true)
    expect(liveFieldsOnlyChanged(base, { ...base, activity: 'Thinking' })).toBe(true)
    expect(liveFieldsOnlyChanged(base, { ...base, session: { isStreaming: false } })).toBe(false)
    expect(liveFieldsOnlyChanged(base, { ...base, messages: [{ role: 'assistant' }] })).toBe(false)
    expect(liveFieldsOnlyChanged(base, base)).toBe(false)
  })

  it('coalesces a burst to one trailing notification and flushes terminal state immediately', async () => {
    let count = 0
    const notifier = new TrailingNotifier(() => { count += 1 }, 20)
    for (let index = 0; index < 100; index += 1) notifier.notify(false)
    expect(count).toBe(0)
    await Bun.sleep(35)
    expect(count).toBe(1)

    notifier.notify(false)
    notifier.notify(true)
    expect(count).toBe(2)
    await Bun.sleep(35)
    expect(count).toBe(2)

    notifier.notify(false)
    notifier.cancel()
    await Bun.sleep(35)
    expect(count).toBe(2)
  })

  it('coalesces a delta-cadence burst at the default interval', async () => {
    let count = 0
    const notifier = new TrailingNotifier(() => { count += 1 })
    // Deltas arrive about every 16ms; a timer at that cadence fires for nearly every one and
    // each live notify rebuilds the transcript projection.
    for (let index = 0; index < 6; index += 1) {
      notifier.notify(false)
      await Bun.sleep(16)
    }
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThanOrEqual(3)
    notifier.cancel()
  })
})
