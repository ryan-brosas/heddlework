/**
 * Run the workbench clipboard-key lane against the built app.
 *
 * Usage:
 *   bun run smoke:workbench-keys                 # checkout build (dist/heddlework) on a private Xvfb display
 *   bun run smoke:workbench-keys --installed     # $XDG_DATA_HOME/heddlework/heddlework
 *   HEDDLEWORK_APP_BINARY=/path/to/app bun run smoke:workbench-keys
 *   HEDDLEWORK_SMOKE_ISOLATED_DISPLAY=1 bun scripts/linux-workbench-key-smoke.ts --display=current
 *
 * The default mode owns a private Xvfb display and stub `wl-copy`/`wl-paste`/`xclip` helpers first in
 * `PATH`, so the operator's clipboard and their real clipboard tools are never touched. The ambient
 * `DISPLAY` is reported and ignored rather than treated as an error. `--display=current` is the one
 * mode that can reach a live session's clipboard, so it requires the explicit
 * `HEDDLEWORK_SMOKE_ISOLATED_DISPLAY=1` opt-in for a disposable compositor session.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the run could not start, 124 timed out.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { connectStdio, type App } from '@gpuix/react/automation'
import { runWorkbenchKeyLane } from './linux-workbench-key-lane.ts'
import {
  allocateDisplayNumber,
  clipboardLaneHelper,
  parseDisplayfdNumber,
  parseWorkbenchKeySmokeArgs,
  readArtifactIdentity,
  XVFB_DISPLAY_LAST,
  resolveAppBinaryPath,
  workbenchKeyLaneEnvironment,
  writeClipboardStubs,
  xvfbArguments,
  xvfbSupportsDisplayfd,
  type ArtifactIdentity,
  type WorkbenchKeySmokeInvocation,
} from './linux-workbench-key-harness.ts'

const repoRoot = resolve(import.meta.dir, '..')
const OVERALL_TIMEOUT_MS = 240_000
const HANDSHAKE_TIMEOUT_MS = 60_000
const DISPLAY_READY_TIMEOUT_MS = 15_000
const APP_EXIT_GRACE_MS = 700
const POLL_MS = 25
const XVFB_PROBE_ATTEMPTS = 6

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let deadline: ReturnType<typeof setTimeout> | undefined
let appProcess: ChildProcessWithoutNullStreams | undefined
let xvfbProcess: ChildProcess | undefined
let workspace: string | undefined
let appStderr = ''
let tearingDown = false

/** Kill everything the run owns, remove its temp directory, then report the code it exited with. */
async function teardown(code: number, message?: string): Promise<never> {
  if (tearingDown) process.exit(code)
  tearingDown = true
  if (deadline !== undefined) clearTimeout(deadline)
  if (message !== undefined) console.error(message)
  try {
    appProcess?.kill('SIGTERM')
  } catch {
    // The child is already gone.
  }
  try {
    xvfbProcess?.kill('SIGTERM')
  } catch {
    // The display is already gone.
  }
  await sleep(APP_EXIT_GRACE_MS)
  try {
    appProcess?.kill('SIGKILL')
  } catch {
    // The child is already gone.
  }
  try {
    xvfbProcess?.kill('SIGKILL')
  } catch {
    // The display is already gone.
  }
  if (workspace !== undefined) {
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // Keeping a temp directory is better than aborting the report.
    }
  }
  process.exit(code)
}

function onPath(command: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory !== '' && existsSync(join(directory, command))) return true
  }
  return false
}

function probeDisplay(display: string): boolean {
  try {
    execFileSync('xdpyinfo', ['-display', display], { timeout: 3_000, stdio: 'ignore' })
    return true
  } catch {
    // A missing xdpyinfo or an unresponsive server: the socket check below still decides.
    return false
  }
}

/** Xvfb prints its usage on stderr and exits 0, so both streams are read and merged. */
function readXvfbHelp(): string | undefined {
  const result = spawnSync('Xvfb', ['-help'], { encoding: 'utf8', timeout: 5_000 })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return text === '' ? undefined : text
}

interface XvfbHandle {
  readonly display: string
  readonly process: ChildProcess
}

interface XvfbRun {
  readonly child: ChildProcess
  readonly readStderr: () => string
  readonly failure: () => Error | undefined
}

function startXvfb(args: readonly string[]): XvfbRun {
  const child = spawn('Xvfb', [...args], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let stderr = ''
  let spawnError: Error | undefined
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000) })
  child.on('error', (error: Error) => { spawnError = error })
  return {
    child,
    readStderr: () => stderr,
    failure: () => {
      if (spawnError !== undefined) return spawnError
      if (child.signalCode !== null) return new Error(`Xvfb was killed (${child.signalCode})`)
      if (child.exitCode !== null) return new Error(`Xvfb exited with code ${child.exitCode}${stderr === '' ? '' : `: ${stderr}`}`)
      return undefined
    },
  }
}

