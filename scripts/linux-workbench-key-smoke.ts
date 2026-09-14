import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { runWorkbenchKeyLane } from './linux-workbench-key-lane.ts'

/**
 * Run the workbench clipboard-key lane in demo mode on a private X display.
 *
 * Usage: bun run smoke:workbench-keys     (needs Xvfb; installs nothing and touches no user clipboard.
 * Override the binary with HEDDLEWORK_APP_BINARY and the compositor label with HEDDLEWORK_KEY_LANE_LABEL.)
 *
 * The app's clipboard helpers are stubbed in a temp `PATH`, so the run is repeatable and cannot
 * disturb the operator's clipboard. On a Wayland desktop the renderer's own clipboard still works
 * under XWayland, which is what the native round-trip check exercises.
 */

const binary = process.env.HEDDLEWORK_APP_BINARY ?? join(homedir(), '.local/share/heddlework/heddlework')
if (!existsSync(binary)) {
  console.error(`workbench key lane needs the built app at ${binary} - run ./packaging/linux/install-user.sh first`)
  process.exit(2)
}

function freeDisplay(): number {
  const alive = (display: string): boolean => {
    try { execFileSync('xdpyinfo', ['-display', display], { timeout: 3_000, stdio: 'ignore' }); return true } catch { return false }
  }
  const session = process.env.DISPLAY ?? ''
  if (session && alive(session)) throw new Error(`refusing to run: a live X server owns ${session}`)
  for (let number = 99; number >= 90; number -= 1) {
    if (existsSync(`/tmp/.X${number}-lock`) || existsSync(`/tmp/.X11-unix/X${number}`)) continue
    if (alive(`:${number}`)) continue
    return number
  }
  throw new Error('no free X display is available')
}

const work = mkdtempSync(join(tmpdir(), 'hw-workbench-key-lane-'))
const stubs = join(work, 'bin')
mkdirSync(stubs)
const copiedPath = join(work, 'copied.txt')
const pastePath = join(work, 'paste.txt')
writeFileSync(copiedPath, '')
writeFileSync(pastePath, '')
writeFileSync(join(stubs, 'wl-copy'), '#!/bin/sh\ncat >> "$HEDDLEWORK_LANE_COPIED"\n')
writeFileSync(join(stubs, 'wl-paste'), '#!/bin/sh\ncat "$HEDDLEWORK_LANE_PASTE" 2>/dev/null\n')
chmodSync(join(stubs, 'wl-copy'), 0o755)
chmodSync(join(stubs, 'wl-paste'), 0o755)

const number = freeDisplay()
const display = `:${number}`
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '+extension', 'GLX'], { stdio: ['ignore', 'ignore', 'pipe'] })
let child: ChildProcessWithoutNullStreams | undefined
let appLog = ''
let code = 0
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
xvfb.stderr.on('data', (chunk) => { appLog = (appLog + String(chunk)).slice(-4_000) })

const deadline = setTimeout(() => {
  console.error('workbench key lane timed out')
  child?.kill('SIGKILL')
  xvfb.kill('SIGTERM')
  process.exit(124)
}, 180_000)

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (existsSync(`/tmp/.X11-unix/X${number}`)) break
    await wait(100)
  }
  execFileSync('xdpyinfo', ['-display', display], { timeout: 5_000, stdio: 'ignore' })
  const runtime = join(work, 'runtime')
  mkdirSync(runtime, { mode: 0o700 })
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    DISPLAY: display,
    XDG_SESSION_TYPE: 'x11',
    XDG_RUNTIME_DIR: runtime,
    HOME: work,
    XDG_CONFIG_HOME: join(work, 'config'),
    XDG_DATA_HOME: join(work, 'data'),
    XDG_STATE_HOME: join(work, 'state'),
    XDG_CACHE_HOME: join(work, 'cache'),
    HEDDLEWORK_DEMO: '1',
    HEDDLEWORK_CWD: work,
    HEDDLEWORK_HOST: '0',
    HEDDLEWORK_LANE_COPIED: copiedPath,
    HEDDLEWORK_LANE_PASTE: pastePath,
  }
  delete env.WAYLAND_DISPLAY
  delete env.HEDDLEWORK_SESSION

  child = spawn(binary, [], { cwd: work, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const spawned = child
  spawned.stderr.on('data', (chunk) => { appLog = (appLog + String(chunk)).slice(-4_000) })
  const app = await connectStdio({
    write: (chunk) => { spawned.stdin.write(chunk) },
    feed: (listener) => { spawned.stdout.on('data', (chunk) => listener(String(chunk))) },
    close: async () => { spawned.kill('SIGTERM') },
  })
  const checks = await runWorkbenchKeyLane(app, {
    compositor: process.env.HEDDLEWORK_KEY_LANE_LABEL ?? `Xvfb ${display}`,
    stagePaste: (text) => { writeFileSync(pastePath, text) },
    copiedText: () => readFileSync(copiedPath, 'utf8'),
  })
  for (const check of checks) console.log(`pass ${check.name}: ${check.evidence}`)
  console.log(`workbench key lane complete: ${checks.length} checks passed`)
} catch (error) {
  code = 1
  console.error(`workbench key lane failed: ${error instanceof Error ? error.message : String(error)}`)
  if (appLog) console.error(appLog.slice(-2_000))
} finally {
  clearTimeout(deadline)
  child?.kill('SIGTERM')
  await wait(700)
  if (child && child.exitCode === null) child.kill('SIGKILL')
  xvfb.kill('SIGTERM')
}

process.exit(code)
