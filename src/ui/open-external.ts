import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * How long a folder dialog may stay open. Browsing a filesystem takes minutes, so this bounds only a
 * picker that never comes back at all.
 */
export const PICKER_TIMEOUT_MS = 5 * 60_000

/**
 * The portal path used to run FileChooser.OpenFile through gdbus and watch for the answer with
 * dbus-monitor. That transport cannot receive the answer: the portal sends Request.Response to the
 * calling connection, and gdbus call exits as soon as it prints the request handle, so the response is
 * dropped and the picker waited out its whole session budget. Measured 2026-09-17 on Omarchy: the portal
 * dialog opens, and a session-wide line-buffered monitor sees no Response signal at all - neither while
 * the dialog is up nor after the compositor dismisses it. The request/response contract now lives with
 * the connection that owns it: `crates/gpui_linux/src/portal_file_chooser.rs` (declared by
 * `patches/zed/0002-portal-open-file-signature.patch`) issues the portal call, and
 * `src/ui/native-directory-picker.ts` is what reaches it. The CLI pickers below answer only when the
 * runtime reported that no dialog was opened.
 */


export interface DirectoryPickerCommand {
  command: string
  args: string[]
}

/** The launcher a call may override; tests use it to prove the reporting without starting a browser. */
export interface OpenTargetOptions {
  command?: DirectoryPickerCommand
}

/** Whether a target reached the system opener. Resolves false when it never started, so the
 *  surface that offered the action can say so instead of leaving a click with no effect. */
export async function openExternal(url: string, options: OpenTargetOptions = {}): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return openSystemTarget(parsed.href, options)
}

export function openPath(path: string, options: OpenTargetOptions = {}): Promise<boolean> {
  return openSystemTarget(resolve(path), options)
}

export function directoryPickerCommand(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand | undefined {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "Open project in Heddlework")'],
    }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Open project in Heddlework"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 1 }',
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return {
    command: 'kdialog',
    args: ['--getexistingdirectory', homedir(), '--title', 'Open project in Heddlework'],
  }
}

export interface WorkspaceDirectoryPick {
  path?: string
  error?: string
}

export function directoryPickerCommands(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand[] {
  const primary = directoryPickerCommand(platform)
  if (!primary) return []
  if (platform === 'darwin' || platform === 'win32') return [primary]
  const fallbacks = [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=Open project in Heddlework'] },
  ]
  return [primary, ...fallbacks]
}

export async function pickWorkspaceDirectory(
  platform: NodeJS.Platform = process.platform,
  options: { runPicker?(picker: DirectoryPickerCommand): Promise<DirectoryPickOutcome> } = {},
): Promise<WorkspaceDirectoryPick> {
  const runPicker = options.runPicker ?? ((picker: DirectoryPickerCommand) => runPickerCommand(picker))
  const pickers = directoryPickerCommands(platform)
  if (pickers.length === 0) return { error: 'No folder picker is available on this system' }
  const unavailable: string[] = []
  for (const picker of pickers) {
    const outcome = await runPicker(picker)
    if (outcome.kind === 'selected') return { path: outcome.path }
    // A dismissal is a decision, not a failure: stop here instead of opening a second dialog. Only a
    // picker that could not run at all is worth retrying with the next command.
    if (outcome.kind === 'cancelled') return {}
    unavailable.push(picker.command)
  }
  return { error: `Could not open a folder picker (${unavailable.join(', ')} not available)` }
}


export function systemTargetCommand(target: string, platform: NodeJS.Platform = process.platform): DirectoryPickerCommand {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [target] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

function openSystemTarget(target: string, options: OpenTargetOptions = {}): Promise<boolean> {
  const launch = options.command ?? systemTargetCommand(target)
  return new Promise((resolveLaunched) => {
    let settled = false
    const finish = (launched: boolean) => {
      if (settled) return
      settled = true
      resolveLaunched(launched)
    }
    try {
      const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true, windowsHide: true })
      // A missing opener reports through 'error'; 'spawn' means the system took it.
      child.on('error', () => finish(false))
      child.on('spawn', () => { child.unref(); finish(true) })
    } catch {
      // External launch failures are non-fatal and leave the current surface open.
      finish(false)
    }
  })
}

