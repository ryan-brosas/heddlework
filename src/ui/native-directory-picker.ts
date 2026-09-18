import * as gpuixNative from '@gpuix/native'
import { errorMessage } from '../pi/types.ts'
import { pickWorkspaceDirectory, type WorkspaceDirectoryPick } from './open-external.ts'

/**
 * What the native runtime reports for one dialog request.
 *
 * `safeToFallback` is the runtime's own verdict on whether opening another dialog is safe: it is
 * false while a portal dialog may still be on screen, and opening the CLI picker then would put two
 * dialogs in front of the user for one gesture.
 */
export interface NativeDirectoryResult {
  status: string
  path?: string | undefined
  reason?: string | undefined
  safeToFallback?: boolean | undefined
}

export interface NativeDirectoryDialog {
  open(
    renderer: unknown,
    options: { title?: string },
    listener: (result: NativeDirectoryResult) => void,
  ): { dispose(): void }
}

export interface ProjectDirectoryOptions {
  title?: string
  /** Injected by tests; the runtime's own transport otherwise. */
  dialog?: NativeDirectoryDialog | undefined
  /** Injected by tests; the platform CLI pickers otherwise. */
  fallback?: (() => Promise<WorkspaceDirectoryPick>) | undefined
}

type NativeOutcome =
  | { kind: 'selected'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason: string; safeToFallback: boolean }

/**
 * The pinned runtime's window-parented folder dialog.
 *
 * The namespace import is deliberate: the addon is installed by `bun run setup:native`, and a runtime
 * built before this primitive simply lacks the export. Asking for it as a value keeps that a missing
 * capability instead of a module-resolution failure at startup.
 */
function runtimeDirectoryDialog(): NativeDirectoryDialog | undefined {
  const open = gpuixNative.openDirectoryDialog as NativeDirectoryDialog['open'] | undefined
  return typeof open === 'function' ? { open } : undefined
}

export function classifyNativeResult(result: NativeDirectoryResult): NativeOutcome {
  if (result.status === 'selected' && result.path) return { kind: 'selected', path: result.path }
  if (result.status === 'cancelled') return { kind: 'cancelled' }
  return {
    kind: 'unavailable',
    reason: result.reason ?? 'The folder dialog could not be opened',
    // Only an explicit verdict authorizes a second dialog.
    safeToFallback: result.safeToFallback === true,
  }
}

/** Run one native dialog and settle exactly once, disposing the request either way. */
function runNativeDialog(
  dialog: NativeDirectoryDialog,
  renderer: unknown,
  title: string | undefined,
): Promise<NativeOutcome> {
  return new Promise((resolveOutcome) => {
    let request: { dispose(): void } | undefined
    let settled = false
    const finish = (outcome: NativeOutcome) => {
      if (settled) return
      settled = true
      // Disposal is what tells the portal to close a dialog that is still up, so it must not wait
      // for the promise's own bookkeeping.
      try { request?.dispose() } catch { /* the runtime already disposed it */ }
      resolveOutcome(outcome)
    }
    try {
      const opened = dialog.open(renderer, title === undefined ? {} : { title }, (result) => finish(classifyNativeResult(result)))
      request = opened
      // A result delivered inside the call itself settles before the handle exists, so the request
      // is disposed here instead of by the listener.
      if (settled) opened.dispose()
    } catch (error) {
      finish({ kind: 'unavailable', reason: errorMessage(error), safeToFallback: true })
    }
  })
}

/**
 * Pick a project folder, preferring the runtime's window-parented portal dialog.
 *
 * One gesture opens at most one dialog: the CLI pickers run only when the native transport reported
 * that it never opened one. A selection and a dismissal both end the gesture.
 */
export async function pickProjectDirectory(renderer: unknown, options: ProjectDirectoryOptions = {}): Promise<WorkspaceDirectoryPick> {
  const fallback = options.fallback ?? (() => pickWorkspaceDirectory())
  const dialog = options.dialog ?? runtimeDirectoryDialog()
  if (!dialog) return fallback()
  const outcome = await runNativeDialog(dialog, renderer, options.title)
  if (outcome.kind === 'selected') return { path: outcome.path }
  if (outcome.kind === 'cancelled') return {}
  if (outcome.safeToFallback) return fallback()
  return { error: outcome.reason }
}
