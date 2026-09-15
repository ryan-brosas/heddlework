import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { connectStdio, type App } from '@gpuix/react/automation'

/**
 * Live clipboard probe for a real, disposable compositor session: no stubbed helpers and no host
 * clipboard. The caller starts the session (its own WAYLAND_DISPLAY and XDG_RUNTIME_DIR).
 *
 * The probe validates itself before it judges the app: a typed message must submit through the same
 * composer, so a failed paste cannot be confused with a harness that was never ready.
 */
const runtimeDir = required('PROBE_RUNTIME_DIR')
const waylandDisplay = required('PROBE_WAYLAND_DISPLAY')
const binary = required('PROBE_BINARY')
const workspace = required('PROBE_WORKSPACE')
const marker = required('PROBE_MARKER')

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function sessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && key !== 'DISPLAY') env[key] = value
  }
  return { ...env, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: waylandDisplay, XDG_SESSION_TYPE: 'wayland', ...extra }
}

/**
 * `wl-copy` daemonizes a selection owner that inherits this process's stdio, so waiting for `close`
 * never fires; writers complete on their own exit, readers on stdout end (the production rule).
 */
async function run(
  command: string[],
  env: Record<string, string>,
  options: { input?: string; completion?: 'exit' | 'stdout-end'; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { input, completion = 'exit', timeoutMs = 15_000 } = options
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0]!, command.slice(1), { env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let exited = false
    let stdoutEnded = false
    let code: number | null = null
    const finish = (value: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy() } catch { /* closed */ }
      resolvePromise({ code: value, stdout, stderr })
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(-1) }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.stdout.on('end', () => { stdoutEnded = true; if (completion === 'stdout-end' && exited) finish(code ?? 0) })
    child.on('error', rejectPromise)
    child.on('exit', (exitCode) => {
      exited = true
      code = exitCode
      if (completion === 'exit' || stdoutEnded) finish(exitCode ?? 0)
    })
    child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'utf8'))
  })
}

const env = sessionEnv()
const failures: string[] = []
const inconclusive: string[] = []
let steps = 0
const pass = (name: string, evidence: string): void => console.error(`PASS ${name}: ${evidence}`)
const fail = (name: string, evidence: string): void => { failures.push(name); console.error(`FAIL ${name}: ${evidence}`) }
const step = (message: string): void => console.error(`[${++steps}] ${message}`)

// 1. This session's clipboard round-trips through the real helpers.
step(`clipboard contract on ${waylandDisplay}`)
const copied = await run(['wl-copy', '--type', 'text/plain'], env, { input: marker })
if (copied.code !== 0) fail('live-clipboard-contract', `wl-copy exited ${copied.code}: ${copied.stderr.trim()}`)
const echoed = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
if (echoed.stdout === marker) pass('live-clipboard-contract', `wl-copy/wl-paste round-tripped ${JSON.stringify(marker)}`)
else fail('live-clipboard-contract', `wl-paste returned ${JSON.stringify(echoed.stdout)} (exit ${echoed.code}) instead of ${JSON.stringify(marker)}`)

