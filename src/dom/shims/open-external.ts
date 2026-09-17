// Browser replacements for src/ui/open-external.ts. Links open in a tab; paths and folder pickers are host-only.

export interface DirectoryPickerCommand { command: string; args: string[] }
export interface WorkspaceDirectoryPick { path?: string; error?: string }

/** The context `open` returned, or null when the tab refused it. */
interface OpenedTab { opener: unknown }

interface TabWindow {
  open(url: string, target: string): unknown
}

function tabWindow(): TabWindow {
  return window as unknown as TabWindow
}

export function openExternal(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.resolve(false)
  // A `noopener`/`noreferrer` feature makes window.open return null even when the tab opened, so the
  // return value could not say whether the tab was blocked and every link reported a failure. Open
  // first, then detach the opener: the browsing context is the success signal and the isolation is
  // the same. A blocked popup stays a real failure the caller may report.
  const opened = tabWindow().open(parsed.href, '_blank') as OpenedTab | null
  if (!opened) return Promise.resolve(false)
  opened.opener = null
  return Promise.resolve(true)
}

export function openPath(_path: string): Promise<boolean> { return Promise.resolve(false) }

export function directoryPickerCommand(): DirectoryPickerCommand | undefined { return undefined }
export function directoryPickerCommands(): DirectoryPickerCommand[] { return [] }
export async function pickWorkspaceDirectory(): Promise<WorkspaceDirectoryPick> {
  return { error: 'Folder picking is available on the desktop app' }
}
export function systemTargetCommand(target: string): DirectoryPickerCommand { return { command: 'open', args: [target] } }
