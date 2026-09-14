import { useMemo, useState } from 'react'
import type { ThreadPriority } from '../workbench/state.ts'
import { DropdownSurface, useDropdownState } from './dropdown.tsx'
import { Icon } from './icons.tsx'
import { colors } from './theme.ts'
import { NativeVirtualList, useNativeVirtualWindow } from './virtual-list.tsx'

const PRIORITIES: ReadonlyArray<{ value: ThreadPriority; label: string }> = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
]

// Fully transparent native layers are omitted from hit testing. One alpha remains visually invisible.
const PRIORITY_HIT_FILL = '#00000001'

export function flowPriorityLabel(priority: ThreadPriority): string {
  return PRIORITIES.find((option) => option.value === priority)?.label ?? 'No priority'
}

export function FlowPriorityPicker({ priority, overridden, counts, showLabel = false, monochrome = false, testId = 'flow-priority-trigger', onChange }: {
  priority: ThreadPriority
  overridden: boolean
  counts?: Readonly<Record<ThreadPriority, number>> | undefined
  showLabel?: boolean | undefined
  monochrome?: boolean | undefined
  testId?: string | undefined
  onChange(priority: ThreadPriority | undefined): void
}) {
  const dropdown = useDropdownState()
  const selected = overridden ? String(priority) : 'auto'
  const options = [
    { id: 'auto', label: `Automatic · ${flowPriorityLabel(priority)}`, priority },
    ...PRIORITIES.map((option) => ({ id: String(option.value), label: option.label, priority: option.value })),
  ]
  const choose = (id: string) => {
    onChange(id === 'auto' ? undefined : Number(id) as ThreadPriority)
    dropdown.setOpen(false)
  }
  return (
    <>
      <div testId={testId} tabIndex={0} style={{ ...(showLabel ? { minWidth: 108 } : { width: 30, minWidth: 30 }), position: 'relative', height: 30, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: showLabel ? 'flex-start' : 'center', gap: 6, paddingLeft: showLabel ? 6 : 0, paddingRight: showLabel ? 6 : 0, borderRadius: 6, backgroundColor: dropdown.open ? colors.hover : colors.transparent, cursor: 'pointer' }} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') dropdown.toggle() }}>
        <div testId={`${testId}-hit`} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: 6, backgroundColor: PRIORITY_HIT_FILL, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={dropdown.toggle} />
        <div style={{ width: 15, height: 15, display: 'flex', pointerEvents: 'none' }}><FlowPriorityIcon priority={priority} monochrome={monochrome} testId={`${testId}-icon`} /></div>
        {showLabel && <text style={{ minWidth: 0, flexGrow: 1, color: monochrome ? colors.textMuted : priorityTone(priority), fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{`${flowPriorityLabel(priority)}${overridden ? '' : ' · Auto'}`}</text>}
        {showLabel && <div style={{ width: 10, height: 10, pointerEvents: 'none' }}><Icon name="chevronDown" size={10} color={colors.textFaint} /></div>}
      </div>
      {dropdown.mounted && (
        <anchored side="bottom" align="start" gap={6} fit="snap" snapMargin={8} deferred priority={9} occlude>
          <div testId="flow-priority-positioner" style={{ display: 'flex', backgroundColor: showLabel ? colors.card : colors.background, pointerEvents: dropdown.open ? 'auto' : 'none' }}>
          <DropdownSurface testId="flow-priority-menu" open={dropdown.open} tabIndex={0} onMouseDownOutside={() => dropdown.setOpen(false)} style={{ width: 216, padding: 5, borderRadius: 9 }}>
            {options.map((option) => {
              const active = option.id === selected
              const count = option.id === 'auto' ? undefined : counts?.[option.priority] ?? 0
              return (
                <div key={option.id} testId={`flow-priority-option-${option.id}`} tabIndex={0} style={{ position: 'relative', height: 34, width: '100%', minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: active ? colors.hover : colors.popover, pointerEvents: 'auto', cursor: 'pointer' }}>
                  <div testId={`flow-priority-option-${option.id}-hit`} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: 6, backgroundColor: PRIORITY_HIT_FILL, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => choose(option.id)} />
                  <div testId={`flow-priority-option-${option.id}-icon`} style={{ width: 17, display: 'flex', justifyContent: 'center', color: colors.textMuted, pointerEvents: 'none' }}>{option.id === 'auto' ? <Icon name="sparkles" size={13} color={colors.textMuted} /> : <FlowPriorityIcon priority={option.priority} monochrome testId={`flow-priority-option-${option.id}-glyph`} />}</div>
                  <text style={{ minWidth: 0, flexGrow: 1, color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{option.label}</text>
                  <div testId="flow-priority-trailing" style={{ minWidth: 34, height: 14, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5, pointerEvents: 'none' }}>
                    {count !== undefined && <text style={{ color: colors.textFaint, fontSize: 8, textAlign: 'right' }}>{count}</text>}
                    {active && <div testId="flow-priority-check" style={{ width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={13} color={colors.text} /></div>}
                  </div>
                </div>
              )
            })}
          </DropdownSurface>
          </div>
        </anchored>
      )}
    </>
  )
}

export function FlowPriorityIcon({ priority, monochrome = false, testId = 'flow-priority-icon' }: { priority: ThreadPriority; monochrome?: boolean | undefined; testId?: string | undefined }) {
  const tone = monochrome ? colors.textMuted : priorityTone(priority)
  if (priority === 0) return <text testId={testId} style={{ width: 15, color: tone, fontSize: 8, fontWeight: 750, pointerEvents: 'none' }}>---</text>
  if (priority === 1) return <div testId={testId} style={{ width: 14, height: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, borderRadius: 4, backgroundColor: tone, pointerEvents: 'none' }}><div testId={`${testId}-urgent-stem`} style={{ width: 2, height: 6, borderRadius: 1, backgroundColor: colors.background, pointerEvents: 'none' }} /><div testId={`${testId}-urgent-dot`} style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: colors.background, pointerEvents: 'none' }} /></div>
  const activeBars = priority === 2 ? 3 : priority === 3 ? 2 : 1
  return (
    <div testId={testId} style={{ width: 15, height: 15, color: tone, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 2, paddingBottom: 1, pointerEvents: 'none' }}>
      {[5, 9, 13].map((height, index) => <div key={height} style={{ width: 3, height, borderRadius: 1, backgroundColor: index < activeBars ? tone : colors.borderStrong, pointerEvents: 'none' }} />)}
    </div>
  )
}

export function FlowLabelPills({ labels, max = 2 }: { labels: readonly string[]; max?: number | undefined }) {
  if (labels.length === 0) return null
  const shown = labels.slice(0, max)
  return (
    <div testId="flow-label-pills" style={{ minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, overflow: 'hidden' }}>
      {shown.map((label) => <FlowLabelPill key={label} label={label} />)}
      {labels.length > shown.length && <div style={{ height: 19, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}><text style={{ color: colors.textFaint, fontSize: 8 }}>{`+${labels.length - shown.length}`}</text></div>}
    </div>
  )
}

export function FlowLabelPicker({ selected, options, onChange }: { selected: readonly string[]; options: readonly string[]; onChange(labels: string[]): void }) {
  const dropdown = useDropdownState()
  const [query, setQuery] = useState('')
  const all = useMemo(() => [...new Set([...selected, ...options])].toSorted((left, right) => left.localeCompare(right)), [options, selected])
  const normalized = query.trim().toLowerCase()
  const visible = all.filter((label) => !normalized || label.toLowerCase().includes(normalized))
  const candidate = query.replace(/\s+/g, ' ').trim().slice(0, 40)
  const canCreate = Boolean(candidate) && !all.some((label) => label.toLowerCase() === candidate.toLowerCase())
  const virtualWindow = useNativeVirtualWindow(visible.length, `flow-labels:${normalized}:${visible.length}`)
  const visibleWindow = visible.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  const toggle = (label: string) => {
    onChange(selected.includes(label) ? selected.filter((value) => value !== label) : [...selected, label])
    setQuery('')
  }
  return (
    <div style={{ minWidth: 0, flexGrow: 1 }}>
      <div testId="flow-label-trigger" tabIndex={0} style={{ minHeight: 28, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 6, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: dropdown.open ? colors.hover : colors.background, cursor: 'pointer' }} onClick={dropdown.toggle}>
        <div style={{ minWidth: 0, flexGrow: 1 }}>{selected.length > 0 ? <FlowLabelPills labels={selected} max={2} /> : <text style={{ color: colors.textFaint, fontSize: 9 }}>Add labels…</text>}</div>
        <Icon name="chevronDown" size={10} color={colors.textFaint} />
      </div>
      {dropdown.mounted && (
        <anchored side="bottom" align="end" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
          <div testId="flow-label-positioner" style={{ display: 'flex', backgroundColor: colors.card, pointerEvents: dropdown.open ? 'auto' : 'none' }}>
          <DropdownSurface testId="flow-label-menu" open={dropdown.open} tabIndex={0} onMouseDownOutside={() => dropdown.setOpen(false)} style={{ width: 250, maxHeight: 310, minHeight: 0, gap: 5, padding: 5, borderRadius: 9 }}>
            <div style={{ height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
              <Icon name="search" size={12} color={colors.textFaint} />
              <input testId="flow-label-search" value={query} placeholder="Search or create a label…" theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }} style={{ minWidth: 0, flexGrow: 1, height: 29, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10 }} onChange={(event) => setQuery(String(event.value ?? ''))} />
            </div>
            <NativeVirtualList testId="flow-label-list" alignment="top" estimatedItemHeight={34} overdraw={102} itemCount={Math.max(1, visible.length)} windowStart={virtualWindow.windowStart} onVisibleRange={virtualWindow.onVisibleRange} style={{ width: '100%', height: visible.length === 0 ? 38 : Math.min(canCreate ? 210 : 250, visible.length * 34), minHeight: 0 }}>
              {visible.length === 0
                ? <div key="empty" style={{ height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9 }}>{canCreate ? 'Create a new label below' : 'No labels match'}</text></div>
                : visibleWindow.map((label) => <LabelOption key={label} label={label} selected={selected.includes(label)} onClick={() => toggle(label)} />)}
            </NativeVirtualList>
            {canCreate && <div testId="flow-label-create" tabIndex={0} style={{ height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => toggle(candidate)}><Icon name="plus" size={12} color={colors.textMuted} /><text style={{ minWidth: 0, color: colors.textMuted, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{`Create “${candidate}”`}</text></div>}
          </DropdownSurface>
          </div>
        </anchored>
      )}
    </div>
  )
}

function LabelOption({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
  return <div testId="flow-label-option" tabIndex={0} style={{ height: 34, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 6, backgroundColor: selected ? colors.hover : colors.popover, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick}><FlowLabelPill label={label} /><div style={{ flexGrow: 1 }} /><div style={{ width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{selected && <Icon name="check" size={13} color={colors.text} />}</div></div>
}

function FlowLabelPill({ label }: { label: string }) {
  return <div style={{ height: 19, minWidth: 0, maxWidth: 116, flexShrink: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 6, paddingRight: 7, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}><div style={{ width: 6, height: 6, flexShrink: 0, borderRadius: 3, backgroundColor: labelTone(label) }} /><text style={{ minWidth: 0, color: colors.textMuted, fontSize: 8, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</text></div>
}

function priorityTone(priority: ThreadPriority): string {
  if (priority === 1) return colors.error
  if (priority === 2) return colors.warning
  if (priority === 3) return colors.info
  if (priority === 4) return colors.textMuted
  return colors.textFaint
}

function labelTone(label: string): string {
  let hash = 0
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return [colors.primary, colors.success, colors.warning, colors.error, colors.info][hash % 5]!
}
