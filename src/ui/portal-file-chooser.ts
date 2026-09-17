import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The XDG Desktop Portal `FileChooser` request contract.
 *
 * This module is not on the live picker path. The portal sends `Request.Response` to the *requesting*
 * D-Bus connection, and the CLI transport here - `gdbus call` for the request, `dbus-monitor` for the
 * answer - abandons that connection as soon as the request handle is printed, so the answer is never
 * delivered and the picker waited out its whole session budget. Measured 2026-09-17 on Omarchy: the
 * dialog opens, and a session-wide, line-buffered monitor sees no `Response` signal at all, neither
 * while the dialog is up nor after the compositor dismisses it. What remains here is the token-keyed,
 * ownership-checked, completeness-gated contract that the native transport (`openDirectoryDialog`,
 * already exported by the installed addon) needs when it owns the connection instead.
 */
export type PortalPickStatus = 'selected' | 'cancelled' | 'unavailable'


export interface PortalPickResult {
  status: PortalPickStatus
  path?: string
  error?: string
}

export interface PortalPickerProbe {
  // Runs a bounded query and returns its output (undefined on timeout/failure).
  run?(command: string, args: string[], timeoutMs: number): Promise<string | undefined>
  // Listens for a portal Response signal. A listener that starts before the
  // OpenFile call is armed is passed the handle_token so it can discriminate
  // this request (the portal echoes the token in the request object path).
  monitor?(command: string, args: string[], timeoutMs: number, token: string, signal: AbortSignal): Promise<string | undefined>
  parseHandle?(output: string): string | undefined
  parseCode?(signal: string): number | undefined
  parseUris?(signal: string): string[]
}

const PORTAL_BUS = 'org.freedesktop.portal.Desktop'
const PORTAL_OBJECT = '/org/freedesktop/portal/desktop'
const PORTAL_METHOD = 'org.freedesktop.portal.FileChooser.OpenFile'
// gdbus parses trailing args as GVariant text literals, so the title must be
// a quoted string literal (spaces otherwise break argument parsing).
const TITLE = "'Open project in Heddlework'"
const IPC_TIMEOUT_MS = 6_000
// The folder dialog stays open for human navigation and can take minutes;
// only the D-Bus call that opens it is bounded by the short IPC timeout.
export const SESSION_TIMEOUT_MS = 5 * 60_000

function quoteVariant(value: string): string {
  return String.fromCharCode(0x27) + value + String.fromCharCode(0x27)
}

// XDG Desktop Portal FileChooser is asynchronous: OpenFile returns a request
// object path, and the selection arrives later as a Response signal on that
// object. The Response is one-shot, so the dbus-monitor listener MUST be
// established BEFORE invoking OpenFile: a response emitted between the call
// and listener startup (a fast cancel, a portal denial) would otherwise be
// lost and the pick would fall through after the full session timeout.
// We generate a unique handle_token, subscribe to Request Response signals
// keyed by that token, then call OpenFile with the same token, which the
// portal echoes back in the request object path.
export async function requestPortalDirectory(
  probe: PortalPickerProbe = {},
): Promise<PortalPickResult> {
  const run = probe.run ?? runCommand
  const monitor = probe.monitor ?? probe.run ?? runPortalMonitor
  const parseHandle = probe.parseHandle ?? extractOpenFilePath
  const parseCode = probe.parseCode ?? extractResponseCode
  const parseUris = probe.parseUris ?? extractUris

  const token = 'heddlework_' + randomBytes(9).toString('hex')
  const monitorArg = "type='signal',interface='org.freedesktop.portal.Request',member='Response'"
  // Listen BEFORE opening the portal so the response cannot arrive unseen.
  const monitorAbort = new AbortController()
  const signalPromise = monitor('dbus-monitor', ['--session', monitorArg], SESSION_TIMEOUT_MS, token, monitorAbort.signal)

  const openArgs = [
    'call', '--session',
    '--dest', PORTAL_BUS,
    '--object-path', PORTAL_OBJECT,
    '--method', PORTAL_METHOD,
    "''",
    TITLE,
    '{' + quoteVariant('directory') + ': <true>, ' + quoteVariant('modal') + ': <true>, ' + quoteVariant('handle_token') + ': <' + quoteVariant(token) + '>}',
  ]
  const handleOutput = await run('gdbus', openArgs, IPC_TIMEOUT_MS)
  if (handleOutput === undefined) {
    monitorAbort.abort()
    return { status: 'unavailable', error: 'File dialog portal is not reachable' }
  }
  // Validate that the opened request carries our token: a response to a
  // different request must not be mistaken for ours.
  const handle = parseHandle(handleOutput)
  if (!handle || !handle.endsWith('/' + token)) {
    monitorAbort.abort()
    return { status: 'unavailable', error: 'File dialog portal did not open' }
  }

  const signalOutput = await signalPromise
  if (signalOutput === undefined) return { status: 'unavailable', error: 'File dialog portal timed out' }
  // dbus-monitor is session-wide, so this capture mixes every portal request on the bus, including
  // other applications' dialogs. Only the record whose request path carries this call's handle_token
  // is our answer: reading the first uint32/URI out of the whole buffer adopts whichever dialog
  // answered first, which silently picked a stranger's folder.
  const response = portalSignalForToken(signalOutput, token)
  if (response === undefined) {
    return { status: 'unavailable', error: 'File dialog portal returned no response for this request' }
  }

  const code = parseCode(response)
  if (code === undefined) return { status: 'unavailable', error: 'File dialog portal returned an unknown response' }
  if (code === 1) return { status: 'cancelled' }

  const uri = parseUris(response)[0]
  if (!uri) return { status: 'unavailable', error: 'File dialog portal returned no selection' }
  return { status: 'selected', path: resolve(toFilePath(uri)) }
}

