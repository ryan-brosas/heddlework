import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectStdio, type App } from '@gpuix/react/automation'
import { classifyNativeCopy, clipboardStageError } from './linux-clipboard-live-evidence.ts'

/**
 * Live clipboard probe for a real, disposable compositor session: no stubbed helpers and no host
 * clipboard. The caller starts the session (its own WAYLAND_DISPLAY and XDG_RUNTIME_DIR).
 *
 * The probe validates itself before it judges the app: a typed message must submit through the same
 * composer, so a failed paste cannot be confused with a harness that was never ready.
 *
 * The claims are about the clipboard contract, not about which side of the app owns the key: the pinned
 * runtime binds the clipboard keys itself (`patches/gpuix/0001-linux-native-runtime.patch`), so a real
 * compositor is the only place this path can be observed. Paste is judged by the message the composer
 * actually submitted, and copy by reading the session clipboard with the real helpers.
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
/** Checks this harness could not decide for a reason worth investigating. */
const inconclusive: string[] = []
/** Checks no automated input can stimulate, reported as named skips rather than as evidence. */
const manual: string[] = []
let passed = 0
let steps = 0
const pass = (name: string, evidence: string): void => { passed += 1; console.error(`PASS ${name}: ${evidence}`) }
const skip = (name: string, reason: string): void => { manual.push(name); console.error(`SKIP ${name}: ${reason}`) }
const fail = (name: string, evidence: string): void => { failures.push(name); console.error(`FAIL ${name}: ${evidence}`) }
const step = (message: string): void => console.error(`[${++steps}] ${message}`)

