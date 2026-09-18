import { describe, expect, it } from 'bun:test'
import {
  CHROME_FRAME_MIN_INTERVAL_MS,
  chromeFrameScale,
  historyTarget,
  modifierBits,
  originOf,
  pendingChromeCommands,
  planChromeCommand,
  planChromeEvent,
  planChromeKey,
  planChromePaste,
  planChromePointer,
  planChromeWindowOpen,
  planOrphanPopupTargets,
  shouldClearChromeError,
  planChromeViewport,
  planChromeWheel,
  shouldPaintChromeFrame,
} from '../src/browser/chrome-plan.ts'
import type { BrowserCommand } from '../src/browser/types.ts'

const bounds = { x: 100, y: 50, width: 400, height: 300 }

function command(serial: number, kind: BrowserCommand['kind'], value?: string): BrowserCommand {
  return value === undefined ? { serial, kind } : { serial, kind, value }
}

describe('chrome command planning', () => {
  it('maps every command the sidebar can issue onto a Chrome action', () => {
    expect(planChromeCommand(command(1, 'navigate', 'https://example.com'))).toEqual({ kind: 'navigate', url: 'https://example.com' })
    expect(planChromeCommand(command(2, 'back'))).toEqual({ kind: 'history', delta: -1 })
    expect(planChromeCommand(command(3, 'forward'))).toEqual({ kind: 'history', delta: 1 })
    expect(planChromeCommand(command(4, 'reload'))).toEqual({ kind: 'reload' })
    expect(planChromeCommand(command(5, 'stop'))).toEqual({ kind: 'stop' })
    expect(planChromeCommand(command(6, 'focus'))).toEqual({ kind: 'focus' })
    expect(planChromeCommand(command(7, 'clearData'))).toEqual({ kind: 'clearData' })
  })

  it('reports commands this backend cannot perform instead of pretending they ran', () => {
    expect(planChromeCommand(command(1, 'devtools'))).toEqual({ kind: 'unsupported', command: 'devtools' })
    expect(planChromeCommand(command(2, 'print'))).toEqual({ kind: 'unsupported', command: 'print' })
    expect(planChromeCommand(command(3, 'none'))).toEqual({ kind: 'unsupported', command: 'none' })
    expect(planChromeCommand(command(4, 'navigate'))).toEqual({ kind: 'unsupported', command: 'navigate' })
  })

  it('only clears an origin it can name', () => {
    expect(originOf('https://example.com/a?b#c')).toBe('https://example.com')
    expect(originOf('data:text/html,<p>x</p>')).toBeUndefined()
    expect(originOf('about:blank')).toBeUndefined()
    expect(originOf('not a url')).toBeUndefined()
  })

  it('applies only commands above the acknowledged watermark', () => {
    const commands = [command(1, 'navigate', 'https://a.test'), command(2, 'focus'), command(3, 'reload')]
    expect(pendingChromeCommands({ commands, commandSerial: 3 }, 0).map((c) => c.serial)).toEqual([1, 2, 3])
    expect(pendingChromeCommands({ commands, commandSerial: 3 }, 1).map((c) => c.serial)).toEqual([2, 3])
    expect(pendingChromeCommands({ commands, commandSerial: 3 }, 3)).toEqual([])
    // A command the service has not published yet is not owed to Chrome.
    expect(pendingChromeCommands({ commands: [command(9, 'reload')], commandSerial: 3 }, 0)).toEqual([])
  })
})

