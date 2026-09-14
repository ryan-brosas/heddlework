import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'

export function TranscriptInlineAction({ icon, testId, onClick }: { icon: IconName; testId: string; onClick(): void }) {
  return (
    <div testId={testId} tabIndex={0} style={{ width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: colors.transparent, cursor: 'pointer', pointerEvents: 'auto', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name={icon} size={13} color={colors.textFaint} />
    </div>
  )
}
