import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLatestAttempt } from './attempt-feedback.ts'
import { openExternal } from './open-external.ts'

export const LINK_FAILED_MESSAGE = 'Could not open this link in your system browser'

export interface ExternalLaunch {
  /** Latest failure for an inline surface; undefined when `notify` owns the message.
   */
  readonly failure: string | undefined
  readonly launch: (value: string) => void
}

/**
 * Latest-attempt feedback for a surface that opens something outside Heddlework.
 *
 * One tracker per surface rather than per call: two quick clicks have to resolve through one rule,
 * or a slow failure from the first reports after the second already succeeded. A refused launch and
 * a rejected one are the same failure, and `notify` routes the message to the notice stream for a
 * control that has no inline place to show it.
 */
export function useExternalLaunch(options: {
  run: (value: string) => Promise<boolean>
  message: string
  notify?: ((message: string) => void) | undefined
}): ExternalLaunch {
  const { run, message, notify } = options
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // Held in a ref so a caller's inline `notify` closure cannot recreate the tracker every render,
  // which would put the ordering back at one tracker per call.
  const notifyRef = useRef(notify)
  useEffect(() => { notifyRef.current = notify }, [notify])
  const sink = useCallback((next: string | undefined) => {
    const report = notifyRef.current
    if (report) {
      if (next !== undefined) report(next)
      return
    }
    setFailure(next)
  }, [])
  const action = useMemo(() => createLatestAttempt<string>({ run, onFailure: sink, message }), [run, sink, message])
  useEffect(() => () => action.dispose(), [action])
  const launch = useCallback((value: string) => { void action.run(value) }, [action])
  return { failure, launch }
}

/** The system-browser link surface: inline failure text, no notice stream. */
export function useExternalLink(launch: (url: string) => Promise<boolean> = openExternal): ExternalLaunch {
  return useExternalLaunch({ run: launch, message: LINK_FAILED_MESSAGE })
}
