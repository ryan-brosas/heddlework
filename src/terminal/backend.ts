import type { TerminalCleanup, TerminalProcessStatus, TerminalSpawnRequest } from './types.ts'

export interface TerminalOutputMetadata {
  readonly synchronizedFrame: boolean
}

export interface TerminalProcess {
  readonly pid?: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (chunk: Uint8Array, metadata?: TerminalOutputMetadata) => void): TerminalCleanup
  onExit(listener: (status: TerminalProcessStatus) => void): TerminalCleanup
}

export interface TerminalBackend {
  spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess>
}

const SYNCHRONIZED_DATA_STALE_MS = 1_000
const INITIAL_OUTPUT_BUFFER_BYTES = 64 * 1024
const SYNCHRONIZED_OUTPUT_PREFIX = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36])
const ORDINARY_OUTPUT_METADATA = { synchronizedFrame: false } as const
const SYNCHRONIZED_FRAME_METADATA = { synchronizedFrame: true } as const

export class TerminalOutputBuffer {
  readonly #emit: (chunk: Uint8Array, metadata: TerminalOutputMetadata) => void
  #buffer = new Uint8Array(INITIAL_OUTPUT_BUFFER_BYTES)
  #spare = new Uint8Array(INITIAL_OUTPUT_BUFFER_BYTES)
  #length = 0
  #sequence = 0
  #synchronized = false
  #microtaskPending = false
  #staleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(emit: (chunk: Uint8Array, metadata: TerminalOutputMetadata) => void) {
    this.#emit = emit
  }

  write(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    let index = 0
    let segmentStart = 0
    while (index < chunk.byteLength && this.#sequence > 0) {
      segmentStart = this.#scanByte(chunk, index, segmentStart)
      index += 1
    }
    while (index < chunk.byteLength) {
      const enable = this.#synchronized ? -1 : chunk.indexOf(0x68, index)
      const disable = chunk.indexOf(0x6c, index)
      const final = enable === -1
        ? disable
        : disable === -1
          ? enable
          : Math.min(enable, disable)
      if (final === -1) break
      const marker = final - SYNCHRONIZED_OUTPUT_PREFIX.length
      let matches = marker >= index
      for (let offset = 0; matches && offset < SYNCHRONIZED_OUTPUT_PREFIX.length; offset += 1) {
        matches = chunk[marker + offset] === SYNCHRONIZED_OUTPUT_PREFIX[offset]
      }
      index = final + 1
      if (!matches) continue
      if (chunk[final] === 0x68) this.#synchronized = true
      else {
        this.#completeFrame(chunk, segmentStart, index)
        segmentStart = index
      }
    }
    if (this.#sequence === 0) {
      const tailStart = Math.max(index, chunk.byteLength - SYNCHRONIZED_OUTPUT_PREFIX.length)
      const escape = chunk.indexOf(SYNCHRONIZED_OUTPUT_PREFIX[0]!, tailStart)
      if (escape !== -1) {
        index = escape
        while (index < chunk.byteLength) {
          segmentStart = this.#scanByte(chunk, index, segmentStart)
          index += 1
        }
      }
    }
    this.#append(chunk.subarray(segmentStart))
    if (this.#synchronized) {
      this.#hold()
      return
    }
    this.#schedule()
  }

  flush(synchronizedFrame = false): void {
    if (this.#length === 0) return
    const delivering = this.#buffer
    const length = this.#length
    this.#buffer = this.#spare.byteLength >= INITIAL_OUTPUT_BUFFER_BYTES
      ? this.#spare
      : new Uint8Array(INITIAL_OUTPUT_BUFFER_BYTES)
    this.#spare = new Uint8Array(0)
    this.#length = 0
    this.#emit(
      delivering.subarray(0, length),
      synchronizedFrame ? SYNCHRONIZED_FRAME_METADATA : ORDINARY_OUTPUT_METADATA,
    )
    if (this.#spare.byteLength === 0) this.#spare = delivering
  }

  close(): void {
    if (this.#staleTimer) clearTimeout(this.#staleTimer)
    this.#staleTimer = undefined
    this.#synchronized = false
    this.flush()
  }

  #scanByte(chunk: Uint8Array, index: number, segmentStart: number): number {
    const mode = this.#scan(chunk[index]!)
    if (mode === 1) this.#synchronized = true
    if (mode === -1) {
      const frameEnd = index + 1
      this.#completeFrame(chunk, segmentStart, frameEnd)
      return frameEnd
    }
    return segmentStart
  }

  #completeFrame(chunk: Uint8Array, start: number, end: number): void {
    this.#synchronized = false
    this.#append(chunk.subarray(start, end))
    if (this.#staleTimer) clearTimeout(this.#staleTimer)
    this.#staleTimer = undefined
    this.flush(true)
  }

  #append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.#reserve(chunk.byteLength)
    this.#buffer.set(chunk, this.#length)
    this.#length += chunk.byteLength
  }

  #reserve(additional: number): void {
    const required = this.#length + additional
    if (required <= this.#buffer.byteLength) return
    if (this.#spare.byteLength >= required) {
      const grown = this.#spare
      grown.set(this.#buffer.subarray(0, this.#length))
      this.#spare = this.#buffer
      this.#buffer = grown
      return
    }
    let capacity = this.#buffer.byteLength
    while (capacity < required) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.#buffer.subarray(0, this.#length))
    this.#buffer = grown
  }

  #scan(byte: number): -1 | 0 | 1 {
    if (this.#sequence < SYNCHRONIZED_OUTPUT_PREFIX.length) {
      if (byte === SYNCHRONIZED_OUTPUT_PREFIX[this.#sequence]) {
        this.#sequence += 1
      } else {
        this.#sequence = byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0
      }
      return 0
    }
    this.#sequence = byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0
    if (byte === 0x68) return 1
    if (byte === 0x6c) return -1
    return 0
  }

  #schedule(): void {
    if (this.#microtaskPending) return
    this.#microtaskPending = true
    queueMicrotask(() => {
      this.#microtaskPending = false
      if (!this.#synchronized) this.flush()
    })
  }

  #hold(): void {
    if (this.#staleTimer) return
    this.#staleTimer = setTimeout(() => {
      this.#staleTimer = undefined
      this.flush()
    }, SYNCHRONIZED_DATA_STALE_MS)
  }
}

