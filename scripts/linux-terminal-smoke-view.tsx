import { useEffect, useMemo, useState } from 'react'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { copyTextToClipboard } from '../src/ui/clipboard-media.ts'
import type { TerminalCopy } from '../src/ui/terminal-copy-feedback.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'
import { TERMINAL_EVIDENCE_TEST_ID, TERMINAL_SMOKE_SHELL } from './linux-terminal-smoke-contract.ts'
import { createTerminalSmokeCopyRecorder, readTerminalSmokeEvidence } from './linux-terminal-smoke-evidence.ts'

/**
 * Terminal shortcut lane, shared by the native compositor fixture (`smoke-linux-window.tsx`) and the
 * headless lane test (`tests/linux-terminal-smoke-lane.test.tsx`).
 *
 * It mounts the production `TerminalView` over a real PTY and republishes an evidence document that the
 * compositor driver asserts on. Clipboard I/O stays injectable so a test can drive the same assertion
 * sequence without a compositor or an operating-system clipboard; the native fixture keeps the
 * production defaults.
 */
export const TERMINAL_SMOKE_WIDTH = 860
export const TERMINAL_SMOKE_HEIGHT = 560

export function TerminalSmokeView({
  copy = copyTextToClipboard,
  readPaste,
}: {
  copy?: TerminalCopy
  readPaste?: () => Promise<string | undefined>
}) {
  const service = useMemo(() => new TerminalSessionService({ cwd: process.cwd() }), [])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [evidence, setEvidence] = useState<string | undefined>(undefined)
  // Clipbocord_FIX outcomes are recorded per mount: the lane asserts on one shortcut attempt at a time.
  const recorder = useMemo(() => createTerminalSmokeCopyRecorder(copy), [copy])

  useEffect(() => {
    let cancelled = false
    void service
      .spawn({ name: 'smoke', shell: '/bin/sh', args: ['-c', TERMINAL_SMOKE_SHELL] })
      .then((id) => { if (!cancelled) setSessionId(id) })
      .catch(() => undefined)
    return () => {
      cancelled = true
      void service.dispose()
    }
  }, [service])

  useEffect(() => {
    if (!sessionId) return
    const publish = () => {
      const next = readTerminalSmokeEvidence(service, sessionId, recorder.state)
      setEvidence((current) => (current === next ? current : next))
    }
    publish()
    const timer = setInterval(publish, 100)
    return () => clearInterval(timer)
  }, [recorder, service, sessionId])

  return (
    <div style={{ paddingLeft: 24, width: '100%' }}>
      {sessionId ? (
        <div style={{ width: TERMINAL_SMOKE_WIDTH, height: TERMINAL_SMOKE_HEIGHT }}>
          <TerminalView
            service={service}
            sessionId={sessionId}
            placement="bottom"
            width={TERMINAL_SMOKE_WIDTH}
            height={TERMINAL_SMOKE_HEIGHT}
            appearance="dark"
            copy={recorder.write}
            readPaste={readPaste}
          />
        </div>
      ) : null}
      {evidence ? (
        <div testId={TERMINAL_EVIDENCE_TEST_ID} style={{ width: TERMINAL_SMOKE_WIDTH, height: 14, overflow: 'hidden' }}>
          <text style={{ color: '#94a3b8', fontSize: 9 }}>{evidence}</text>
        </div>
      ) : null}
    </div>
  )
}