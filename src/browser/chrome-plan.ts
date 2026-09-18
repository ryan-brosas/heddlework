/**
 * Pure decisions for the managed-Chrome backend.
 *
 * The transport, the process and the CDP socket are imperative and hard to test; every decision that
 * can be made without them lives here, so the two things that actually broke browser surfaces in this
 * repository - a command applied twice, and input landing on the wrong region - are decidable in a
 * unit test instead of only in a live browser.
 */
import type { BrowserCommand, BrowserCommandKind } from './types.ts'

/** What one pending browser command means for Chrome. */
export type ChromeCommandPlan =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'history'; readonly delta: -1 | 1 }
  | { readonly kind: 'reload' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'focus' }
  | { readonly kind: 'clearData'; readonly origin?: string | undefined }
  | { readonly kind: 'unsupported'; readonly command: BrowserCommandKind }

/**
 * Plan a command against the tab's current address.
 *
 * `clearData` needs an origin, so an unparseable address clears what one session can own rather than
 * every origin in the shared profile.
 */
export function planChromeCommand(command: BrowserCommand): ChromeCommandPlan {
  switch (command.kind) {
    case 'navigate':
      return command.value ? { kind: 'navigate', url: command.value } : { kind: 'unsupported', command: command.kind }
    case 'back':
      return { kind: 'history', delta: -1 }
    case 'forward':
      return { kind: 'history', delta: 1 }
    case 'reload':
      return { kind: 'reload' }
    case 'stop':
      return { kind: 'stop' }
    case 'focus':
      return { kind: 'focus' }
    case 'clearData':
      return { kind: 'clearData' }
    // DevTools and print are native-surface commands this backend does not implement, so they stay
    // unsupported instead of being acknowledged as done.
    case 'devtools':
    case 'print':
    case 'none':
      return { kind: 'unsupported', command: command.kind }
  }
}

export function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * Commands still owed to Chrome: every serial above the last acknowledged one, in order.
 *
 * The service's acknowledgement contract is what keeps a rerender from executing a command twice, so
 * this filter - not the caller - decides what is pending.
 */
export function pendingChromeCommands(tab: { commands: readonly BrowserCommand[]; commandSerial: number }, acknowledged: number): readonly BrowserCommand[] {
  return tab.commands.filter((command) => command.serial > acknowledged && command.serial <= tab.commandSerial)
}

export interface ChromeModifiers {
  readonly shift?: boolean | undefined
  readonly ctrl?: boolean | undefined
  readonly alt?: boolean | undefined
  readonly cmd?: boolean | undefined
}

/** CDP's modifier bit field: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifierBits(modifiers: ChromeModifiers | undefined): number {
  let bits = 0
  if (modifiers?.alt) bits |= 1
  if (modifiers?.ctrl) bits |= 2
  if (modifiers?.cmd) bits |= 4
  if (modifiers?.shift) bits |= 8
  return bits
}

export interface ChromeKeyEvent extends ChromeModifiers {
  readonly key?: string | undefined
  readonly keyChar?: string | undefined
}

export type ChromeKeyPlan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'paste' }
  | { readonly kind: 'press'; readonly params: Record<string, unknown> }
  | { readonly kind: 'ignore' }

/** Named keys that carry no printable character but must reach the page as a real key event. */
const NAMED_KEYS: Readonly<Record<string, { code: string; key: string; keyCode: number }>> = Object.freeze({
  enter: { code: 'Enter', key: 'Enter', keyCode: 13 },
  return: { code: 'Enter', key: 'Enter', keyCode: 13 },
  tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
  escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  esc: { code: 'Escape', key: 'Escape', keyCode: 27 },
  up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  home: { code: 'Home', key: 'Home', keyCode: 36 },
  end: { code: 'End', key: 'End', keyCode: 35 },
  pageup: { code: 'PageUp', key: 'PageUp', keyCode: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  space: { code: 'Space', key: ' ', keyCode: 32 },
})

/**
 * Whether a reported key is text to insert.
 *
 * Single character only: the runtime reports key names such as `f1`, `shift` or `control` through the
 * same field, and inserting those as typed characters would type the key's name into the page.
 */
function isPrintable(value: string | undefined): value is string {
  return typeof value === 'string' && [...value].length === 1 && !/^[\u0000-\u001f\u007f]$/.test(value)
}

/**
 * Plan one key press for the page.
 *
 * Paste is the browser's own gesture, so it is reported as an intent: Chrome's headless clipboard is
 * not the desktop clipboard, and the host already owns a tested desktop clipboard reader. Accelerators
 * (Ctrl/Cmd + a printable key) are forwarded as key events so the page keeps its own shortcuts.
 */
export function planChromeKey(event: ChromeKeyEvent): ChromeKeyPlan {
  const key = event.key?.toLowerCase()
  const accelerator = Boolean(event.ctrl) || Boolean(event.cmd)
  if (accelerator && key === 'v' && !event.alt) return { kind: 'paste' }
  if (accelerator || event.alt) {
    const named = key ? NAMED_KEYS[key] : undefined
    if (!named && !isPrintable(event.key) && !isPrintable(event.keyChar)) return { kind: 'ignore' }
    return {
      kind: 'press',
      params: {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          modifiers: modifierBits(event),
          text: '',
          unmodifiedText: '',
          key: named?.key ?? event.key,
          code: named?.code ?? codeForPrintable(event.key),
          windowsVirtualKeyCode: named?.keyCode ?? virtualKeyForPrintable(event.key),
        },
      },
    }
  }
  if (isPrintable(event.keyChar)) return { kind: 'text', text: event.keyChar }
  if (isPrintable(event.key)) return { kind: 'text', text: event.key }
  const named = key ? NAMED_KEYS[key] : undefined
  if (!named) return { kind: 'ignore' }
  return {
    kind: 'press',
    params: {
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', modifiers: modifierBits(event), text: named.key === ' ' ? ' ' : '', key: named.key, code: named.code, windowsVirtualKeyCode: named.keyCode },
    },
  }
}

