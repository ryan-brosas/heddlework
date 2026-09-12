import React from 'react'
import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'

export { ChipSelect, matchSelectOptions, type SelectOption } from './select.tsx'

export interface ButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger' | 'quiet'
  testId?: string
  compact?: boolean
  icon?: IconName
}

export function Button({ label, onClick, disabled = false, tone = 'default', testId, compact = false, icon }: ButtonProps) {
  const palette = tone === 'primary'
    ? { background: colors.primary, foreground: '#FFFFFF', border: colors.primary }
    : tone === 'danger'
      ? { background: '#3A1B22', foreground: colors.error, border: '#52262E' }
      : tone === 'quiet'
        ? { background: colors.transparent, foreground: colors.textMuted, border: colors.transparent }
        : { background: colors.raised, foreground: colors.text, border: colors.borderStrong }
  const handlers = disabled || !onClick ? {} : {
    onClick,
    onKeyDown: (event: { key?: string }) => {
      if (event.key === 'enter' || event.key === 'space') onClick()
    },
  }
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={disabled ? -1 : 0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: compact ? 28 : 32,
        paddingLeft: compact ? 9 : 12,
        paddingRight: compact ? 9 : 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: disabled ? 0.35 : 1,
        userSelect: 'none',
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: tone === 'primary' ? colors.primaryHover : colors.hover } }),
      }}
      {...handlers}
    >
      {icon && <Icon name={icon} size={compact ? 13 : 14} color={palette.foreground} />}
      <text style={{ color: palette.foreground, fontSize: compact ? 11 : 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</text>
    </div>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  testId,
  tabIndex,
}: {
  icon: IconName
  label: string
  onClick?(): void
  active?: boolean
  disabled?: boolean
  testId?: string
  tabIndex?: number
}) {
  const resolvedTabIndex = disabled ? -1 : tabIndex ?? 0
  const handlers = disabled || !onClick ? {} : {
    onClick,
    onKeyDown: (event: { key?: string }) => {
      if (event.key === 'enter' || event.key === 'space') onClick()
    },
  }
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={resolvedTabIndex}
      style={{
        width: 30,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        backgroundColor: active ? colors.sidebarActive : colors.background,
        opacity: disabled ? 0.35 : 1,
        userSelect: 'none',
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: colors.hover } }),
      }}
      {...handlers}
    >
      <Icon name={icon} size={16} color={active ? colors.text : colors.textMuted} />
    </div>
  )
}

export { NativeVirtualList, useNativeVirtualWindow, type NativeElementHandle, type NativeScrollEvent, type NativeVisibleRangeEvent, type NativeVirtualWindow } from './virtual-list.tsx'

export function Label({ children }: { children: string }) {
  return <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 650 }}>{children.toUpperCase()}</text>
}