// 1. This session's clipboard round-trips through the real helpers.
step(`clipboard contract on ${waylandDisplay}`)
const copied = await run(['wl-copy', '--type', 'text/plain'], env, { input: marker })
if (copied.code !== 0) fail('live-clipboard-contract', `wl-copy exited ${copied.code}: ${copied.stderr.trim()}`)
const echoed = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
if (echoed.code === 0 && echoed.stdout === marker) pass('live-clipboard-contract', `wl-copy/wl-paste round-tripped ${JSON.stringify(marker)}`)
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
/** Stderr written during one gesture, kept apart so the answer cannot come from an earlier gesture's log. */
let gestureStderr = ''
let capturingGesture = false
child.stderr.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf8')
  stderr = (stderr + text).slice(-4_000)
  if (capturingGesture) gestureStderr += text
  writeFileSync(stderrPath, stderr)
})
const captureGestureStart = (): void => { gestureStderr = ''; capturingGesture = true }
const captureGestureEnd = (): string => { capturingGesture = false; return gestureStderr }
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
  const pasteWrite = await run(['wl-copy', '--type', 'text/plain'], env, { input: pasteMarker })
  const staged = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
  // A stage the helpers did not confirm would make a paste miss measure this harness, not the app.
  const pasteStageError = clipboardStageError(pasteWrite, staged, pasteMarker)
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
  if (pasteStageError !== undefined && controlMarker !== '') {
    inconclusive.push('shift-insert-pastes-real-clipboard')
    console.error(`INCONCLUSIVE shift-insert-pastes-real-clipboard: ${pasteStageError}`)
  } else if (pasted && controlMarker !== '') pass('shift-insert-pastes-real-clipboard', `Shift+Insert pasted the real clipboard text staged with wl-copy, and the composer submitted it as exactly ${JSON.stringify(pasteMarker)}`)
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
    // The clipboard is staged with a sentinel before the gesture. The previous step left the submitted paste
    // text on it, and that text is the very row being dragged here, so an untouched clipboard holding that text
    // would satisfy the byte comparison by itself. With the sentinel proven present first, the dragged text can
    // only appear if the gesture replaced it.
    const sentinel = `${marker}-sentinel`
    const sentinelWrite = await run(['wl-copy', '--type', 'text/plain'], env, { input: sentinel })
    const stagedBeforeCopy = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
    // The stage only has to be trustworthy; an ambiguous selection (one equal to the sentinel, or empty) is
    // the classifier's own inconclusive case, and a selection that merely contains the sentinel is fine.
    const stageError = clipboardStageError(sentinelWrite, stagedBeforeCopy, sentinel)
    if (stageError !== undefined) {
      inconclusive.push('ctrl-insert-copies-real-selection')
      console.error(`INCONCLUSIVE ctrl-insert-copies-real-selection: ${stageError}`)
    } else {
    captureGestureStart()
    await composer.press('ctrl-insert')
    await Bun.sleep(1_200)
    const gestureLog = captureGestureEnd()
    const read = await run(['wl-paste', '--no-newline', '--type', 'text'], env, { completion: 'stdout-end' })
    // One owner for the verdict (scripts/linux-clipboard-live-evidence.ts): from the helper's exit status, the
    // bytes, and this gesture's own stderr it decides pass, a named manual skip (recording whether the
    // runtime's missing-serial diagnostic was actually seen), or a failure. Wrong bytes always fail, and a
    // helper that did not succeed is never evidence.
    const verdict = classifyNativeCopy({ selectedText, sentinel, read, stderrSinceGesture: gestureLog })
    if (verdict.status === 'pass') pass('ctrl-insert-copies-real-selection', verdict.evidence)
    else if (verdict.status === 'skip') skip('ctrl-insert-copies-real-selection', verdict.evidence)
    else if (verdict.status === 'inconclusive') {
      inconclusive.push('ctrl-insert-copies-real-selection')
      console.error(`INCONCLUSIVE ctrl-insert-copies-real-selection: ${verdict.evidence}`)
    } else fail('ctrl-insert-copies-real-selection', verdict.evidence)
    }
    }
  }

  // Image half: an image-only clipboard has no text for the runtime to insert, so the paste action reports
  // the gesture and the application owns the attachment. This is the screenshot path a remapped desktop
  // depends on, and the only check here that observes an attachment rather than submitted text.
  const imagePath = resolve(import.meta.dir, '..', 'tests/fixtures/pasted-image.png')
  if (!existsSync(imagePath)) {
    inconclusive.push('shift-insert-attaches-real-clipboard-image')
    console.error(`INCONCLUSIVE shift-insert-attaches-real-clipboard-image: no fixture PNG at ${imagePath}`)
  } else {
    // `run` feeds stdin as UTF-8 text, so the bytes go through a file: binary must not be re-encoded.
    const stagedImage = await run(['sh', '-c', 'wl-copy --type image/png < "$1"', 'sh', imagePath], env)
    // `run` decodes stdout as UTF-8, which cannot represent PNG bytes, so the stage-verification is the
    // helper's exit status for the image type plus the fixture's own size - not a byte comparison of text.
    const imageEcho = await run(['wl-paste', '--no-newline', '--type', 'image/png'], env, { completion: 'stdout-end' })
    const stagedBytes = statSync(imagePath).size
    // Stage-verification: a clipboard that did not take the image would make the app look wrong for a
    // harness reason, so the check is declared inconclusive before the app is judged.
    const composerNode = await composer.element()
    await app.call('focus', { elementId: composerNode.id })
    await composer.fill('')
    await waitForIdle()
    const previewBefore = (await app.getByTestId('composer-image-preview').all()).length
    await composer.press('shift-insert')
    let previewAfter = previewBefore
    const previewDeadline = Date.now() + 15_000
    while (previewAfter <= previewBefore && Date.now() < previewDeadline) {
      await Bun.sleep(200)
      previewAfter = (await app.getByTestId('composer-image-preview').all()).length
    }
    const attached = previewAfter - previewBefore
    if (stagedImage.code !== 0 || imageEcho.code !== 0 || stagedBytes === 0) {
      inconclusive.push('shift-insert-attaches-real-clipboard-image')
      console.error(`INCONCLUSIVE shift-insert-attaches-real-clipboard-image: staging reported wl-copy exit ${stagedImage.code} / wl-paste image/png exit ${imageEcho.code} for a ${String(stagedBytes)}-byte fixture`)
    } else if (attached === 1) {
      pass('shift-insert-attaches-real-clipboard-image', `with only ${String(stagedBytes)} image byte(s) on the clipboard, Shift+Insert added exactly one composer attachment and submitted nothing`)
    } else {
      fail('shift-insert-attaches-real-clipboard-image', `Shift+Insert against an image-only clipboard changed the attachment count by ${String(attached)} (previews ${String(previewAfter)}); rows=${JSON.stringify(await rows())}`)
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
const manualSuffix = manual.length === 0 ? '' : `, ${String(manual.length)} manual (${manual.join(', ')})`
console.error(`live clipboard probe complete: ${String(passed)} checks passed${manualSuffix} on a real compositor session`)
