import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string }

/** Chrome's private fd3/fd4 transport: no listening port and no ambient browser discovery. */
export class CdpConnection {
  #nextId = 0
  #pending = new Map<number, Pending>()
  #events = new Set<(event: CdpEvent) => void>()
  #closedListeners = new Set<() => void>()
  #buffer = ''
  #decoder = new StringDecoder('utf8')
  #closed = false

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly timeoutMs = 10_000) {
    input.on('data', this.#onData)
    input.on('end', this.close)
    input.on('error', this.close)
    output.on('error', this.close)
  }

  get closed(): boolean { return this.#closed }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Chrome connection closed. Restart the browser.'))
    const id = ++this.#nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Chrome command timed out: ${method}`))
      }, this.timeoutMs)
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.output.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', (error) => {
        if (error) this.close()
      })
    })
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#events.add(listener)
    return () => { this.#events.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    this.#closedListeners.add(listener)
    return () => { this.#closedListeners.delete(listener) }
  }

  readonly close = (): void => {
    if (this.#closed) return
    this.#closed = true
    this.input.off('data', this.#onData)
    this.input.off('end', this.close)
    this.input.off('error', this.close)
    // Keep the output error handler until its owner destroys the pipe.
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chrome connection closed. Restart the browser.'))
    }
    this.#pending.clear()
    this.#buffer = ''
    this.#events.clear()
    for (const listener of this.#closedListeners) listener()
    this.#closedListeners.clear()
  }

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer += this.#decoder.write(chunk)
    if (this.#buffer.length > 32 * 1024 * 1024) { this.close(); return }
    let end: number
    while ((end = this.#buffer.indexOf('\0')) >= 0) {
      const raw = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      let message: Record<string, unknown>
      try { message = JSON.parse(raw) as Record<string, unknown> } catch { this.close(); return }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id)
        if (!pending) continue
        this.#pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error('Chrome rejected a browser command.'))
        else pending.resolve(message.result)
      } else if (typeof message.method === 'string') {
        const event: CdpEvent = { method: message.method, params: (message.params ?? {}) as Record<string, unknown>, ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}) }
        for (const listener of this.#events) listener(event)
      }
    }
  }
}
