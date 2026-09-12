import { describe, expect, it } from 'bun:test'
import { shutdownListener } from '../src/process-signals.ts'

describe('process shutdown listener', () => {
  it('never forwards the runtime signal name as a shutdown error', () => {
    const received: unknown[] = []
    const listener: (...args: unknown[]) => void = shutdownListener((error?: unknown) => {
      received.push(error)
    })

    listener('SIGINT')
    listener('SIGTERM')
    listener()

    expect(received).toEqual([undefined, undefined, undefined])
  })

  it('still runs the shutdown handler once per delivered signal', () => {
    let calls = 0
    const listener = shutdownListener(() => {
      calls += 1
    })

    listener()
    listener()

    expect(calls).toBe(2)
  })
})
