import type { FlowTaskStatus } from '../flows/projection.ts'
import { colors } from './theme.ts'

export type FlowRailShape = 'circle' | 'triangle' | 'diamond' | 'square'

export function FlowRail({
  status,
  before,
  after,
  lane = 0,
  branchFrom,
  label,
  detail,
  shape = 'circle',
  compact = false,
}: {
  status: FlowTaskStatus
  before: boolean
  after: boolean
  lane?: number | undefined
  branchFrom?: number | undefined
  label?: string | undefined
  detail?: string | undefined
  shape?: FlowRailShape | undefined
  compact?: boolean | undefined
}) {
  const x = 8 + lane * 14
  const center = 23
  const tone = statusTone(status)
  const branchX = branchFrom === undefined ? undefined : 8 + branchFrom * 14
  const width = compact || !label ? 24 + lane * 14 : 152
  return (
    <div testId="flow-rail" style={{ position: 'relative', width, height: 46, flexShrink: 0, pointerEvents: 'none' }}>
      {before && <div testId="flow-rail-before" style={{ position: 'absolute', left: x, top: 0, width: 1, height: center - 6, backgroundColor: colors.borderStrong }} />}
      {after && <div testId="flow-rail-after" style={{ position: 'absolute', left: x, top: center + 6, bottom: 0, width: 1, backgroundColor: colors.borderStrong }} />}
      {branchX !== undefined && branchX !== x && (
        <>
          <div testId="flow-rail-link" style={{ position: 'absolute', left: Math.min(branchX, x), top: center, width: Math.abs(x - branchX), height: 1, backgroundColor: colors.borderStrong }} />
          <div style={{ position: 'absolute', left: branchX, top: 0, width: 1, height: center, backgroundColor: colors.borderStrong }} />
        </>
      )}
      <div testId="flow-rail-node" style={{ position: 'absolute', left: x - 7, top: center - 8, width: 15, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text testId={`flow-rail-glyph-${status}`} style={{ color: tone, fontSize: status === 'running' ? 15 : status === 'failed' ? 10 : 13, fontWeight: 700 }}>{railGlyph(shape, status)}</text>
      </div>
      {!compact && label && (
        <div style={{ position: 'absolute', left: 27 + lane * 14, right: 0, ...(detail ? { top: 8 } : { top: 0, bottom: 0 }), display: 'flex', flexDirection: 'column', justifyContent: detail ? 'flex-start' : 'center', gap: detail ? 1 : 0, minWidth: 0 }}>
          <text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</text>
          {detail && <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{detail}</text>}
        </div>
      )}
    </div>
  )
}

export function statusTone(status: FlowTaskStatus): string {
  if (status === 'failed') return colors.error
  if (status === 'succeeded') return colors.success
  if (status === 'running') return colors.info
  if (status === 'paused') return colors.warning
  if (status === 'starting') return colors.primary
  return colors.textFaint
}

function railGlyph(shape: FlowRailShape, status: FlowTaskStatus): string {
  if (status === 'running' || status === 'starting') return '◔'
  if (status === 'succeeded') return '⊙'
  if (status === 'failed') return '⊗'
  if (shape === 'triangle') return '△'
  if (shape === 'diamond') return '◇'
  if (shape === 'square') return '□'
  return '○'
}