export function portalResponseMatchesToken(output: string, token: string): boolean {
  if (!token || !output.includes(token)) return false
  return new RegExp(
    `/org/freedesktop/portal/desktop/request/[^/\\s'"]+/${escapeRegExp(token)}`,
    'u',
  ).test(output)
}

/**
 * Select the Response record that belongs to `token` from a `dbus-monitor` capture.
 *
 * dbus-monitor is session-wide: the capture mixes every portal request on the bus, so the first
 * `uint32` and the first `file:` URI in it may belong to another application's dialog. Records are
 * separated on their `signal` header and only the one matching this request path survives.
 */
export function portalSignalForToken(output: string, token: string): string | undefined {
  if (!token) return undefined
  for (const record of output.split(/^(?=signal )/mu)) {
    if (portalResponseMatchesToken(record, token)) return record
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Runs a single-shot command, resolving as soon as full output closes. For
// long-lived streams (dbus-monitor) a streaming variant is used instead.
function runCommand(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((finish) => {
    let settled = false
    const done = (value?: string) => {
      if (settled) return
      settled = true
      finish(value)
    }
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      done(undefined)
      return
    }
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      done(undefined)
      return
    }
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    stdout.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)))
    stderr.on('data', (c: Buffer | string) => errors.push(Buffer.from(c)))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done()
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      done()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = code === 0 ? Buffer.concat(chunks).toString('utf8') : Buffer.concat(errors).toString('utf8')
      done(output && output.trim() ? output : undefined)
    })
  })
}

/**
 * Whether a Response record has arrived in full.
 *
 * dbus-monitor streams a signal body in whatever chunks its stdout flushes, so the response code
 * (uint32 0) routinely arrives in an earlier chunk than the file URI carrying the selection.
 * Settling on the code alone returned a record with no URI, which the picker reported as "returned
 * no selection" and then papered over with a second, CLI dialog. A body is complete once its
 * bracketed structure closes; quoted strings are skipped because a folder name may contain brackets.
 */
export function portalResponseRecordIsComplete(record: string): boolean {
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (const character of record) {
    if (escaped) {
      escaped = false
      continue
    }
    if (quote !== undefined) {
      if (character === '\\') escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '[' || character === '(') depth += 1
    else if (character === ']' || character === ')') depth -= 1
  }
  // An unbalanced close is a malformed record, not a reason to keep waiting: call it complete and let
  // the caller's own validation reject it, instead of holding a dialog open to the session timeout.
  return depth <= 0 && quote === undefined
}

// dbus-monitor is a long-lived stream: it never exits on its own, so we read
// stdout incrementally and resolve as soon as a Response signal whose request
// path carries our handle token has been captured in full, then terminate the
// child. This bounds the dialog wait instead of stalling to the full timeout.
export function runPortalMonitor(
  command: string,
  args: string[],
  timeoutMs: number,
  token: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((finish) => {

    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (output?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      try { child?.kill('SIGTERM') } catch { }
      finish(output)
    }
    const abort = () => done()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      done()
      return
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish(undefined)
      return
    }
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      finish(undefined)
      return
    }
    const chunks: Buffer[] = []
    timer = setTimeout(() => done(), timeoutMs)
    stdout.on('data', (c: Buffer | string) => {
      chunks.push(Buffer.from(c))
      const output = Buffer.concat(chunks).toString('utf8')
      const record = portalSignalForToken(output, token)
      if (record !== undefined && extractResponseCode(record) !== undefined && portalResponseRecordIsComplete(record)) done(record)
    })

    stderr.on('data', () => {})
    child.on('error', () => done(undefined))
    child.on('close', () => done(portalSignalForToken(Buffer.concat(chunks).toString('utf8'), token)))
  })
}

function extractOpenFilePath(stdout: string): string | undefined {
  const match = stdout.match(/\/org\/freedesktop\/portal\/desktop\/request\/[^'\s)]+/u)
  return match?.[0]
}

function extractResponseCode(signal: string): number | undefined {
  const match = signal.match(/\buint32\s+(\d+)\b/u)
  const value = match?.[1]
  return value === undefined ? undefined : Number(value)
}

function extractUris(signal: string): string[] {
  const uris: string[] = []
  const re = /file:(?:\/\/|\/)[^\s'"]+/gu
  let found
  while ((found = re.exec(signal)) !== null) uris.push(found[0])
  return uris
}

function toFilePath(uri: string): string {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return uri
    return decodeURIComponent(url.pathname)
  } catch {
    return uri
  }
}