describe('chrome key planning', () => {
  it('treats paste as the browser gesture it is', () => {
    expect(planChromeKey({ key: 'v', ctrl: true })).toEqual({ kind: 'paste' })
    expect(planChromeKey({ key: 'V', cmd: true, shift: true })).toEqual({ kind: 'paste' })
    // Alt is a different gesture (menu access), so it is not treated as paste.
    expect(planChromeKey({ key: 'v', ctrl: true, alt: true }).kind).toBe('press')
  })

  it('forwards accelerators so the page keeps its own shortcuts', () => {
    const plan = planChromeKey({ key: 'c', ctrl: true })
    expect(plan.kind).toBe('press')
    if (plan.kind !== 'press') throw new Error('expected a press plan')
    expect(plan.params).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', modifiers: 2, text: '', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 },
    })
  })

  it('sends printable characters as text and named keys as key events', () => {
    expect(planChromeKey({ key: 'a', keyChar: 'a' })).toEqual({ kind: 'text', text: 'a' })
    expect(planChromeKey({ key: 'A', keyChar: 'A', shift: true })).toEqual({ kind: 'text', text: 'A' })
    const enter = planChromeKey({ key: 'Enter' })
    expect(enter.kind).toBe('press')
    if (enter.kind !== 'press') throw new Error('expected a press plan')
    expect(enter.params.params).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  })

  it('never types a key name into the page', () => {
    for (const key of ['f1', 'shift', 'control', 'meta', 'capslock', 'insert']) {
      expect(planChromeKey({ key })).toEqual({ kind: 'ignore' })
    }
    expect(planChromeKey({ key: 'f1', ctrl: true })).toEqual({ kind: 'ignore' })
  })

  it('encodes the CDP modifier bit field', () => {
    expect(modifierBits(undefined)).toBe(0)
    expect(modifierBits({ alt: true })).toBe(1)
    expect(modifierBits({ ctrl: true, shift: true })).toBe(10)
    expect(modifierBits({ alt: true, ctrl: true, cmd: true, shift: true })).toBe(15)
  })
})

describe('chrome pointer planning', () => {
  it('maps a click onto the page viewport', () => {
    expect(planChromePointer({ x: 120, y: 80 }, bounds, 'mousePressed')).toMatchObject({ x: 20, y: 30, type: 'mousePressed', button: 'left', clickCount: 1, buttons: 1 })
    expect(planChromePointer({ x: 120, y: 80 }, bounds, 'mouseReleased')).toMatchObject({ x: 20, y: 30, buttons: 0 })
    expect(planChromePointer({ x: 120, y: 80, clickCount: 2 }, bounds, 'mousePressed')).toMatchObject({ clickCount: 2 })
  })

  it('drops events outside the surface instead of clamping them onto the page edge', () => {
    expect(planChromePointer({ x: 99, y: 80 }, bounds, 'mousePressed')).toBeUndefined()
    expect(planChromePointer({ x: 501, y: 80 }, bounds, 'mousePressed')).toBeUndefined()
    // The surface spans y 50..350: the edge is inside, the first pixel past it is outside.
    expect(planChromePointer({ x: 120, y: 350 }, bounds, 'mousePressed')).toMatchObject({ y: 300 })
    expect(planChromePointer({ x: 120, y: 351 }, bounds, 'mousePressed')).toBeUndefined()
    expect(planChromePointer({ y: 80 }, bounds, 'mousePressed')).toBeUndefined()
  })

  it('reports the button and the held-button mask in CDP order', () => {
    // CDP's bit field is Left=1, Right=2, Middle=4; the runtime indexes buttons as left=0, middle=1, right=2.
    expect(planChromePointer({ x: 120, y: 80, button: 0 }, bounds, 'mousePressed')).toMatchObject({ button: 'left', buttons: 1 })
    expect(planChromePointer({ x: 120, y: 80, button: 1 }, bounds, 'mousePressed')).toMatchObject({ button: 'middle', buttons: 4 })
    expect(planChromePointer({ x: 120, y: 80, button: 2 }, bounds, 'mousePressed')).toMatchObject({ button: 'right', buttons: 2 })
    expect(planChromePointer({ x: 120, y: 80, pressedButton: 1 }, bounds, 'mouseMoved')).toMatchObject({ button: 'none', buttons: 4, clickCount: 0 })
    expect(planChromePointer({ x: 120, y: 80, pressedButton: 2 }, bounds, 'mouseMoved')).toMatchObject({ buttons: 2 })
    expect(planChromePointer({ x: 120, y: 80, pressedButton: 0 }, bounds, 'mouseMoved')).toMatchObject({ buttons: 1 })
  })

  it('maps the wheel only when it carries a delta inside the surface', () => {
    expect(planChromeWheel({ x: 120, y: 80, deltaX: 0, deltaY: 40 }, bounds)).toMatchObject({ type: 'mouseWheel', x: 20, y: 30, deltaX: 0, deltaY: 40 })
    expect(planChromeWheel({ x: 120, y: 80, deltaX: 0, deltaY: 0 }, bounds)).toBeUndefined()
    expect(planChromeWheel({ x: 10, y: 80, deltaY: 40 }, bounds)).toBeUndefined()
  })
})