async function waitForDisplaySocket(run: XvfbRun, number: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const failure = run.failure()
    if (failure !== undefined) throw failure
    // Only a real connection counts: a crashed Xwayland leaves `/tmp/.X0-lock` and its socket behind,
    // so the socket file can exist for a display nothing can reach. Trusting it launched the workbench
    // against a dead display and reported an empty window rather than a display failure.
    if (probeDisplay(`:${number}`)) return
    if (Date.now() - started >= DISPLAY_READY_TIMEOUT_MS) {
      throw new Error(`display :${number} was not ready within ${DISPLAY_READY_TIMEOUT_MS}ms${run.readStderr() === '' ? '' : `: ${run.readStderr()}`}`)
    }
    await sleep(POLL_MS)
  }
}

async function startPrivateDisplay(): Promise<XvfbHandle> {
  const help = readXvfbHelp()
  if (help !== undefined && xvfbSupportsDisplayfd(help)) {
    const run = startXvfb(xvfbArguments({ displayfd: 3 }))
    const pipe = run.child.stdio[3] as Readable | null
    if (pipe !== null) {
      let buffer = ''
      pipe.setEncoding('utf8')
      pipe.on('data', (chunk: string) => { buffer += chunk })
      const started = Date.now()
      while (Date.now() - started < DISPLAY_READY_TIMEOUT_MS) {
        const number = parseDisplayfdNumber(buffer)
        if (number !== undefined) {
          // `-displayfd` reports the *first free* number, which on a desktop whose Xwayland died is
          // display 0: the leftover lock and socket make it look available, while it is the session's
          // and nothing can paint there. Only the reserved range belongs to this run.
          if (number < XVFB_DISPLAY_LAST) break
          try {
            await waitForDisplaySocket(run, number)
            return { display: `:${number}`, process: run.child }
          } catch {
            // `-displayfd` reports the first free number, which can be a display whose server is gone
            // while its lock file survives. Fall through to the reserved range instead of running the
            // workbench against it.
            break
          }
        }
        const failure = run.failure()
        if (failure !== undefined) break
        await sleep(POLL_MS)
      }
      try {
        run.child.kill('SIGKILL')
      } catch {
        // The child never started.
      }
    } else {
      run.child.kill('SIGTERM')
    }
  }

  // Fallback for Xvfb builds without -displayfd: claim a number and verify the server owns it.
  let lastError: Error | undefined
  for (let attempt = 0; attempt < XVFB_PROBE_ATTEMPTS; attempt += 1) {
    const number = allocateDisplayNumber({ isBusy: (value) => existsSync(`/tmp/.X${value}-lock`) || existsSync(`/tmp/.X11-unix/X${value}`) })
    const run = startXvfb(xvfbArguments({ display: `:${number}` }))
    try {
      await waitForDisplaySocket(run, number)
      return { display: `:${number}`, process: run.child }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      try {
        run.child.kill('SIGKILL')
      } catch {
        // The child never started.
      }
    }
  }
  throw lastError ?? new Error('could not start a private Xvfb display')
}

