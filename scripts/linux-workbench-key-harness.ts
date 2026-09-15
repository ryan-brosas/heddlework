/**
 * Testable half of the workbench clipboard-key driver (scripts/linux-workbench-key-smoke.ts).
 *
 * Everything here is either pure or touches files it was handed: argument parsing, binary and
 * artifact identity, private-display allocation, and the validated clipboard stubs. The driver owns
 * process plumbing and lifecycle; tests/linux-workbench-key-smoke.test.ts owns the deterministic
 * checks of this file, including running the generated stubs for real.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type WorkbenchKeyLaneDisplayMode = 'private' | 'current'

/** A caller mistake: the driver prints the message and exits 2, it never continues. */
export class WorkbenchKeySmokeUsageError extends Error {}

export interface WorkbenchKeySmokeInvocation {
  readonly installed: boolean
  readonly display: WorkbenchKeyLaneDisplayMode
  readonly binary: string | undefined
}

/**
 * `--display=current` is the only mode that can reach a real session's clipboard, so it is gated on an
 * explicit opt-in that names an *isolated* compositor session. A private Xvfb display is the default.
 */
export function parseWorkbenchKeySmokeArgs(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): WorkbenchKeySmokeInvocation {
  let installed = false
  let display: WorkbenchKeyLaneDisplayMode = 'private'
  for (const argument of argv) {
    if (argument === '--installed') {
      installed = true
    } else if (argument === '--display=private') {
      display = 'private'
    } else if (argument === '--display=current') {
      display = 'current'
    } else {
      throw new WorkbenchKeySmokeUsageError(`unknown argument: ${argument} (supported: --installed, --display=private, --display=current)`)
    }
  }
  if (display === 'current' && environment.HEDDLEWORK_SMOKE_ISOLATED_DISPLAY !== '1') {
    throw new WorkbenchKeySmokeUsageError(
      '--display=current is only for an isolated compositor session: set HEDDLEWORK_SMOKE_ISOLATED_DISPLAY=1 to confirm the display is disposable (never point it at your desktop session)',
    )
  }
  const binary = environment.HEDDLEWORK_APP_BINARY?.trim()
  return { installed, display, binary: binary || undefined }
}

export interface ResolvedAppBinary {
  readonly path: string
  readonly source: 'env' | 'installed' | 'checkout'
}

/** `HEDDLEWORK_APP_BINARY` wins over `--installed`, which wins over the checkout build. */
export function resolveAppBinaryPath(
  invocation: WorkbenchKeySmokeInvocation,
  environment: NodeJS.ProcessEnv,
  repoRoot: string,
): ResolvedAppBinary {
  if (invocation.binary !== undefined) return { path: invocation.binary, source: 'env' }
  if (invocation.installed) {
    const home = environment.HOME?.trim() || homedir()
    const dataHome = environment.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
    return { path: join(dataHome, 'heddlework', 'heddlework'), source: 'installed' }
  }
  return { path: join(repoRoot, 'dist', 'heddlework'), source: 'checkout' as const }
}

export type WorkbenchKeyLaneBackend = 'native-gpui' | 'web-companion' | 'unknown'

export interface ArtifactIdentity {
  /** The artifact whose bytes are hashed: a launcher resolves to the program it execs. */
  readonly path: string
  readonly sha256: string
  readonly backend: WorkbenchKeyLaneBackend
  /** Set when the tested path was a launcher that execs `path`. */
  readonly launchedFrom: string | undefined
}

const MAX_LAUNCHER_DEPTH = 2

/**
 * Identify the artifact that actually runs, so evidence cannot be attributed to a different build.
 *
 * `packaging/linux/install-user.sh` writes a `/bin/sh` launcher and runs the real executable from the
 * data home; hashing the launcher would identify the wrapper, not the app. A launcher that cannot be
 * followed reports `unknown` and the driver refuses to claim a backend it did not verify.
 */
export function readArtifactIdentity(path: string, depth = 0): ArtifactIdentity {
  const absolute = resolve(path)
  const bytes = readFileSync(absolute)
  if (isElf(bytes)) {
    return { path: absolute, sha256: sha256(bytes), backend: 'native-gpui', launchedFrom: undefined }
  }
  const target = depth < MAX_LAUNCHER_DEPTH ? launcherTarget(bytes.toString('utf8'), absolute) : undefined
  if (target !== undefined) {
    const identity = readArtifactIdentity(target, depth + 1)
    return { ...identity, launchedFrom: absolute }
  }
  return { path: absolute, sha256: sha256(bytes), backend: classifyScript(absolute), launchedFrom: undefined }
}