describe('chrome viewport planning', () => {
  it('lays Chrome out at the measured size so input needs no scale factor', () => {
    const { metrics, screencast } = planChromeViewport(900.4, 600.6)
    expect(metrics).toMatchObject({ width: 900, height: 601, deviceScaleFactor: 1, mobile: false })
    expect(screencast).toMatchObject({ format: 'jpeg', maxWidth: 900, maxHeight: 601, maxFramesInFlight: 2, sendLastFrame: true })
  })

  it('never asks for a zero-sized viewport', () => {
    expect(planChromeViewport(0, -5).metrics).toMatchObject({ width: 1, height: 1 })
  })

  it('renders one frame pixel per panel pixel unless a scale is asked for', () => {
    // The panel is always laid out in CSS pixels; the scale only changes frame resolution.
    const scaled = planChromeViewport(900, 600, 1.5)
    expect(scaled.metrics).toMatchObject({ width: 900, height: 600, deviceScaleFactor: 1.5 })
    expect(scaled.screencast).toMatchObject({ maxWidth: 1350, maxHeight: 900 })
  })

  it('clamps an implausible scale instead of streaming a useless frame', () => {
    expect(planChromeViewport(100, 100, 9).metrics).toMatchObject({ deviceScaleFactor: 2 })
    expect(planChromeViewport(100, 100, 0.1).metrics).toMatchObject({ deviceScaleFactor: 1 })
    expect(planChromeViewport(100, 100, Number.NaN).metrics).toMatchObject({ deviceScaleFactor: 1 })
  })

  it('clears a previous failure only when new work arrives', () => {
    expect(shouldClearChromeError(1, true)).toBe(true)
    expect(shouldClearChromeError(3, true)).toBe(true)
    // Nothing pending means the user has not moved on, so the failure stays visible.
    expect(shouldClearChromeError(0, true)).toBe(false)
    expect(shouldClearChromeError(2, false)).toBe(false)
  })

  it('reads the frame scale from the environment, with a safe default', () => {
    expect(chromeFrameScale({})).toBe(1)
    expect(chromeFrameScale({ HEDDLEWORK_CHROME_FRAME_SCALE: '1.5' })).toBe(1.5)
    expect(chromeFrameScale({ HEDDLEWORK_CHROME_FRAME_SCALE: '3' })).toBe(2)
    expect(chromeFrameScale({ HEDDLEWORK_CHROME_FRAME_SCALE: '0' })).toBe(1)
    expect(chromeFrameScale({ HEDDLEWORK_CHROME_FRAME_SCALE: 'not-a-number' })).toBe(1)
  })

  it('throttles painting without dropping acknowledgements', () => {
    expect(shouldPaintChromeFrame(0, CHROME_FRAME_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(shouldPaintChromeFrame(0, CHROME_FRAME_MIN_INTERVAL_MS)).toBe(true)
    expect(shouldPaintChromeFrame(1_000, 1_000)).toBe(false)
  })
})

describe('chrome event planning', () => {
  it('takes the address from the main frame only', () => {
    expect(planChromeEvent('Page.frameNavigated', { frame: { url: 'https://example.com', id: 'A' } })).toEqual({ kind: 'navigated', url: 'https://example.com' })
    expect(planChromeEvent('Page.frameNavigated', { frame: { url: 'https://ads.test/frame', id: 'B', parentId: 'A' } })).toEqual({ kind: 'ignore' })
    expect(planChromeEvent('Page.frameNavigated', {})).toEqual({ kind: 'ignore' })
  })

  it('reports load completion, dialogs and a detached session', () => {
    expect(planChromeEvent('Page.loadEventFired', {})).toEqual({ kind: 'loaded' })
    expect(planChromeEvent('Page.frameStoppedLoading', {})).toEqual({ kind: 'loaded' })
    expect(planChromeEvent('Page.javascriptDialogOpening', {})).toEqual({ kind: 'dialog' })
    expect(planChromeEvent('Inspector.detached', {})).toEqual({ kind: 'detached' })
    expect(planChromeEvent('Target.detachedFromTarget', {})).toEqual({ kind: 'detached' })
    expect(planChromeEvent('Runtime.consoleAPICalled', {})).toEqual({ kind: 'ignore' })
  })

  it('adopts the window a page asked for and refuses a blank one', () => {
    expect(planChromeWindowOpen({ url: 'https://example.com/login' })).toBe('https://example.com/login')
    expect(planChromeWindowOpen({ url: '  https://example.com/x  ' })).toBe('https://example.com/x')
    expect(planChromeEvent('Page.windowOpen', { url: 'https://example.com/pop' })).toEqual({ kind: 'windowOpen', url: 'https://example.com/pop' })
    expect(planChromeWindowOpen({ url: 'about:blank' })).toBeUndefined()
    expect(planChromeWindowOpen({ url: '' })).toBeUndefined()
    expect(planChromeWindowOpen({})).toBeUndefined()
  })

  it('closes only the popup windows opened by a page Heddlework manages', () => {
    // Both page-1 and page-2 are targets Heddlework already manages, so neither is closed as an orphan.
    const owned = new Set(['page-1', 'page-2'])
    expect(planOrphanPopupTargets([
      { type: 'page', targetId: 'popup-1', openerId: 'page-1' },
      { type: 'page', targetId: 'page-2', openerId: 'page-1' },
      { type: 'page', targetId: 'popup-2', openerId: 'someone-else' },
      { type: 'page', targetId: 'popup-3' },
      { type: 'service_worker', targetId: 'sw-1', openerId: 'page-1' },
    ], owned)).toEqual(['popup-1'])
    expect(planOrphanPopupTargets([], owned)).toEqual([])
  })

  it('moves one history entry and refuses to move past either end', () => {
    const history = { currentIndex: 1, entries: [{ id: 10 }, { id: 20 }, { id: 30 }] }
    expect(historyTarget(history, -1)).toBe(10)
    expect(historyTarget(history, 1)).toBe(30)
    expect(historyTarget({ currentIndex: 0, entries: history.entries }, -1)).toBeUndefined()
    expect(historyTarget({ currentIndex: 2, entries: history.entries }, 1)).toBeUndefined()
    expect(historyTarget({ entries: history.entries }, 1)).toBeUndefined()
    expect(historyTarget({ currentIndex: 0, entries: 'nope' }, 1)).toBeUndefined()
  })

  it('maps pasted text to one insert call and empty text to nothing', () => {
    // The page cannot paste for itself here: Chrome's headless clipboard is not the desktop one, so the
    // host reads the desktop clipboard and this maps its text onto the insertion the page receives.
    expect(planChromePaste('pasted')).toEqual({ method: 'Input.insertText', params: { text: 'pasted' } })
    expect(planChromePaste('line one\nline two')).toEqual({ method: 'Input.insertText', params: { text: 'line one\nline two' } })
    expect(planChromePaste('')).toBeUndefined()
  })
})