/** Grace between the soft and hard kill of a picker that overran its bound. */
const TERMINATION_GRACE_MS = 250

/**
 * Run one CLI picker and report its output. The bound is injectable so the timeout itself is
 * regression-tested instead of waiting out the real session budget.
 *
 * A stale or absent KDE/Qt

 * D-Bus service can leave them blocked at startup. Unbounded, that leaves the "Open project" promise
 * pending forever, with the sidebar waiting on it.
 */
interface BoundedCommandResult {
  /** undefined when the command never ran to the end: it could not be spawned, or it overran its bound. */
  readonly exitCode: number | undefined
  readonly stdout: string
}

/**
 * Run one picker process under a bound and report how it ended.
 *
 * A stale or absent KDE/Qt D-Bus service can leave a picker blocked at startup. Unbounded, that leaves
 * the Open project promise pending forever, with the sidebar waiting on it.
 */
function runBoundedCommand(command: string, args: string[], timeoutMs: number): Promise<BoundedCommandResult> {
  return new Promise((resolveResult) => {
    let settled = false
    let child: ChildProcess | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      // Settle the caller now, then escalate: a picker that ignores SIGTERM must not outlive its bound.
      // The escalation is cleared by the child's own exit, never by the settled result.
      try { child?.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child?.kill('SIGKILL') } catch { /* already gone */ } }, TERMINATION_GRACE_MS)
      finish(undefined, '')
    }, timeoutMs)
    const finish = (exitCode: number | undefined, stdout: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ exitCode, stdout })
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish(undefined, '')
      return
    }
    const stdout = child.stdout
    if (!stdout) {
      finish(undefined, '')
      return
    }
    const chunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => { if (killTimer) clearTimeout(killTimer); finish(undefined, '') })
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      finish(code === null ? undefined : code, Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/**
 * One picker's exit status, or undefined when it never ended inside its bound.
 *
 * kdialog reports a dismissal as exit 1, so 1 and 0 are decisions. Any other status is the picker
 * failing to do its job - letting it read as a dismissal silently swallowed the failure and left
 * `Open project` looking like it had done nothing.
 */
export function classifyPickerExit(exitCode: number | undefined): DirectoryPickOutcome {
  if (exitCode === undefined) return { kind: 'unavailable' }
  if (exitCode === 0 || exitCode === 1) return { kind: 'cancelled' }
  return { kind: 'unavailable' }
}

/** A completed picker output; undefined when it never ended inside its bound. */
export async function captureProcessOutput(
  command: string,
  args: string[],
  timeoutMs: number = PICKER_TIMEOUT_MS,
): Promise<string | undefined> {
  const result = await runBoundedCommand(command, args, timeoutMs)
  return result.exitCode === 0 && result.stdout ? result.stdout : undefined
}

/** What one picker process decided. */
export type DirectoryPickOutcome =
  | { kind: 'selected'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }

/**
 * Classify one picker run. A picker that ran to the end and printed nothing dismissed the dialog -
 * kdialog exits 1 on cancel - which is a decision, not a failure. Only a picker that could not run at
 * all is unavailable, and that is the single case worth retrying with the next command.
 */
export async function runPickerCommand(
  picker: DirectoryPickerCommand,
  timeoutMs: number = PICKER_TIMEOUT_MS,
): Promise<DirectoryPickOutcome> {
  const result = await runBoundedCommand(picker.command, picker.args, timeoutMs)
  const selected = result.stdout.trim()
  // Only a successful exit carries a selection. Output printed by a picker that then failed is not a
  // chosen folder, and accepting it let a failing picker bypass its own exit status.
  if (result.exitCode === 0 && selected) return { kind: 'selected', path: resolve(selected) }
  return classifyPickerExit(result.exitCode)
}