function isElf(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The one `exec` this repo's launcher writes; anything else (for example `exec env ...`) stays unknown. */
function launcherTarget(text: string, launcherPath: string): string | undefined {
  if (!text.startsWith('#!')) return undefined
  const match = /(?:^|\n)\s*exec\s+(?:'([^']+)'|"([^"]+)"|(\S+))/u.exec(text)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  if (raw === undefined || raw === '' || raw === 'env' || raw.startsWith('-')) return undefined
  const target = isAbsolute(raw) ? raw : resolve(dirname(launcherPath), raw)
  return existsSync(target) ? target : undefined
}

/** A non-ELF artifact is only labelled web when it lives in a web bundle; otherwise it is unknown. */
function classifyScript(path: string): WorkbenchKeyLaneBackend {
  return /(^|\/)web(\/|$)/u.test(path) ? 'web-companion' : 'unknown'
}

export const XVFB_DISPLAY_FIRST = 99
export const XVFB_DISPLAY_LAST = 90

/** Modern Xvfb allocates race-free with `-displayfd`; older builds need the probe fallback. */
export function xvfbSupportsDisplayfd(helpText: string): boolean {
  return /(^|\s)-displayfd(\s|$)/u.test(helpText)
}

/** Xvfb writes the chosen display number and a newline to the inherited fd. */
export function parseDisplayfdNumber(output: string): number | undefined {
  const match = /(?:^|\D)(\d{1,3})\s*$/u.exec(output.trim())
  const value = match?.[1] === undefined ? undefined : Number(match[1])
  return value !== undefined && Number.isInteger(value) ? value : undefined
}

/** First free display in the reserved fallback range, newest-allocated first. */
export function allocateDisplayNumber(options: {
  readonly isBusy: (display: number) => boolean
  readonly first?: number
  readonly last?: number
}): number {
  const first = options.first ?? XVFB_DISPLAY_FIRST
  const last = options.last ?? XVFB_DISPLAY_LAST
  for (let display = first; display >= last; display -= 1) {
    if (!options.isBusy(display)) return display
  }
  throw new Error(`no free X display between :${first} and :${last}`)
}

/** `displayfd` is the number the child sees for the extra `stdio` pipe (fd 3 in the driver). */
export function xvfbArguments(options: { readonly display?: string; readonly displayfd?: number }): readonly string[] {
  const args: string[] = []
  if (options.displayfd !== undefined) args.push('-displayfd', String(options.displayfd))
  if (options.display !== undefined) args.push(options.display)
  args.push('-screen', '0', '1280x900x24', '-nolisten', 'tcp', '+extension', 'GLX')
  return args
}

export const CLIPBOARD_LANE_ENVIRONMENT = {
  copyText: 'HEDDLEWORK_KEY_LANE_COPY_TEXT',
  copyLog: 'HEDDLEWORK_KEY_LANE_COPY_LOG',
  pasteText: 'HEDDLEWORK_KEY_LANE_PASTE_TEXT',
  pasteKind: 'HEDDLEWORK_KEY_LANE_PASTE_KIND',
  helperLog: 'HEDDLEWORK_KEY_LANE_HELPER_LOG',
  violations: 'HEDDLEWORK_KEY_LANE_VIOLATIONS',
} as const

export interface ClipboardLanePaths {
  readonly directory: string
  readonly copyText: string
  readonly copyLog: string
  readonly pasteText: string
  readonly pasteKind: string
  readonly helperLog: string
  readonly violations: string
}

export function clipboardLanePaths(directory: string): ClipboardLanePaths {
  return {
    directory,
    copyText: join(directory, 'copied-bytes'),
    copyLog: join(directory, 'copy-writes.log'),
    pasteText: join(directory, 'paste-text'),
    pasteKind: join(directory, 'paste-kind'),
    helperLog: join(directory, 'helper-reads.log'),
    violations: join(directory, 'helper-violations.log'),
  }
}

export function clipboardLaneEnvironment(paths: ClipboardLanePaths): Record<string, string> {
  return {
    [CLIPBOARD_LANE_ENVIRONMENT.copyText]: paths.copyText,
    [CLIPBOARD_LANE_ENVIRONMENT.copyLog]: paths.copyLog,
    [CLIPBOARD_LANE_ENVIRONMENT.pasteText]: paths.pasteText,
    [CLIPBOARD_LANE_ENVIRONMENT.pasteKind]: paths.pasteKind,
    [CLIPBOARD_LANE_ENVIRONMENT.helperLog]: paths.helperLog,
    [CLIPBOARD_LANE_ENVIRONMENT.violations]: paths.violations,
  }
}

