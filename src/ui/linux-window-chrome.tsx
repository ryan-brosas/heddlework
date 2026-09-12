import React, { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './icons.tsx'
import { MotionDiv } from './motion.ts'
import { colors } from './theme.ts'
import { LINUX_TITLEBAR_HEIGHT, readWindowState, sameWindowState, usesClientWindowChrome, windowControlActions, type NativeWindowState, type WindowControlRenderer } from './window-controls.ts'

/** Idle titlebar poll. Each read is a blocking Linux/Windows UI-thread round trip. */
export const LINUX_CHROME_IDLE_POLL_MS = 300
/** Streaming backs the poll off; window controls refresh on pointer down instead. */
export const LINUX_CHROME_STREAMING_POLL_MS = 1_500

export function useNativeWindowChrome(renderer: WindowControlRenderer, intervalMs = LINUX_CHROME_IDLE_POLL_MS) {
  const nativeLinux = typeof document === 'undefined' && typeof process !== 'undefined' && process.platform === 'linux'
  const [state, setState] = useState<NativeWindowState | undefined>(() => nativeLinux ? readWindowState(renderer) : undefined)
  const updateRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!nativeLinux || !renderer.getWindowState) return
    const update = () => {
      const next = readWindowState(renderer)
      if (next) setState((previous) => sameWindowState(previous, next) ? previous : next)
    }
    updateRef.current = update
    update()
    // Synchronous UI-thread query: every tick blocks the JS thread until the UI
    // thread answers, which costs tens of milliseconds while the window is
    // painting (measured ~27% of JS self time during a stream at 200-300ms).
    const timer = setInterval(update, intervalMs)
    return () => clearInterval(timer)
  }, [nativeLinux, intervalMs, renderer])
  const visible = usesClientWindowChrome(nativeLinux ? 'linux' : undefined, !nativeLinux, state)
  return { state, height: visible ? LINUX_TITLEBAR_HEIGHT : 0, refresh: () => updateRef.current() }
}

export function LinuxWindowChrome({ renderer, state, title, onQuit, onRefresh, reducedMotion = false }: {
  renderer: WindowControlRenderer
  state: NativeWindowState
  title: string
  onQuit?: (() => void) | undefined
  onRefresh?: (() => void) | undefined
  reducedMotion?: boolean
}) {
  const actions = windowControlActions(renderer, state, onQuit)
  return (
    <div testId="linux-window-chrome" onMouseDown={() => onRefresh?.()} style={{ height: LINUX_TITLEBAR_HEIGHT, width: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', backgroundColor: colors.sidebar, borderBottomWidth: 1, borderColor: colors.border, flexShrink: 0 }}>
      {React.createElement('div', {
        testId: 'linux-window-drag-region', windowDragRegion: true,
        style: { height: '100%', minWidth: 0, flexGrow: 1, display: 'flex', alignItems: 'center', userSelect: 'none' },
      } as never, <text style={{ marginLeft: 12, minWidth: 0, fontSize: 11, color: colors.textMuted, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{title}</text>)}
      <WindowControl icon="windowMinimize" label="Minimize window" testId="window-minimize" action={actions.minimize} reducedMotion={reducedMotion} />
      <WindowControl icon={state.maximized || state.fullscreen ? 'windowRestore' : 'windowMaximize'} label={state.maximized || state.fullscreen ? 'Restore window' : 'Maximize window'} testId="window-maximize" action={actions.maximize} reducedMotion={reducedMotion} />
      <WindowControl icon="x" label="Close window" testId="window-close" action={actions.close} danger reducedMotion={reducedMotion} />
    </div>
  )
}

const RESIZE_EDGES = [
  ['top', { top: 0, left: 10, right: 130, height: 4, cursor: 'ns-resize' }],
  ['bottom', { bottom: 0, left: 10, right: 10, height: 4, cursor: 'ns-resize' }],
  ['left', { top: 10, bottom: 10, left: 0, width: 4, cursor: 'ew-resize' }],
  ['right', { top: LINUX_TITLEBAR_HEIGHT, bottom: 10, right: 0, width: 4, cursor: 'ew-resize' }],
  ['topLeft', { top: 0, left: 0, width: 10, height: 10, cursor: 'nwse-resize' }],
  ['topRight', { top: 0, right: 120, width: 10, height: 10, cursor: 'nesw-resize' }],
  ['bottomLeft', { bottom: 0, left: 0, width: 10, height: 10, cursor: 'nesw-resize' }],
  ['bottomRight', { bottom: 0, right: 0, width: 10, height: 10, cursor: 'nwse-resize' }],
] as const

export function LinuxResizeHandles({ state }: { state: NativeWindowState }) {
  if (state.decorations !== 'client' || !state.resizable || state.maximized || state.fullscreen) return null
  return <>{RESIZE_EDGES.map(([edge, style]) => React.createElement('div', {
    key: edge, testId: `window-resize-${edge}`, windowResizeEdge: edge,
    style: { position: 'absolute', ...style },
  } as never))}</>
}

function WindowControl({ icon, label, testId, action, danger = false, reducedMotion }: {
  icon: IconName; label: string; testId: string; action: (() => void) | undefined; danger?: boolean; reducedMotion: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [focused, setFocused] = useState(false)
  const engaged = Boolean(action) && (hovered || focused)
  const backgroundColor = engaged ? danger ? colors.error : colors.hover : colors.sidebar
  return (
    <MotionDiv
      testId={testId}
      {...{ role: action ? 'button' : 'none', 'aria-label': label }}
      tabIndex={action ? 0 : -1}
      initial={false}
      animate={{ opacity: !action ? 0.35 : pressed ? 0.65 : 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.1, ease: 'easeOut' }}
      style={{ width: 40, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor, userSelect: 'none', cursor: action ? 'pointer' : 'default' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false) }}
      onMouseDown={() => { if (action) setPressed(true) }}
      onMouseUp={() => setPressed(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setPressed(false) }}
      onClick={() => action?.()}
      onKeyDown={(event) => { if (!event.isHeld && (event.key === 'enter' || event.key === 'space')) action?.() }}
    >
      <div style={{ pointerEvents: 'none' }}><Icon name={icon} size={13} color={danger && engaged ? '#FFFFFF' : colors.textMuted} /></div>
    </MotionDiv>
  )
}
