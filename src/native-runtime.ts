export const REQUIRED_NATIVE_METHODS = ['setTerminalFrame', 'getWindowState', 'minimizeWindow', 'toggleMaximizeWindow', 'closeWindow'] as const

export function assertNativeRuntime(prototype: object): void {
  const methods = prototype as Record<string, unknown>
  const missing = REQUIRED_NATIVE_METHODS.filter((name) => typeof methods[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(`The installed GPUix runtime is missing ${missing.join(', ')}. Run bun run setup:native to install Heddlework's pinned runtime after bun install.`)
  }
}

/**
 * Capability added by `patches/gpuix/0001-linux-native-runtime.patch`: the runtime binds the desktop
 * clipboard keys itself - `Ctrl+Insert` (what Omarchy delivers for `Super+C`) copies the document selection,
 * and `Ctrl+V`/`Cmd+V`/`Shift+Insert` run its caret-aware paste action, which reports the inserted text
 * through a `paste` event. A host that answers this must not handle those keys again, or one keystroke has
 * two owners; a host that does not gets its own fallback.
 */
export const NATIVE_CLIPBOARD_EDITING_METHOD = 'supportsNativeClipboardEditing'

export function runtimeOwnsNativeClipboardEditing(subject: object | null | undefined): boolean {
  const method = (subject as Record<string, unknown> | null | undefined)?.[NATIVE_CLIPBOARD_EDITING_METHOD]
  if (typeof method !== 'function') return false
  // Ask it when there is an instance to ask: a runtime reporting `false` must not be treated as owning the
  // keys. The prototype has no native receiver to call, so its declared method is the answer there.
  try {
    const owned = (method as () => unknown).call(subject)
    return typeof owned === 'boolean' ? owned : true
  } catch {
    return true
  }
}
