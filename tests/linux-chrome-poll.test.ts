import { describe, expect, it } from 'bun:test'
import { LINUX_CHROME_IDLE_POLL_MS, LINUX_CHROME_STREAMING_POLL_MS } from '../src/ui/linux-window-chrome.tsx'

describe('linux chrome poll', () => {
  it('backs the blocking window-state poll off while streaming', async () => {
    expect(LINUX_CHROME_STREAMING_POLL_MS).toBeGreaterThan(LINUX_CHROME_IDLE_POLL_MS)
    const [app, chrome, transcript] = await Promise.all([
      Bun.file(new URL('../src/ui/app.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/linux-window-chrome.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src/ui/transcript.tsx', import.meta.url)).text(),
    ])
    expect(app).toContain("state.session.isStreaming || state.activity === 'Opening thread'")
    expect(app).toContain('deferLinuxUiPolls ? LINUX_CHROME_STREAMING_POLL_MS : LINUX_CHROME_IDLE_POLL_MS')
    expect(app).toContain('windowSizePollInterval(deferLinuxUiPolls)')
    expect(app).toContain('onRefresh={nativeChrome.refresh}')
    expect(chrome).toContain('onMouseDown={() => onRefresh?.()}')
    expect(transcript).toContain('const MemoProjectedTranscriptRow = memo(ProjectedTranscriptRow)')
    expect(transcript).toContain('traceLengthsRef.current')
    expect(transcript).toContain('resetRowIdentityCache()')
  })
})
