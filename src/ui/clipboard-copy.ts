/**
 * Shared copy control for explicit UI copy buttons.
 *
 * Owns the transient success state and the failure feedback so every copy button in the
 * workbench behaves the same way: a failed clipboard write is visible, a newer attempt
 * wins over an older one still in flight, and nothing is published before the writer's
 * outcome is known.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { copyTextToClipboard } from './clipboard-media.ts'
import { createCopyAction, type ClipboardWriter } from './copy-feedback.ts'

export const COPIED_STATE_MS = 900

export interface ClipboardCopyControl {
  /** True briefly after a confirmed clipboard write, for a check-mark affordance. */
  readonly copied: boolean
  /** Generic failure text while the latest attempt failed; undefined on success. */
  readonly failure: string | undefined
  /** Start a copy; the outcome is reported through `copied`/`failure`. */
  readonly copy: (text: string) => void
}

export function useClipboardCopy(writer: ClipboardWriter = copyTextToClipboard): ClipboardCopyControl {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const resetTimer = useMemo(() => ({ current: undefined as ReturnType<typeof setTimeout> | undefined }), [])
  const action = useMemo(() => createCopyAction({ writer, onFailure: setFailure }), [writer])

  useEffect(() => () => action.dispose(), [action])
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [resetTimer])

  const copy = useCallback((text: string) => {
    void action.copy(text).then((written) => {
      if (!written) {
        setCopied(false)
        return
      }
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => {
        resetTimer.current = undefined
        setCopied(false)
      }, COPIED_STATE_MS)
    })
  }, [action, resetTimer])

  return { copied, failure, copy }
}
