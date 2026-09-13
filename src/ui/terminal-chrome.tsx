import type { TerminalSessionId, TerminalSessionInfo } from '../terminal/types.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { Icon } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { colors } from './theme.ts'

export function TerminalSessionTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
}: {
  sessions: readonly TerminalSessionInfo[]
  activeId: TerminalSessionId | undefined
  onSelect(id: TerminalSessionId): void
  onClose(id: TerminalSessionId): void
}) {
  return (
    <div testId="terminal-tabs" style={{ minWidth: 0, flexGrow: 1, height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
      {sessions.map((session) => {
        const active = session.id === activeId
        const label = session.title || session.name
        return (
          <div
            key={session.id}
            testId={'terminal-tab-' + session.id}
            tabIndex={-1}
            style={{
              height: 26,
              maxWidth: 160,
              minWidth: 72,
              flexShrink: 1,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingLeft: 8,
              paddingRight: 4,
              borderRadius: 7,
              backgroundColor: active ? colors.raised : colors.transparent,
              cursor: 'pointer',
              hover: { backgroundColor: active ? colors.raised : colors.hover },
            }}
            onClick={() => onSelect(session.id)}
            onKeyDown={(event) => { if (event.key === 'enter') onSelect(session.id) }}
          >
            <Icon name="terminal" size={11} color={session.status.kind === 'running' ? colors.success : colors.textFaint} />
            <text style={{ minWidth: 0, flexGrow: 1, color: colors.text, fontSize: 10, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</text>
            <div
              testId={'terminal-tab-close-' + session.id}
              tabIndex={-1}
              style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
              onClick={() => onClose(session.id)}
            >
              <Icon name="x" size={10} color={colors.textFaint} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function TerminalToolbar({
  service,
  sessions,
  activeId,
  onSelect,
  onNew,
}: {
  service: TerminalSessionService
  sessions: readonly TerminalSessionInfo[]
  activeId: TerminalSessionId | undefined
  onSelect(id: TerminalSessionId): void
  onNew(): void
}) {
  return (
    <div testId="terminal-toolbar" style={{ height: 30, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <TerminalSessionTabs
        sessions={sessions}
        activeId={activeId}
        onSelect={onSelect}
        onClose={(id) => { void service.close(id) }}
      />
      <IconButton icon="plus" label="New terminal" testId="terminal-new" tabIndex={-1} onClick={onNew} />
    </div>
  )
}