interface BunTerminalHandle {
  write(data: string | Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
  readonly closed: boolean
}

interface BunTerminalCtor {
  new (options: {
    cols?: number
    rows?: number
    data?: (terminal: BunTerminalHandle, chunk: Uint8Array) => void
  }): BunTerminalHandle
}

function bunTerminalCtor(): BunTerminalCtor | undefined {
  const ctor = (Bun as unknown as { Terminal?: BunTerminalCtor }).Terminal
  return typeof ctor === 'function' ? ctor : undefined
}

export function bunTerminalAvailable(): boolean {
  return bunTerminalCtor() !== undefined
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: process.env.COMSPEC || 'cmd.exe', args: [] }
  const shell = process.env.SHELL || '/bin/bash'
  return { command: shell, args: ['-l'] }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

export class BunPtyBackend implements TerminalBackend {
  async spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const Terminal = bunTerminalCtor()
    if (!Terminal) throw new Error('Bun.Terminal is not available in this runtime')
    const dataListeners = new Set<(chunk: Uint8Array, metadata?: TerminalOutputMetadata) => void>()
    const exitListeners = new Set<(status: TerminalProcessStatus) => void>()
    const output = new TerminalOutputBuffer((chunk, metadata) => {
      for (const listener of dataListeners) listener(chunk, metadata)
    })
    let status: TerminalProcessStatus = { kind: 'running' }
    const terminal = new Terminal({
      cols: request.cols,
      rows: request.rows,
      data(_handle, chunk) {
        output.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      },
    })
    const command = request.shell ?? defaultShell().command
    const args = request.args ? [...request.args] : request.shell ? [] : defaultShell().args
    const env = {
      ...process.env,
      ...request.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }
    const subprocess = Bun.spawn([command, ...args], {
      cwd: request.cwd,
      env,
      terminal,
      ...(process.platform === 'win32' ? {} : { detached: true }),
    } as Parameters<typeof Bun.spawn>[1])
    void subprocess.exited.then((exitCode) => {
      if (status.kind === 'exited') return
      status = { kind: 'exited', exitCode: typeof exitCode === 'number' ? exitCode : null }
      output.close()
      for (const listener of exitListeners) listener(status)
      if (!terminal.closed) terminal.close()
    }).catch(() => {
      if (status.kind === 'exited') return
      status = { kind: 'exited', exitCode: null }
      output.close()
      for (const listener of exitListeners) listener(status)
    })
    return {
      pid: subprocess.pid,
      write(data) {
        if (status.kind === 'exited' || terminal.closed) return
        terminal.write(typeof data === 'string' ? data : data)
      },
      resize(cols, rows) {
        if (status.kind === 'exited' || terminal.closed) return
        terminal.resize(Math.max(2, cols), Math.max(1, rows))
        signalProcessGroup(subprocess.pid, 'SIGWINCH')
      },
      kill() {
        output.close()
        if (status.kind !== 'exited' && !signalProcessGroup(subprocess.pid, 'SIGTERM')) {
          try { subprocess.kill() } catch { /* already gone */ }
        }
        if (!terminal.closed) terminal.close()
      },
      onData(listener) {
        dataListeners.add(listener)
        return () => { dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        if (status.kind === 'exited') listener(status)
        return () => { exitListeners.delete(listener) }
      },
    }
  }
}

export class MemoryTerminalBackend implements TerminalBackend {
  readonly #script: string | Uint8Array | undefined

  constructor(script?: string | Uint8Array) {
    this.#script = script
  }

  async spawn(_request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const dataListeners = new Set<(chunk: Uint8Array) => void>()
    const exitListeners = new Set<(status: TerminalProcessStatus) => void>()
    let status: TerminalProcessStatus = { kind: 'running' }
    const emit = (chunk: Uint8Array) => {
      for (const listener of dataListeners) listener(chunk)
    }
    const script = this.#script
    let scriptEmitted = false
    const emitScript = () => {
      if (scriptEmitted || !script) return
      scriptEmitted = true
      emit(typeof script === 'string' ? new TextEncoder().encode(script) : script)
    }
    return {
      write(data) {
        if (status.kind === 'exited') return
        emit(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      },
      resize() {},
      kill() {
        if (status.kind === 'exited') return
        status = { kind: 'exited', exitCode: 0 }
        for (const listener of exitListeners) listener(status)
      },
      onData(listener) {
        dataListeners.add(listener)
        queueMicrotask(emitScript)
        return () => { dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        return () => { exitListeners.delete(listener) }
      },
    }
  }
}