async function main(): Promise<void> {
  deadline = setTimeout(() => { void teardown(124, `workbench key lane timed out after ${OVERALL_TIMEOUT_MS}ms`) }, OVERALL_TIMEOUT_MS)

  let invocation: WorkbenchKeySmokeInvocation
  try {
    invocation = parseWorkbenchKeySmokeArgs(process.argv.slice(2))
  } catch (error) {
    return await teardown(2, error instanceof Error ? error.message : String(error))
  }

  const binary = resolveAppBinaryPath(invocation, process.env, repoRoot)
  if (!existsSync(binary.path)) {
    const hint = binary.source === 'checkout' ? 'run bun run build first' : binary.source === 'installed' ? 'run ./packaging/linux/install-user.sh first' : 'check HEDDLEWORK_APP_BINARY'
    return await teardown(2, `the ${binary.source} app binary is missing at ${binary.path}; ${hint}`)
  }

  let identity: ArtifactIdentity
  try {
    identity = readArtifactIdentity(binary.path)
  } catch (error) {
    return await teardown(2, `cannot identify the app artifact at ${binary.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (identity.backend !== 'native-gpui') {
    const launched = identity.launchedFrom === undefined ? '' : ` (launcher ${identity.launchedFrom})`
    return await teardown(2, `the workbench key lane drives the native stdio automation surface, but ${binary.path}${launched} is ${identity.backend}`)
  }
  console.log(`artifact ${identity.path} sha256=${identity.sha256} backend=${identity.backend} source=${binary.source}${identity.launchedFrom === undefined ? '' : ` launcher=${identity.launchedFrom}`}`)

  const ambientDisplay = process.env.DISPLAY ?? ''
  let display = ''
  if (invocation.display === 'current') {
    display = ambientDisplay
    if (ambientDisplay === '' && (process.env.WAYLAND_DISPLAY ?? '') === '') {
      return await teardown(2, '--display=current needs a live DISPLAY or WAYLAND_DISPLAY in this session')
    }
  } else {
    if (!onPath('Xvfb')) {
      return await teardown(2, 'Xvfb is not on PATH; install it (for example pacman -S xorg-server-xvfb), or pass --display=current for an isolated compositor session')
    }
    try {
      const started = await startPrivateDisplay()
      display = started.display
      xvfbProcess = started.process
    } catch (error) {
      return await teardown(2, `could not start a private X display: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (ambientDisplay !== '') {
    console.log(`ambient display ${ambientDisplay} is ignored; this run owns ${display === '' ? process.env.WAYLAND_DISPLAY ?? '' : display}`)
  }

  workspace = mkdtempSync(join(tmpdir(), 'hw-workbench-key-'))
  const stubDirectory = join(workspace, 'bin')
  const stubs = writeClipboardStubs(stubDirectory)
  for (const directory of ['runtime', 'config', 'state', 'cache', 'data']) {
    mkdirSync(join(workspace, directory), { recursive: true, mode: 0o700 })
  }
  const environment = workbenchKeyLaneEnvironment({
    base: process.env,
    workspace,
    stubDirectory,
    display,
    displayMode: invocation.display,
    paths: stubs.paths,
  })

  const compositor = process.env.HEDDLEWORK_KEY_LANE_LABEL
    ?? (invocation.display === 'current'
      ? `${process.env.XDG_SESSION_TYPE ?? 'session'} on ${process.env.WAYLAND_DISPLAY ?? display}`
      : `Xvfb ${display}`)

  const child = spawn(binary.path, [], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  appProcess = child
  child.stderr.on('data', (chunk: Buffer) => { appStderr = (appStderr + chunk.toString('utf8')).slice(-8_000) })
  let spawnError: Error | undefined
  child.on('error', (error: Error) => { spawnError = error })
  child.on('exit', (code, signal) => {
    if (tearingDown || code === 0 || code === null) return
    appStderr = `${appStderr}\n[app exited with code ${code}${signal === null ? '' : ` signal ${signal}`}]`.slice(-8_000)
  })

  let app: App
  try {
    const connecting = connectStdio({
      write: (chunk) => { child.stdin.write(chunk) },
      feed: (listener) => { child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))) },
      close: async () => { child.kill('SIGTERM') },
    })
    void connecting.catch(() => undefined)
    app = await Promise.race([
      connecting,
      sleep(HANDSHAKE_TIMEOUT_MS).then(() => {
        throw new Error(`the app did not answer the automation handshake within ${HANDSHAKE_TIMEOUT_MS}ms`)
      }),
    ])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (spawnError !== undefined) return await teardown(2, `could not start ${binary.path}: ${spawnError.message}`)
    return await teardown(1, `automation handshake failed: ${detail}${appStderr === '' ? '' : `\n${appStderr}`}`)
  }

  const helper = clipboardLaneHelper(stubs.paths)
  let checks: Awaited<ReturnType<typeof runWorkbenchKeyLane>>
  try {
    checks = await runWorkbenchKeyLane(app, { compositor, nonce: randomBytes(4).toString('hex'), clipboard: helper })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const violations = helper.violations()
    const violationReport = violations.length === 0 ? '' : `\nthe clipboard helpers rejected ${violations.length} invocation(s):\n${violations.join('\n')}`
    return await teardown(1, `workbench key lane failed: ${detail}${violationReport}${appStderr === '' ? '' : `\n${appStderr}`}`)
  }

  const violations = helper.violations()
  if (violations.length > 0) {
    return await teardown(1, `the clipboard helpers rejected ${violations.length} invocation(s):\n${violations.join('\n')}`)
  }
  for (const check of checks) console.log(`pass ${check.name}: ${check.evidence}`)
  console.log(`clipboard helpers: ${helper.helperInvocations().length} read(s), ${helper.copyWrites()} write(s), 0 invalid invocations`)
  console.log(`workbench key lane complete: ${checks.length} checks passed on ${compositor} (${display === '' ? process.env.WAYLAND_DISPLAY ?? 'current session' : display})`)
  return await teardown(0)
}

process.once('SIGINT', () => { void teardown(130, 'workbench key lane interrupted (SIGINT)') })
process.once('SIGTERM', () => { void teardown(143, 'workbench key lane terminated (SIGTERM)') })
process.on('uncaughtException', (error: Error) => { void teardown(1, `workbench key lane crashed: ${error.stack ?? error.message}`) })
process.on('unhandledRejection', (reason: unknown) => { void teardown(1, `workbench key lane crashed: ${String(reason)}`) })

void main()
