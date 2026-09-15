import { describe, expect, it } from 'bun:test'
import { assertNativeRuntime, NATIVE_CLIPBOARD_EDITING_METHOD, REQUIRED_NATIVE_METHODS, runtimeOwnsNativeClipboardEditing } from '../src/native-runtime.ts'

describe('native runtime compatibility', () => {
  it('rejects stock or mismatched runtime packages with repair instructions', () => {
    expect(() => assertNativeRuntime({})).toThrow('bun run setup:native')
    expect(() => assertNativeRuntime({ setTerminalFrame() {} })).toThrow('getWindowState')
    expect(() => assertNativeRuntime({ setTerminalFrame() {}, getWindowState() {}, minimizeWindow() {}, toggleMaximizeWindow() {}, closeWindow() {} })).not.toThrow()
    expect(REQUIRED_NATIVE_METHODS).toContain('setTerminalFrame')
  })

  it('reports native clipboard editing only when the runtime answers for it', () => {
    expect(NATIVE_CLIPBOARD_EDITING_METHOD).toBe('supportsNativeClipboardEditing')
    // A runtime built before the patch answers nothing, so the JavaScript fallback stays in place.
    expect(runtimeOwnsNativeClipboardEditing({ supportsNativeClipboardEditing: () => true })).toBe(true)
    expect(runtimeOwnsNativeClipboardEditing({})).toBe(false)
    expect(runtimeOwnsNativeClipboardEditing(undefined)).toBe(false)
  })

  it('does not treat a runtime that denies the capability as owning the keys', () => {
    expect(runtimeOwnsNativeClipboardEditing({ supportsNativeClipboardEditing: () => false })).toBe(false)
    expect(runtimeOwnsNativeClipboardEditing({ [NATIVE_CLIPBOARD_EDITING_METHOD]: true })).toBe(false)
    // The prototype has no native receiver to call, so its declared method is the answer there.
    const prototype = { [NATIVE_CLIPBOARD_EDITING_METHOD]() { throw new Error('native receiver required') } }
    expect(runtimeOwnsNativeClipboardEditing(prototype)).toBe(true)
  })
})