export interface ClipboardStubScripts {
  readonly wlCopy: string
  readonly wlPaste: string
  readonly xclip: string
}

const COPY_TEXT = `$HEDDLEWORK_KEY_LANE_COPY_TEXT`
const COPY_LOG = `$HEDDLEWORK_KEY_LANE_COPY_LOG`
const PASTE_TEXT = `$HEDDLEWORK_KEY_LANE_PASTE_TEXT`
const PASTE_KIND = `$HEDDLEWORK_KEY_LANE_PASTE_KIND`
const HELPER_LOG = `$HEDDLEWORK_KEY_LANE_HELPER_LOG`
const VIOLATIONS = `$HEDDLEWORK_KEY_LANE_VIOLATIONS`

/**
 * The stubs are the lane's clipboard boundary: they observe exactly what the app asked the clipboard
 * to do, they fail loudly on an invocation the app should not make, and they keep the real
 * `wl-copy`/`wl-paste`/`xclip` (and with them the operator's clipboard) out of reach.
 */
export function clipboardStubScripts(): ClipboardStubScripts {
  const wlCopy = `#!/bin/sh
# Workbench-key lane stub for wl-copy: records the exact bytes handed to the clipboard.
# Any invocation the lane does not expect is a violation that fails the run.
set -u
violation() { printf '%s\\n' "$1" >> "${VIOLATIONS}"; printf 'wl-copy: %s\\n' "$1" >&2; exit 2; }
trim=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --type|-t)
      [ "$#" -ge 2 ] || violation "missing --type value: $*"
      case "$2" in
        text|text/plain|text/plain\\;charset=utf-8) ;;
        *) violation "unsupported mime type: $2" ;;
      esac
      shift 2
      ;;
    --type=*)
      case "${'${1#--type=}'}" in
        text|text/plain) ;;
        *) violation "unsupported mime type: ${'${1#--type=}'}" ;;
      esac
      shift
      ;;
    --trim-newline|-n) trim=1; shift ;;
    --no-newline) shift ;;
    --clear|-c)
      : > "${COPY_TEXT}"
      printf 'clear\\n' >> "${COPY_LOG}"
      exit 0
      ;;
    *) violation "unsupported argument: $1" ;;
  esac
done
cat > "${COPY_TEXT}"
if [ "$trim" = 1 ]; then
  printf '%s' "$(cat "${COPY_TEXT}")" > "${COPY_TEXT}"
fi
printf 'write\\n' >> "${COPY_LOG}"
`

  const wlPaste = `#!/bin/sh
# Workbench-key lane stub for wl-paste: text reads answer from the staged file using the real
# tool's trailing-newline rule; image reads fail and never hand the staged text to an image
# reader; anything else is a violation.
set -u
violation() { printf '%s\\n' "$1" >> "${VIOLATIONS}"; printf 'wl-paste: %s\\n' "$1" >&2; exit 2; }
type=text
no_newline=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --type|-t)
      [ "$#" -ge 2 ] || violation "missing --type value: $*"
      type="$2"
      shift 2
      ;;
    --type=*) type="${'${1#--type=}'}"; shift ;;
    --no-newline|-n) no_newline=1; shift ;;
    *) violation "unsupported argument: $1" ;;
  esac
done
case "$type" in
  image/*)
    printf 'image %s\\n' "$type" >> "${HELPER_LOG}"
    exit 1
    ;;
  text|text/plain) ;;
  *) violation "unsupported mime type: $type" ;;
esac
if [ "$(cat "${PASTE_KIND}")" = image ]; then
  printf 'text %s (image-only clipboard)\\n' "$type" >> "${HELPER_LOG}"
  exit 1
fi
printf 'text %s\\n' "$type" >> "${HELPER_LOG}"
if [ ! -s "${PASTE_TEXT}" ]; then
  exit 0
fi
if [ "$no_newline" != 1 ]; then
  cat "${PASTE_TEXT}"
  if [ "$(tail -c 1 "${PASTE_TEXT}" | wc -l | tr -d ' ')" = 0 ]; then
    printf '\\n'
  fi
  exit 0
fi
cat "${PASTE_TEXT}"
`

  const xclip = `#!/bin/sh
# Workbench-key lane stub for xclip: the fallback is isolated from the host clipboard. Read probes
# are recorded and answered with failure; a write through xclip is unobservable by the lane, so it is
# a violation.
set -u
for argument in "$@"; do
  case "$argument" in
    -o|--output)
      printf 'xclip (blocked read) %s\\n' "$*" >> "${HELPER_LOG}"
      exit 1
      ;;
  esac
done
printf 'xclip-write %s\\n' "$*" >> "${VIOLATIONS}"
printf 'xclip: the lane never writes through xclip\\n' >&2
exit 1
`

  return { wlCopy, wlPaste, xclip }
}

