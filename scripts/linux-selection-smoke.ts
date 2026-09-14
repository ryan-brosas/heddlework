import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { connectStdio, type App } from '@gpuix/react/automation'
import { runSelectionLane } from './linux-selection-lane.ts'

const root = resolve(import.meta.dir, '..')
const session = process.env.XDG_SESSION_TYPE ?? 'unknown session'
const display = process.env.WAYLAND_DISPLAY ?? process.env.DISPLAY ?? 'no display'
const compositor = process.env.HEDDLEWORK_SELECTION_COMPOSITOR ?? `${session} on ${display}`
let code = 0
let nativeStderr = ''
let child: ChildProcessWithoutNullStreams | undefined

const timeout = setTimeout(() => {
  console.error('selection lane timed out')
  child?.kill('SIGTERM')
  process.exit(124)
}, 90_000)

try {
  child = spawn(process.execPath, [resolve(import.meta.dir, 'smoke-linux-selection.tsx')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const spawned = child
  spawned.stderr.on('data', (chunk: Buffer) => {
    nativeStderr = (nativeStderr + chunk.toString('utf8')).slice(-8_000)
  })
  const app: App = await connectStdio({
    write: (chunk) => spawned.stdin.write(chunk),
    feed: (listener) => spawned.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
    close: async () => { spawned.kill('SIGTERM') },
  })
  const checks = await runSelectionLane(app, { compositor })
  for (const check of checks) console.log(`pass ${check.name}: ${check.evidence}`)
  console.log(`selection lane complete: ${checks.length} checks passed on ${compositor}`)
} catch (error) {
  code = 1
  console.error(`selection lane failed: ${error instanceof Error ? error.message : String(error)}`)
  if (nativeStderr) console.error(nativeStderr.slice(-2_000))
} finally {
  clearTimeout(timeout)
  child?.kill('SIGTERM')
}

process.exit(code)
