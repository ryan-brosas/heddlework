import { useCallback, useEffect, useMemo, useState } from 'react'
import { createLatestAttempt } from './attempt-feedback.ts'
import { openExternal } from './open-external.ts'

export const LINK_FAILED_MESSAGE = 'Could not open this link in your system browser'

/**
 * Inline feedback for a link surface without a workbench controller.
 *
 * A refused launch and a rejected one are the same failure to the user, and the rule that a later
 * click wins over an earlier one still in flight comes from `attempt-feedback.ts`.
 */
export function useExternalLink(launch: (url: string) => Promise<boolean> = openExternal) {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const action = useMemo(
    () => createLatestAttempt<string>({ run: launch, onFailure: setFailure, message: LINK_FAILED_MESSAGE }),
    [launch],
  )
  useEffect(() => () => action.dispose(), [action])
  const open = useCallback((url: string) => { void action.run(url) }, [action])
  return { failure, open }
}
