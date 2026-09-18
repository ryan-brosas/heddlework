/**
 * The Browser surface for the managed-Chrome engine.
 *
 * Chrome renders the page; this surface shows the streamed frame and forwards gestures. It owns no tab
 * state and no page truth - every piece of state it displays comes back from Chrome through the backend,
 * which is the same contract the native surface follows. Input is decided by the pure planners so a
 * coordinate mapping or modifier bug is caught by a unit test rather than by a misdirected click.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { ChromeBrowserBackend, ChromeInputCall } from '../browser/chrome-backend.ts'
import { planChromeKey, planChromePaste, planChromePointer, planChromeWheel, type ChromeBounds, type ChromeModifiers } from '../browser/chrome-plan.ts'
import { readClipboardText } from './clipboard-media.ts'
import { createPasteAction } from './paste-feedback.ts'
import { colors } from './theme.ts'

/** How often the surfaced page re-measures its rectangle. Only a resize needs this. */
export const CHROME_SURFACE_SIZE_POLL_MS = 120

interface ChromeSurfaceRenderer {
  getElementBounds?(id: number): readonly number[] | undefined
}

interface ChromeSurfaceEvent {
  key?: string | undefined
  keyChar?: string | undefined
  x?: number | undefined
  y?: number | undefined
  button?: number | undefined
  clickCount?: number | undefined
  pressedButton?: number | undefined
  deltaX?: number | undefined
  deltaY?: number | undefined
  modifiers?: ChromeModifiers | undefined
}

/** Paste failure text for this surface: it performs the paste itself, so a read that yielded nothing is reported. */
export const CHROME_PASTE_FAILED_MESSAGE = "Couldn't paste into the page: no clipboard text was available. Try copying text again."

export function ChromeBrowserSurface({ backend, tabId, generation, visible, readPaste = readClipboardText }: {
  backend: ChromeBrowserBackend
  tabId: string
  generation: number
  visible: boolean
  /**
   * Desktop clipboard reader used by the paste gesture. Injectable like the terminal's, so the
   * failure path is covered without a compositor or an OS clipboard.
   */
  readPaste?: () => Promise<string | undefined>
}) {
  const renderer = useGpuixRequired() as ChromeSurfaceRenderer
  const elementId = useRef<number | undefined>(undefined)
  const bounds = useRef<ChromeBounds | undefined>(undefined)
  const [frame, setFrame] = useState<string | undefined>(undefined)
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined)
  // Paste failure feedback: this surface performs the paste itself, and a clipboard that yielded no
  // text would otherwise be indistinguishable from a key that did nothing.
  const [pasteFailure, setPasteFailure] = useState<string | undefined>(undefined)
  const pasteAction = useMemo(
    () => createPasteAction({ read: readPaste, onFailure: setPasteFailure, message: CHROME_PASTE_FAILED_MESSAGE }),
    [readPaste],
  )
  useEffect(() => {
    setPasteFailure(undefined)
    return () => pasteAction.dispose()
  }, [pasteAction])
  const setNodeRef = useCallback((instance: { id: number } | null) => { elementId.current = instance?.id }, [])

  useEffect(() => {
    // A frame from the previous page must not show under the new one while Chrome loads it.
    setFrame(undefined)
    return backend.subscribeFrames(tabId, generation, setFrame)
  }, [backend, tabId, generation])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const id = elementId.current
      const raw = id === undefined ? undefined : renderer.getElementBounds?.(id)
      if (raw && raw.length >= 4) {
        const next: ChromeBounds = { x: raw[0] ?? 0, y: raw[1] ?? 0, width: Math.max(1, raw[2] ?? 1), height: Math.max(1, raw[3] ?? 1) }
        bounds.current = next
        setSize((previous) => (previous && Math.abs(previous.width - next.width) < 1 && Math.abs(previous.height - next.height) < 1 ? previous : { width: next.width, height: next.height }))
        void backend.setViewport(tabId, next.width, next.height)
      }
      timer = setTimeout(update, CHROME_SURFACE_SIZE_POLL_MS)
    }
    update()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [backend, renderer, tabId])

  const send = useCallback((calls: ChromeInputCall[]) => { void backend.input(tabId, calls) }, [backend, tabId])

  const pointer = useCallback((type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', event: ChromeSurfaceEvent) => {
    const current = bounds.current
    if (!current) return
    const params = planChromePointer({ x: event.x, y: event.y, button: event.button, clickCount: event.clickCount, pressedButton: event.pressedButton, ...(event.modifiers ?? {}) }, current, type)
    if (params) send([{ method: 'Input.dispatchMouseEvent', params }])
  }, [send])

  const onScroll = useCallback((event: ChromeSurfaceEvent) => {
    const current = bounds.current
    if (!current) return
    const params = planChromeWheel({ x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, ...(event.modifiers ?? {}) }, current)
    if (params) send([{ method: 'Input.dispatchMouseEvent', params }])
  }, [send])

  const onKeyDown = useCallback((event: ChromeSurfaceEvent) => {
    const plan = planChromeKey({ key: event.key, keyChar: event.keyChar, ...(event.modifiers ?? {}) })
    switch (plan.kind) {
      case 'text':
        send([{ method: 'Input.insertText', params: { text: plan.text } }])
        break
      case 'press':
        send([{ method: plan.params.method as string, params: (plan.params.params ?? {}) as Record<string, unknown> }])
        break
      case 'paste':
        // Chrome's headless clipboard is not the desktop clipboard, so the paste gesture reads the
        // desktop clipboard through the shared reader; a read that yielded nothing is reported rather
        // than looking like a dead key, and the insertion is planned like every other gesture.
        void pasteAction.paste().then((text) => {
          const call = text === undefined ? undefined : planChromePaste(text)
          if (call) send([call])
        })
        break
      case 'ignore':
        break
    }
  }, [pasteAction, send])

  return (
    <div
      ref={setNodeRef}
      testId="chrome-browser-surface"
      tabIndex={0}
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden', backgroundColor: colors.card }}
      onMouseDown={(event: ChromeSurfaceEvent) => pointer('mousePressed', event)}
      onMouseUp={(event: ChromeSurfaceEvent) => pointer('mouseReleased', event)}
      onMouseMove={(event: ChromeSurfaceEvent) => pointer('mouseMoved', event)}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {frame && visible && size ? (
        <img
          testId="chrome-browser-frame"
          src={`data:image/jpeg;base64,${frame}`}
          objectFit="fill"
          style={{ width: size.width, height: size.height }}
        />
      ) : (
        <div testId="chrome-browser-waiting" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
          <text style={{ color: colors.textMuted, fontSize: 11, fontWeight: 600 }}>Starting Chrome…</text>
          <text style={{ maxWidth: 300, color: colors.textFaint, fontSize: 9, lineHeight: 14, textAlign: 'center' }}>The page appears here once Chrome has drawn its first frame.</text>
        </div>
      )}
      {pasteFailure ? (
        <text
          testId="chrome-browser-paste-failure"
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            color: colors.diffDel,
            fontSize: 10,
            pointerEvents: 'none',
          }}
        >
          {pasteFailure}
        </text>
      ) : null}
    </div>
  )
}
