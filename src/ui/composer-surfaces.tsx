import type { SlashCommand } from '../pi/types.ts'
import type { WorkbenchService } from '../workbench/controller.ts'
import type { AskUserQuestionnaire } from '../workbench/ask-user.ts'
import type { ExtensionWidget } from '../workbench/state.ts'
import { MotionDiv } from './motion.ts'
import { NativeVirtualList, useNativeVirtualWindow } from './primitives.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { colors, nativeTheme } from './theme.ts'
import { plainExtensionText } from './extension-ui.ts'

const EXTENSION_SURFACE_GAP = 6
const EXTENSION_SURFACE_BASE_RESERVE_HEIGHT = 35
const EXTENSION_WIDGET_EXTRA_LINE_RESERVE_HEIGHT = 18
const EXTENSION_SURFACE_STAGGER_SECONDS = 0.035
const QUESTIONNAIRE_WAITING_DOCK_HEIGHT = 44
const QUESTIONNAIRE_WAITING_DOCK_MARGIN = 9

export function questionnaireWaitingDockReserveHeight(visible: boolean): number {
  return visible ? QUESTIONNAIRE_WAITING_DOCK_HEIGHT + QUESTIONNAIRE_WAITING_DOCK_MARGIN : 0
}

export function extensionSurfaceRailReserveHeight(
  widgets: Readonly<Record<string, ExtensionWidget>>,
  statuses: Readonly<Record<string, string>>,
): number {
  const widgetEntries = Object.values(widgets)
  const hasStatus = Object.values(statuses).some((value) => plainExtensionText(value).trim().length > 0)
  if (widgetEntries.length === 0 && !hasStatus) return 0
  const maxWidgetLines = widgetEntries.reduce((maximum, widget) => Math.max(maximum, widget.lines.length), 1)
  return EXTENSION_SURFACE_BASE_RESERVE_HEIGHT + Math.max(0, maxWidgetLines - 1) * EXTENSION_WIDGET_EXTRA_LINE_RESERVE_HEIGHT
}

