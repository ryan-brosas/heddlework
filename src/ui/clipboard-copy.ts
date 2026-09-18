/**
 * Shared copy control for explicit UI copy buttons.
 *
 * Owns the transient success state so every copy button behaves the same way. The ordering rule
 * (a newer attempt wins; an older or disposed one publishes nothing) lives in `copy-feedback.ts`,
 * and this hook only maps the reported outcome onto render state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { copyTextToClipboard } from './clipboard-media.ts'
import { createCopyAction, type ClipboardWriter } from './copy-feedback.ts'

export const COPIED_STATE_MS = 900

export interface ClipboardCopyControl {
  /** True briefly after a confirmed clipboard write, for a copy-check affordance. */
  readonly copied: boolean
  /** Generic failure text while the latest attempt failed; undefined on success. */
  readonly failure: string | undefined
  /** Start a copy; the outcome is reported through copied/failure. */
  readonly copy: (text: string) => void
}

export function useClipboardCopy(writer: ClipboardWriter = copyTextToClipboard): ClipboardCopyControl {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const resetTimer = useMemo(() => ({ current: undefined as ReturnType<typeof setTimeout> | undefined }), [])
  const action = useMemo(() => createCopyAction({ writer, onFailure: setFailure }), [writer])

  useEffect(() => () => action.dispose(), [action])
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [resetTimer])

  const copy = useCallback((text: string) => {
    void action.copy(text).then((outcome) => {
      // A stale attempt must not touch render state: a newer attempt already owns it, so
      // reacting here would clear the newer attempt's check mark.
      if (outcome === 'stale') return
      setCopied(outcome === 'copied')
      if (resetTimer.current) clearTimeout(resetTimer.current)
      if (outcome !== 'copied') return
      resetTimer.current = setTimeout(() => {
        resetTimer.current = undefined
        setCopied(false)
      }, COPIED_STATE_MS)
    })
  }, [action, resetTimer])

  return { copied, failure, copy }
}