function codeForPrintable(value: string | undefined): string {
  if (value && /^[a-z]$/i.test(value)) return `Key${value.toUpperCase()}`
  if (value && /^[0-9]$/.test(value)) return `Digit${value}`
  return ''
}

function virtualKeyForPrintable(value: string | undefined): number {
  if (!value) return 0
  const upper = value.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return upper.charCodeAt(0)
  if (/^[0-9]$/.test(value)) return value.charCodeAt(0)
  return 0
}

export interface ChromeBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ChromePointerEvent extends ChromeModifiers {
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly button?: number | undefined
  readonly clickCount?: number | undefined
  readonly pressedButton?: number | undefined
}

const MOUSE_BUTTONS: readonly string[] = ['left', 'middle', 'right']

/**
 * Map a pointer event in window coordinates onto the page's viewport.
 *
 * The surface is measured and Chrome's viewport is set to that measured size, so this is a subtraction
 * and not a scale factor. Events outside the surface are dropped rather than clamped: clamping turns a
 * click on the panel's own chrome into a click on whatever sits at the page edge.
 */
export function planChromePointer(event: ChromePointerEvent, bounds: ChromeBounds, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'): Record<string, unknown> | undefined {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return undefined
  const x = event.x - bounds.x
  const y = event.y - bounds.y
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return undefined
  const button = MOUSE_BUTTONS[event.button ?? 0] ?? 'left'
  const params: Record<string, unknown> = {
    type,
    x,
    y,
    modifiers: modifierBits(event),
    button: type === 'mouseMoved' ? 'none' : button,
    clickCount: type === 'mouseMoved' ? 0 : Math.max(1, event.clickCount ?? 1),
    buttons: type === 'mousePressed' ? buttonMask(event.button ?? 0) : type === 'mouseMoved' ? buttonMask(event.pressedButton) : 0,
  }
  return params
}

/**
 * CDP's held-button bit field: Left=1, Right=2, Middle=4.
 *
 * The order matters and is not the runtime's 0/1/2 index, where 1 is the middle button: using that order
 * here reported a held middle button as "right" and a held right button as "middle", which is what a page
 * sees during a drag with either button down.
 */
function buttonMask(button: number | undefined): number {
  switch (button) {
    case 0: return 1
    case 2: return 2
    case 1: return 4
    default: return 0
  }
}

/** A wheel event for the page; only non-zero deltas are worth sending. */
export function planChromeWheel(event: { deltaX?: number | undefined; deltaY?: number | undefined; x?: number | undefined; y?: number | undefined } & ChromeModifiers, bounds: ChromeBounds): Record<string, unknown> | undefined {
  const deltaX = typeof event.deltaX === 'number' ? event.deltaX : 0
  const deltaY = typeof event.deltaY === 'number' ? event.deltaY : 0
  if (deltaX === 0 && deltaY === 0) return undefined
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return undefined
  const x = event.x - bounds.x
  const y = event.y - bounds.y
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return undefined
  return { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: modifierBits(event) }
}

/**
 * How many device pixels Chrome should render per CSS pixel of the panel.
 *
 * The pinned renderer exposes no display scale, so guessing one would either blur every frame on a HiDPI
 * display or multiply bandwidth on a 1x one. The default is therefore 1 (one frame pixel per panel pixel,
 * which the compositor scales), and a HiDPI user can raise it deliberately. Values are clamped to the
 * range where the extra pixels are still worth their bandwidth.
 */
export const CHROME_FRAME_SCALE_RANGE = { min: 1, max: 2 } as const

export function chromeFrameScale(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = Number.parseFloat(environment.HEDDLEWORK_CHROME_FRAME_SCALE ?? '')
  if (!Number.isFinite(raw)) return CHROME_FRAME_SCALE_RANGE.min
  return Math.min(CHROME_FRAME_SCALE_RANGE.max, Math.max(CHROME_FRAME_SCALE_RANGE.min, raw))
}

