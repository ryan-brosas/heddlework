import { describe, expect, it } from 'bun:test'
import { SingleFlight } from '../src/browser/single-flight.ts'

describe('single flight', () => {
  it('starts the operation once for every caller that arrives while it runs', async () => {
    const flight = new SingleFlight<string>()
    let starts = 0
    let release: (value: string) => void = () => {}
    const start = () => {
      starts += 1
      return new Promise<string>((resolve) => { release = resolve })
    }

    const first = flight.run(start)
    const second = flight.run(start)
    const third = flight.run(start)
    expect(starts).toBe(1)
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(flight.pending).toBe(true)

    release('chrome')
    expect(await Promise.all([first, second, third])).toEqual(['chrome', 'chrome', 'chrome'])
    expect(starts).toBe(1)
  })

  it('lets the next caller retry after a failed attempt', async () => {
    const flight = new SingleFlight<string>()
    let attempts = 0
    const failing = () => {
      attempts += 1
      return Promise.reject(new Error('Chrome could not start'))
    }

    await expect(flight.run(failing)).rejects.toThrow('Chrome could not start')
    expect(flight.pending).toBe(false)
    // The same rejection is handed to a caller that joined the failed attempt.
    const joined = flight.run(() => Promise.resolve('recovered'))
    expect(await joined).toBe('recovered')
    expect(attempts).toBe(1)
  })

  it('starts again once the attempt is cleared', async () => {
    const flight = new SingleFlight<number>()
    let starts = 0
    const start = () => {
      starts += 1
      return Promise.resolve(starts)
    }

    expect(await flight.run(start)).toBe(1)
    // A finished attempt is still shared until its owner says it is gone.
    expect(await flight.run(start)).toBe(1)
    flight.clear()
    expect(flight.pending).toBe(false)
    expect(await flight.run(start)).toBe(2)
  })
})