export function QuestionnaireWaitingDock({ questionnaire, controller }: { questionnaire: AskUserQuestionnaire; controller: WorkbenchService }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div testId="ask-user-collapsed" style={{ width: '100%', maxWidth: 768, minHeight: QUESTIONNAIRE_WAITING_DOCK_HEIGHT, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: QUESTIONNAIRE_WAITING_DOCK_MARGIN, paddingLeft: 11, paddingRight: 8, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, pointerEvents: 'auto' }}>
      <div style={{ width: 6, height: 6, flexShrink: 0, borderRadius: 3, backgroundColor: colors.warning }} />
      <text style={{ minWidth: 0, color: colors.text, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Agent waiting for your answers</text>
      {!mobile && <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap' }}>{`${questionnaire.questions.length} question${questionnaire.questions.length === 1 ? '' : 's'}`}</text>}
      <div style={{ flexGrow: 1 }} />
      <DockAction testId="ask-user-reopen" label="Open" tone="accent" onClick={() => controller.setAskUserQuestionnaireCollapsed(questionnaire.toolCallId, false)} />
      <DockAction label="Dismiss" onClick={() => controller.cancelAskUserQuestionnaire(questionnaire.toolCallId)} />
    </div>
  )
}

function DockAction({ label, testId, tone = 'muted', onClick }: { label: string; testId?: string; tone?: 'accent' | 'muted'; onClick(): void }) {
  return (
    <div {...(testId ? { testId } : {})} tabIndex={0} style={{ height: 28, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onClick() }}>
      <text style={{ color: tone === 'accent' ? colors.info : colors.textMuted, fontSize: 10, fontWeight: 600 }}>{label}</text>
    </div>
  )
}

export function CommandPalette({ commands, activeIndex, onChoose }: { commands: SlashCommand[]; activeIndex: number; onChoose(command: SlashCommand): void }) {
  const rowHeight = 38
  const identity = `${commands.length}:${commands[0]?.name ?? ''}:${commands.at(-1)?.name ?? ''}:${activeIndex}`
  const window = useNativeVirtualWindow(commands.length, identity, Math.max(0, activeIndex - 80))
  const visible = commands.slice(window.windowStart, window.windowEnd)
  return (
    <div testId="command-palette" style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, height: Math.min(300, Math.max(rowHeight, commands.length * rowHeight) + 12), minHeight: 0, marginBottom: EXTENSION_SURFACE_GAP, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'hidden', pointerEvents: 'auto' }}>
      <NativeVirtualList testId="command-palette-list" alignment="top" estimatedItemHeight={rowHeight} overdraw={rowHeight * 3} itemCount={Math.max(1, commands.length)} windowStart={window.windowStart} onVisibleRange={window.onVisibleRange} style={{ width: '100%', flexGrow: 1, minHeight: 0 }}>
        {visible.map((command, visibleIndex) => {
          const index = window.windowStart + visibleIndex
          return (
            <div key={`${command.source}-${command.name}`} testId={`command-option-${command.name}`} style={{ height: rowHeight, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 9, paddingRight: 9, borderRadius: 7, backgroundColor: index === activeIndex ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onMouseDown={() => onChoose(command)} onClick={() => onChoose(command)}>
              <text style={{ color: index === activeIndex ? colors.text : colors.textMuted, fontSize: 11, fontWeight: 650, fontFamily: nativeTheme.fontMono }}>{`/${command.name}`}</text>
              {command.argumentHint && <text style={{ color: colors.textMuted, fontSize: 9, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap' }}>{command.argumentHint}</text>}
              {command.description && <text style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{command.description}</text>}
              <text style={{ color: colors.textFaint, fontSize: 8 }}>{command.source.toUpperCase()}</text>
            </div>
          )
        })}
      </NativeVirtualList>
    </div>
  )
}

export function ExtensionSurfaceRail({ above, below, statuses }: { above: ExtensionWidget[]; below: ExtensionWidget[]; statuses: Record<string, string> }) {
  const statusEntries = Object.entries(statuses)
    .map(([key, value]) => [plainExtensionText(key), plainExtensionText(value)] as const)
    .filter(([, value]) => value.trim().length > 0)
  if (above.length + below.length + statusEntries.length === 0) return null

  return (
    <div testId="extension-surface-rail" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', width: '100%', maxWidth: 768, gap: 5, paddingBottom: EXTENSION_SURFACE_GAP, overflowX: 'scroll', overflowY: 'hidden', pointerEvents: 'auto' }}>
      {above.map((widget, index) => <ExtensionWidgetItem key={`above-${widget.key}`} widget={widget} placement="above" order={index} />)}
      {below.map((widget, index) => <ExtensionWidgetItem key={`below-${widget.key}`} widget={widget} placement="below" order={above.length + index} />)}
      {statusEntries.map(([key, value], index) => (
        <MotionDiv
          key={key}
          testId={`extension-status-${key}`}
          initial={{ opacity: 0, top: 4 }}
          animate={{ opacity: 1, top: 0 }}
          transition={{ duration: 0.16, delay: (above.length + below.length + index) * EXTENSION_SURFACE_STAGGER_SECONDS, ease: 'easeOut' }}
          style={{ position: 'relative', maxWidth: 360, minHeight: 29, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card }}
        >
          <text style={{ color: colors.info, fontSize: 8, fontWeight: 700, whiteSpace: 'nowrap' }}>{key}</text>
          <text style={{ minWidth: 0, color: colors.textMuted, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value}</text>
        </MotionDiv>
      ))}
    </div>
  )
}

function ExtensionWidgetItem({ widget, placement, order }: { widget: ExtensionWidget; placement: 'above' | 'below'; order: number }) {
  return (
    <MotionDiv
      testId={`extension-widget-${placement}-${widget.key}`}
      initial={{ opacity: 0, top: 4 }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: 0.16, delay: order * EXTENSION_SURFACE_STAGGER_SECONDS, ease: 'easeOut' }}
      style={{ position: 'relative', minWidth: 180, maxWidth: 420, minHeight: 29, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, paddingTop: 6, paddingRight: 9, paddingBottom: 6, paddingLeft: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card }}
    >
      {widget.lines.map((line, index) => <WidgetLine key={`${widget.key}-${index}`} line={line} />)}
    </MotionDiv>
  )
}

function WidgetLine({ line }: { line: string }) {
  return <text style={{ minWidth: 0, width: '100%', color: colors.textMuted, fontSize: 10, lineHeight: 15, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{plainExtensionText(line)}</text>
}