export interface ClipboardStubs {
  readonly paths: ClipboardLanePaths
  readonly scripts: ClipboardStubScripts
}

export function writeClipboardStubs(directory: string): ClipboardStubs {
  mkdirSync(directory, { recursive: true })
  const paths = clipboardLanePaths(directory)
  const scripts = clipboardStubScripts()
  writeFileSync(join(directory, 'wl-copy'), scripts.wlCopy)
  writeFileSync(join(directory, 'wl-paste'), scripts.wlPaste)
  writeFileSync(join(directory, 'xclip'), scripts.xclip)
  chmodSync(join(directory, 'wl-copy'), 0o755)
  chmodSync(join(directory, 'wl-paste'), 0o755)
  chmodSync(join(directory, 'xclip'), 0o755)
  writeFileSync(paths.copyText, '')
  writeFileSync(paths.copyLog, '')
  writeFileSync(paths.pasteText, '')
  writeFileSync(paths.pasteKind, 'text')
  writeFileSync(paths.helperLog, '')
  writeFileSync(paths.violations, '')
  return { paths, scripts }
}

/** The lane's clipboard channel, backed by the stub files. */
export interface ClipboardLaneHelper {
  /** Exact (untrimmed) bytes the app last handed to the clipboard, decoded as UTF-8. */
  copiedText(): string
  copyWrites(): number
  stagePaste(text: string): void
  stageImage(): void
  violations(): readonly string[]
  helperInvocations(): readonly string[]
}

export function clipboardLaneHelper(paths: ClipboardLanePaths): ClipboardLaneHelper {
  const text = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const lines = (path: string): string[] => text(path).split('\n').filter((line) => line.length > 0)
  return {
    copiedText: () => text(paths.copyText),
    copyWrites: () => lines(paths.copyLog).length,
    stagePaste: (value: string) => {
      writeFileSync(paths.pasteText, value)
      writeFileSync(paths.pasteKind, 'text')
    },
    stageImage: () => { writeFileSync(paths.pasteKind, 'image') },
    violations: () => lines(paths.violations),
    helperInvocations: () => lines(paths.helperLog),
  }
}

export interface WorkbenchKeyLaneEnvironmentOptions {
  readonly base: NodeJS.ProcessEnv
  readonly workspace: string
  readonly stubDirectory: string
  readonly display: string
  readonly displayMode: WorkbenchKeyLaneDisplayMode
  readonly paths: ClipboardLanePaths
}

/**
 * A run gets its own HOME and XDG homes, its own private display, and a PATH whose clipboard helpers
 * are the lane's stubs - so the run can neither read the operator's state nor reach the real
 * clipboard tools. `--display=current` keeps the compositor session's display variables, because a
 * Wayland client needs the session's `XDG_RUNTIME_DIR` to connect at all.
 */
export function workbenchKeyLaneEnvironment(options: WorkbenchKeyLaneEnvironmentOptions): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.base)) {
    if (typeof value === 'string') environment[key] = value
  }
  environment.PATH = `${options.stubDirectory}:${options.base.PATH ?? ''}`
  if (options.display === '') delete environment.DISPLAY
  else environment.DISPLAY = options.display
  environment.HOME = options.workspace
  environment.XDG_CONFIG_HOME = join(options.workspace, 'config')
  environment.XDG_DATA_HOME = join(options.workspace, 'data')
  environment.XDG_STATE_HOME = join(options.workspace, 'state')
  environment.XDG_CACHE_HOME = join(options.workspace, 'cache')
  environment.HEDDLEWORK_DEMO = '1'
  environment.HEDDLEWORK_CWD = options.workspace
  environment.HEDDLEWORK_HOST = '0'
  for (const [key, value] of Object.entries(clipboardLaneEnvironment(options.paths))) environment[key] = value
  if (options.displayMode === 'private') {
    delete environment.WAYLAND_DISPLAY
    delete environment.HEDDLEWORK_SESSION
    environment.XDG_SESSION_TYPE = 'x11'
    environment.XDG_RUNTIME_DIR = join(options.workspace, 'runtime')
  } else {
    environment.XDG_SESSION_TYPE = options.base.XDG_SESSION_TYPE ?? 'wayland'
  }
  return environment
}
