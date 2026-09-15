import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { requestPortalDirectory, SESSION_TIMEOUT_MS, type PortalPickResult } from './portal-file-chooser.ts'

export interface DirectoryPickerCommand {
  command: string
  args: string[]
}

export function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  openSystemTarget(parsed.href)
}

export function openPath(path: string): void {
  openSystemTarget(resolve(path))
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
  options: {
    requestPortal?(): Promise<PortalPickResult>
    capture?(command: string, args: string[]): Promise<string | undefined>
  } = {},
): Promise<WorkspaceDirectoryPick> {
  const requestPortal = options.requestPortal ?? requestPortalDirectory
  const capture = options.capture ?? captureProcessOutput
  if (platform === 'linux') {
    const portal = await requestPortal()
    if (portal.status === 'cancelled' || portal.status === 'selected') {
      return portal.path ? { path: portal.path } : {}
    }
  }
  const pickers = directoryPickerCommands(platform)
  if (pickers.length === 0) return { error: 'No folder picker is available on this system' }
  const failures: string[] = []
  for (const picker of pickers) {
    const selected = await capture(picker.command, picker.args)
    if (selected !== undefined) {
      return selected.trim() ? { path: resolve(selected.trim()) } : {}
    }
    failures.push(picker.command)
  }
  return { error: `Could not open a folder picker (${failures.join(', ')} not available)` }
}

export function systemTargetCommand(target: string, platform: NodeJS.Platform = process.platform): DirectoryPickerCommand {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [target] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

function openSystemTarget(target: string): void {
  const launch = systemTargetCommand(target)
  try {
    const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // External launch failures are non-fatal and leave the current surface open.
  }
}

/** Grace between the soft and hard kill of a picker that overran its bound. */
const TERMINATION_GRACE_MS = 250

/**
 * Run one CLI picker and report its output. The bound is injectable so the timeout itself is
 * regression-tested instead of waiting out the real session budget.
 *
 * kdialog and zenity are only reached when the portal is unavailable, and a stale or absent KDE/Qt
 * D-Bus service can leave them blocked at startup. Unbounded, that leaves the "Open project" promise
 * pending forever, with the sidebar waiting on it.
 */
export function captureProcessOutput(
  command: string,
  args: string[],
  timeoutMs: number = SESSION_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolveOutput) => {
    let settled = false
    let child: ChildProcess | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      // Settle the caller now, then escalate: a picker that ignores SIGTERM must not outlive its bound.
      // The escalation is cleared by the child's own exit, never by the settled result.
      try { child?.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child?.kill('SIGKILL') } catch { /* already gone */ } }, TERMINATION_GRACE_MS)
      finish()
    }, timeoutMs)
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveOutput(value)
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish()
      return
    }
    const stdout = child.stdout
    if (!stdout) {
      finish()
      return
    }
    const chunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => { if (killTimer) clearTimeout(killTimer); finish() })
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined)
    })
  })
}
