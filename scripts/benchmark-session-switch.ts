import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getPiSessionRoot } from '../src/pi/session-catalog.ts'
import { PiSessionHistoryPager, SESSION_HISTORY_PAGE_MESSAGES } from '../src/pi/session-history.ts'
import { resolvePiExecutable } from '../src/pi/rpc-transport.ts'
import type { RpcRecord } from '../src/pi/types.ts'

const REQUEST_TIMEOUT_MS = 300_000

interface Timing {
  readonly name: string
  readonly milliseconds: number
}

/** Times each Pi RPC that the session-switch path needs, against the real harness. */
class PiRpcProbe {
  readonly #child = spawn(resolvePiExecutable(), ['--mode', 'rpc'], { stdio: ['pipe', 'pipe', 'pipe'] })
  readonly #pending = new Map<string, (record: RpcRecord) => void>()
  #buffer = ''
  #sequence = 0

  constructor() {
    this.#child.stdout.on('data', (chunk: Buffer | string) => this.#consume(chunk.toString()))
  }

  async ready(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  async time(name: string, command: Record<string, unknown>): Promise<Timing> {
    const startedAt = performance.now()
    await this.request(command)
    return { name, milliseconds: performance.now() - startedAt }
  }

  request(command: Record<string, unknown>): Promise<RpcRecord> {
    const id = `benchmark_${++this.#sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Timed out waiting for Pi command: ${String(command.type)}`))
      }, REQUEST_TIMEOUT_MS)
      this.#pending.set(id, (record) => {
        clearTimeout(timer)
        resolve(record)
      })
      this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  stop(): void {
    this.#child.kill('SIGTERM')
  }

  #consume(chunk: string): void {
    this.#buffer += chunk
    let end = this.#buffer.indexOf('\n')
    while (end >= 0) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      end = this.#buffer.indexOf('\n')
      if (!line.trim()) continue
      let record: RpcRecord
      try {
        record = JSON.parse(line) as RpcRecord
      } catch {
        continue
      }
      if (record.type !== 'response' || !record.id) continue
      const pending = this.#pending.get(record.id)
      if (!pending) continue
      this.#pending.delete(record.id)
      pending(record)
    }
  }
}

async function largestSessionFile(): Promise<string> {
  const root = getPiSessionRoot()
  const candidates: Array<{ path: string; size: number }> = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of await readdir(join(root, entry.name))) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(root, entry.name, name)
      const info = await stat(path)
      candidates.push({ path, size: info.size })
    }
  }
  candidates.sort((left, right) => right.size - left.size)
  const largest = candidates[0]
  if (!largest) throw new Error(`No Pi session transcripts found under ${root}`)
  return largest.path
}

const requested = process.argv[2]
const sessionFile = requested ? requested : await largestSessionFile()
const size = (await stat(sessionFile)).size
const pagerStartedAt = performance.now()
const page = await new PiSessionHistoryPager(sessionFile).loadEarlier(SESSION_HISTORY_PAGE_MESSAGES)
const pagerMilliseconds = performance.now() - pagerStartedAt

const probe = new PiRpcProbe()
const timings: Timing[] = []
try {
  await probe.ready()
  timings.push(await probe.time('switch_session', { type: 'switch_session', sessionPath: sessionFile }))
  timings.push(await probe.time('get_state', { type: 'get_state' }))
  timings.push(await probe.time('get_session_stats', { type: 'get_session_stats' }))
  timings.push(await probe.time('get_fork_messages', { type: 'get_fork_messages' }))
  timings.push(await probe.time('get_tree', { type: 'get_tree' }))
} finally {
  probe.stop()
}

const byName = new Map(timings.map((timing) => [timing.name, timing.milliseconds]))
const switchMilliseconds = byName.get('switch_session') ?? 0
const treeMilliseconds = byName.get('get_tree') ?? 0
const stateMilliseconds = byName.get('get_state') ?? 0

console.log(`session       ${sessionFile}`)
console.log(`size          ${(size / 1_048_576).toFixed(1)} MiB`)
console.log(`page messages ${page.messages.length}`)
console.log('')
console.log('step                      milliseconds')
console.log(`${'local transcript page'.padEnd(25)} ${pagerMilliseconds.toFixed(1).padStart(12)}`)
for (const timing of timings) console.log(`${timing.name.padEnd(25)} ${timing.milliseconds.toFixed(1).padStart(12)}`)
console.log('')
console.log(`interactive first paint   ${pagerMilliseconds.toFixed(1).padStart(12)}  (optimistic preview from the session JSONL)`)
console.log(`before: preview            ${(switchMilliseconds + Math.max(treeMilliseconds, stateMilliseconds) + pagerMilliseconds).toFixed(1).padStart(12)}  (awaited switch_session + get_tree before the transcript)`)
console.log('')
console.log(treeMilliseconds > 2_000
  ? 'NOTE get_tree is O(session size) in Pi and Pi serializes RPC commands, so it must stay off the transcript paint path.'
  : 'NOTE this session is small enough that get_tree is not the dominant cost.')
