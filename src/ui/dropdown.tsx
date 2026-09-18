import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { MotionDiv } from './motion.ts'
import { colors } from './theme.ts'

export const DROPDOWN_MOTION_MS = 160

export function useDropdownPresence(open: boolean): boolean {
  const [retained, setRetained] = useState(open)
  useEffect(() => {
    if (open) {
      setRetained(true)
      return
    }
    const timer = setTimeout(() => setRetained(false), DROPDOWN_MOTION_MS)
    return () => clearTimeout(timer)
  }, [open])
  return open || retained
}

export function useDropdownState(onOpenChange?: ((open: boolean) => void) | undefined) {
  const [open, setOpenState] = useState(false)
  const mounted = useDropdownPresence(open)
  const setOpen = useCallback((nextOpen: boolean) => {
    setOpenState(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange])
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])
  useEffect(() => () => onOpenChange?.(false), [onOpenChange])
  return { open, mounted, setOpen, toggle }
}

type DropdownSurfaceProps = Omit<ComponentProps<typeof MotionDiv>, 'initial' | 'animate' | 'transition'> & {
  open: boolean
}

export function DropdownSurface({ open, style, ...props }: DropdownSurfaceProps) {
  return (
    <MotionDiv
      {...props}
      initial={{ opacity: 0, top: 4 }}
      animate={{ opacity: open ? 1 : 0, top: open ? 0 : 4 }}
      transition={{ duration: DROPDOWN_MOTION_MS / 1_000, ease: 'easeOut' }}
      style={{
        position: 'relative',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.popover,
        overflow: 'hidden',
        ...style,
        pointerEvents: open ? 'auto' : 'none',
      }}
    />
  )
}