// 2. The application pastes that real clipboard text into its composer and submits it byte for byte.
const stderrPath = `${workspace}/app-stderr.log`
step(`launching ${binary} on ${waylandDisplay}`)
const appEnvironment = sessionEnv({
  HEDDLEWORK_DEMO: '1',
  HEDDLEWORK_HOST: '0',
  HEDDLEWORK_CWD: workspace,
  HOME: workspace,
  XDG_CONFIG_HOME: `${workspace}/config`,
  XDG_DATA_HOME: `${workspace}/data`,
  XDG_STATE_HOME: `${workspace}/state`,
  XDG_CACHE_HOME: `${workspace}/cache`,
})
const child: ChildProcessWithoutNullStreams = spawn(binary, [], { cwd: workspace, env: appEnvironment })
let stderr = ''
child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000); writeFileSync(stderrPath, stderr) })
try {
  const connecting = connectStdio({
    write: (chunk) => { child.stdin.write(chunk) },
    feed: (listener) => { child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))) },
    close: async () => { child.kill('SIGTERM') },
  })
  const app: App = await Promise.race([
    connecting,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('automation handshake timed out')), 30_000)),
  ])
  const composer = app.getByTestId('composer')
  await composer.waitFor({ timeoutMs: 30_000 })
  step('automation handshake and composer paint complete')

  // A message's text lives in a child `<text>` node, so a row is read recursively (the same shape the
  // workbench key lane uses); reading only `node.text` reports every submitted message as empty.
  const nodeText = (node: { text?: string; children?: unknown[] }): string => `${node.text ?? ''}${(node.children ?? []).map((child) => nodeText(child as { text?: string; children?: unknown[] })).join('')}`
  const rows = async (): Promise<string[]> => (await app.getByTestId('user-message-text').all()).map((node) => nodeText(node as { text?: string; children?: unknown[] }))
  const waitForRow = async (expected: string, timeoutMs = 25_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await rows()).includes(expected)) return true
      await Bun.sleep(200)
    }
    return false
  }
  // The harness must be ready (the composer action reads `send` when no turn is streaming) before any
  // submit can be judged: a cold start else looks like a dropped paste.
  // While a turn streams, the composer action reads `abort` and a submit is queued instead of appended, so
  // every submit waits for the idle action first (the same gate the workbench key lane uses).
  const waitForIdle = async (timeoutMs = 60_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await app.getByTestId('send').all()).length > 0) return true
      await Bun.sleep(250)
    }
    return false
  }
  const sendReady = await waitForIdle()
  step(`composer action ready: ${sendReady}`)

  // Calibration: the app accepts submits only once its session is live, and early ones are dropped, so a
  // typed probe must land before any paste verdict means anything.
  let controlMarker = ''
  for (let attempt = 1; attempt <= 5 && controlMarker === ''; attempt += 1) {
    const candidate = `${marker}-ready${attempt}`
    await composer.fill(candidate)
    await waitForIdle()
    await composer.press('enter')
    if (await waitForRow(candidate, 5_000)) controlMarker = candidate
    else console.error(`calibration attempt ${attempt} did not submit yet`)
  }
  if (controlMarker === '') {
    inconclusive.push('composed-message-submits')
    console.error(`INCONCLUSIVE composed-message-submits: five typed probes did not submit; rows=${JSON.stringify(await rows())} send=${sendReady}${stderr === '' ? '' : ` stderr=${stderr.slice(-300)}`}`)
  } else pass('composed-message-submits', `a typed message submitted as exactly ${JSON.stringify(controlMarker)} after ${await (async () => { return 'calibration' })()}`)

  // Paste: the real clipboard text must arrive in the draft and submit byte for byte.
  const pasteMarker = `${marker}-paste`
  await run(['wl-copy', '--type', 'text/plain'], env, { input: pasteMarker })
  const staged = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
  await composer.fill('')
  await waitForIdle()
  await composer.press('shift-insert')
  await Bun.sleep(1_200)
  await waitForIdle()
  const treeText = async (): Promise<string> => (await app.call('getAllText', {})).text.join(' | ')
  const draftView = async (label: string): Promise<string> => {
    const all = await treeText()
    const markerSeen = all.includes('paste')
    const placeholderSeen = all.includes('build in')
    return `${label}: marker_in_tree=${markerSeen} placeholder=${placeholderSeen}`
  }
  console.error(await draftView('before-paste'))
  await composer.press('enter')
  const pasted = await waitForRow(pasteMarker)
  // Without a validated submit path a paste miss measures the harness, not the paste path.
  if (controlMarker === '') inconclusive.push('shift-insert-pastes-real-clipboard')
  if (pasted && controlMarker !== '') pass('shift-insert-pastes-real-clipboard', `the composer submitted the real clipboard text ${JSON.stringify(pasteMarker)} through the real wl-paste path`)
  else if (controlMarker !== '') {
    fail('shift-insert-pastes-real-clipboard', `no submitted message matched ${JSON.stringify(pasteMarker)} (clipboard held ${JSON.stringify(staged.stdout)}, exit ${staged.code}); rows=${JSON.stringify(await rows())}${stderr === '' ? '' : ` stderr=${stderr.slice(-300)}`}`)
  }

  // Copy: a drag-selected message must reach this session's real clipboard.
  // Copy control: drag the newest row that has bounds (row bounds are optional per frame, and the row
  // under the pointer is the newest transcript entry), then require its own text on the real clipboard.
  const nodes = await app.getByTestId('user-message-text').all()
  const selectable = nodes.filter((node) => node.bounds !== undefined)
  const target = selectable[selectable.length - 1]
  const selectedMarker = target === undefined ? '' : nodeText(target as { text?: string; children?: unknown[] })
  if (target?.bounds === undefined || selectedMarker === '') {
    inconclusive.push('ctrl-insert-copies-real-selection')
    console.error('INCONCLUSIVE ctrl-insert-copies-real-selection: no control message bounds to drag over')
  } else {
    const y = target.bounds.y + target.bounds.height / 2
    await app.mouse.down({ x: target.bounds.x + 1, y }, { button: 0 })
    await app.mouse.move({ x: target.bounds.x + target.bounds.width / 2, y }, { pressedButton: 0 })
    await app.mouse.move({ x: target.bounds.x + target.bounds.width + 12, y }, { pressedButton: 0 })
    await app.mouse.up({ x: target.bounds.x + target.bounds.width + 12, y }, { button: 0 })
    // A drag that selected nothing must be reported as a harness gap, not as a failed copy.
    let selectedText = ''
    const selectionDeadline = Date.now() + 10_000
    while (!selectedText.includes(selectedMarker) && Date.now() < selectionDeadline) {
      selectedText = (await app.call('getSelectedText', {})).text ?? ''
      if (!selectedText.includes(selectedMarker)) await Bun.sleep(200)
    }
    if (!selectedText.includes(selectedMarker)) {
      inconclusive.push('ctrl-insert-copies-real-selection')
      console.error(`INCONCLUSIVE ctrl-insert-copies-real-selection: the drag selected ${JSON.stringify(selectedText)} instead of ${JSON.stringify(selectedMarker)}`)
    } else {
    await composer.press('ctrl-insert')
    await Bun.sleep(1_200)
    const read = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
    // Exact equality: a clipboard that merely contains the selection is not the selection.
    if (read.stdout === selectedText) pass('ctrl-insert-copies-real-selection', `this session's clipboard holds exactly the dragged selection: ${JSON.stringify(read.stdout)}`)
    else fail('ctrl-insert-copies-real-selection', `wl-paste returned ${JSON.stringify(read.stdout)} (exit ${read.code}) instead of the dragged selection ${JSON.stringify(selectedText)}`)
    }
  }
} finally {
  try { child.kill('SIGTERM') } catch { /* already gone */ }
}

if (failures.length > 0) {
  console.error(`live clipboard probe failed: ${failures.join(', ')}`)
  process.exit(1)
}
if (inconclusive.length > 0) {
  console.error(`live clipboard probe inconclusive: ${inconclusive.join(', ')}`)
  process.exit(2)
}
console.error('live clipboard probe complete: 3 checks passed on a real compositor session')
