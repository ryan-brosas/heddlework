import React, { useCallback, useEffect, useState } from 'react'
import { useWindowMetrics } from './window-metrics.tsx'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { WorkbenchSurfaceProps } from './extensions.ts'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { TerminalToolbar } from './terminal-chrome.tsx'
import { TerminalView } from './terminal-view.tsx'
import { colors } from './theme.ts'
import { useTerminalProjectionSuspended, useTerminalServiceSnapshot } from './terminal-context.tsx'

export function TerminalPanel({
  service,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  panelWidth,
  appearance = 'dark',
  onToggleFullscreen,
  onNewSurface,
  onClose,
}: WorkbenchSurfaceProps & { service: TerminalSessionService }) {
  const projectionSuspended = useTerminalProjectionSuspended()
  const snapshot = useTerminalServiceSnapshot(service, projectionSuspended)
  const windowSize = useWindowMetrics().size
  const activeId = snapshot.activeRightId ?? snapshot.sessions[0]?.id
  const [focusSerial, setFocusSerial] = useState(1)
  const grabFocus = useCallback((id = activeId) => {
    if (id) service.claimSize(id, 'right')
    setFocusSerial((value) => value + 1)
  }, [activeId, service])

  useEffect(() => {
    void service.ensureSession('right')
  }, [service])

  const onNew = useCallback(() => {
    void service.spawn().then((id) => {
      service.select('right', id)
      grabFocus(id)
    })
  }, [grabFocus, service])

  const bodyHeight = Math.max(1, windowSize.height - 52 - 36)
  const bodyWidth = Math.max(1, fullscreen ? windowSize.width : panelWidth)

  return (
    <div testId="terminal-panel" style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader
        icon="terminal"
        title="Terminal"
        fullscreen={fullscreen}
        fullscreenProgress={fullscreenProgress}
        fullscreenLocked={fullscreenLocked}
        onNew={onNewSurface}
        onToggleFullscreen={() => { grabFocus(); onToggleFullscreen() }}
        onClose={onClose}
      />
      <div style={{ height: 36, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderBottomWidth: 1, borderColor: colors.border }}>
        <TerminalToolbar
          service={service}
          sessions={snapshot.sessions}
          activeId={activeId}
          onSelect={(id) => {
            service.select('right', id)
            grabFocus(id)
          }}
          onNew={onNew}
        />
      </div>
      <div testId="terminal-panel-body" style={{ flexGrow: 1, minHeight: 0 }}>
        <TerminalView
          service={service}
          sessionId={activeId}
          placement="right"
          width={bodyWidth}
          height={bodyHeight}
          appearance={appearance}
          focusSerial={focusSerial}
        />
      </div>
    </div>
  )
}