/** The viewport Chrome should lay out for, and the screencast that mirrors it. */
export function planChromeViewport(width: number, height: number, scale = 1): { readonly metrics: Record<string, unknown>; readonly screencast: Record<string, unknown> } {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const safeScale = Number.isFinite(scale) ? Math.min(CHROME_FRAME_SCALE_RANGE.max, Math.max(CHROME_FRAME_SCALE_RANGE.min, scale)) : 1
  return {
    metrics: { width: safeWidth, height: safeHeight, deviceScaleFactor: safeScale, mobile: false, screenWidth: safeWidth, screenHeight: safeHeight },
    screencast: {
      format: 'jpeg',
      quality: 62,
      maxWidth: Math.round(safeWidth * safeScale),
      maxHeight: Math.round(safeHeight * safeScale),
      everyNthFrame: 1,
      maxFramesInFlight: 2,
      // A static page otherwise stops producing frames, so an acknowledged frame would never redraw.
      sendLastFrame: true,
    },
  }
}

/**
 * Whether starting new work must clear a previous failure.
 *
 * A failure stays visible until the user moves on: the panel hides the page behind the error banner, so
 * a stale error would keep a working page hidden after the user navigates or reloads again.
 */
export function shouldClearChromeError(pendingCommands: number, hasError: boolean): boolean {
  return pendingCommands > 0 && hasError
}

/** The throttle that keeps frame decoding off the React commit path. */
export const CHROME_FRAME_MIN_INTERVAL_MS = 66

/** Whether a freshly decoded frame should replace the one on screen yet. */
export function shouldPaintChromeFrame(lastPaintedAt: number, now: number): boolean {
  return now - lastPaintedAt >= CHROME_FRAME_MIN_INTERVAL_MS
}

export type ChromeEventPlan =
  | { readonly kind: 'navigated'; readonly url: string }
  | { readonly kind: 'loaded' }
  | { readonly kind: 'windowOpen'; readonly url: string | undefined }
  | { readonly kind: 'detached' }
  | { readonly kind: 'dialog' }
  | { readonly kind: 'ignore' }

/**
 * What a CDP event means for a tab.
 *
 * Only the main frame reports navigation: a subframe's URL is not the tab's address, and treating it as
 * one made the sidebar show an advertisement frame's address.
 */
export function planChromeEvent(method: string, params: Record<string, unknown>): ChromeEventPlan {
  switch (method) {
    case 'Page.frameNavigated': {
      const frame = params.frame as { url?: unknown; parentId?: unknown } | undefined
      if (!frame || typeof frame.parentId === 'string' || typeof frame.url !== 'string') return { kind: 'ignore' }
      return { kind: 'navigated', url: frame.url }
    }
    case 'Page.loadEventFired':
    case 'Page.frameStoppedLoading':
      return { kind: 'loaded' }
    case 'Page.windowOpen':
      return { kind: 'windowOpen', url: planChromeWindowOpen(params) }
    case 'Page.javascriptDialogOpening':
      return { kind: 'dialog' }
    case 'Inspector.detached':
    case 'Target.detachedFromTarget':
      return { kind: 'detached' }
    default:
      return { kind: 'ignore' }
  }
}

/**
 * The address a page asked to open in a new window.
 *
 * Measured against Chrome 152: `Page.windowOpen` is the event that carries this intent. The matching
 * `Target.targetCreated` reports the popup as `about:blank` with no `openerId`, so adopting from target
 * discovery silently missed every popup. A blank address returns undefined rather than a tab at
 * `about:blank`, which would show the user nothing they asked for.
 */
export function planChromeWindowOpen(params: Record<string, unknown>): string | undefined {
  const url = params.url
  if (typeof url !== 'string') return undefined
  const trimmed = url.trim()
  if (trimmed.length === 0 || trimmed === 'about:blank') return undefined
  return trimmed
}

/**
 * The browser's own popup windows to close once Heddlework has taken the request over.
 *
 * Chrome still creates the window it was asked for. Left alone it is a second, unmanaged copy of a page the
 * sidebar now owns - invisible and unreachable in this process.
 */
export function planOrphanPopupTargets(
  targetInfos: readonly { type?: unknown; openerId?: unknown; targetId?: unknown }[],
  ownedTargetIds: ReadonlySet<string>,
): readonly string[] {
  const orphans: string[] = []
  for (const info of targetInfos) {
    if (info.type !== 'page') continue
    if (typeof info.openerId !== 'string') continue
    if (typeof info.targetId !== 'string') continue
    if (!ownedTargetIds.has(info.openerId)) continue
    if (ownedTargetIds.has(info.targetId)) continue
    orphans.push(info.targetId)
  }
  return orphans
}

/** The address a navigation history entry points at, used to move back or forward one entry. */
export function historyTarget(history: { currentIndex?: unknown; entries?: unknown }, delta: -1 | 1): number | undefined {
  const currentIndex = typeof history.currentIndex === 'number' ? history.currentIndex : undefined
  const entries = Array.isArray(history.entries) ? history.entries : undefined
  if (currentIndex === undefined || !entries) return undefined
  const next = currentIndex + delta
  if (next < 0 || next >= entries.length) return undefined
  const entry = entries[next] as { id?: unknown } | undefined
  return typeof entry?.id === 'number' ? entry.id : undefined
}
