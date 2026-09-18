/**
 * Who owns the desktop clipboard keys in this process.
 *
 * The native runtime decides once, from its own capability answer, whether it binds `Ctrl+Insert` (copy) and
 * `Ctrl+V`/`Cmd+V`/`Shift+Insert` (paste) itself. Every surface that would otherwise implement those keys
 * has to ask, so a keystroke never has two owners - the double handling that made `Shift+Insert` copy text
 * while the app appended its own paste to the same draft.
 *
 * The native entry sets this before the first render; the web companion never does, so the DOM host keeps
 * the browser's own editing behavior.
 */
let owned = false

export function setNativeClipboardEditing(value: boolean): void {
  owned = value
}

export function nativeClipboardEditing(): boolean {
  return owned
}
