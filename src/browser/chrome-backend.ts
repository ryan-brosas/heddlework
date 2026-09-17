import { join } from 'node:path'
import type { CdpEvent } from './cdp.ts'
import { ManagedChrome, findChromeExecutable } from './chrome-process.ts'
import {
  planChromeCommand,
  planChromeEvent,
  planChromeViewport,
  planOrphanPopupTargets,
  chromeFrameScale,
  pendingChromeCommands,
  shouldPaintChromeFrame,
  historyTarget,
  originOf,
} from './chrome-plan.ts'
import type { BrowserCommand, BrowserEngineStatus, BrowserNativeState } from './types.ts'

export const CHROME_MISSING_MESSAGE = 'Chrome was not found. Install Google Chrome or Chromium, then restart Heddlework.'

interface ChromeSession {
  readonly tabId: string
  readonly generation: number
  readonly targetId: string
  readonly sessionId: string
  readonly profileId: string
  readonly incognito: boolean
  contextId?: string | undefined
  url: string
  title: string
  loading: boolean
  error?: string | undefined
  canGoBack: boolean
  canGoForward: boolean
  acknowledged: number
  viewport: { width: number; height: number }
  streaming: boolean
  lastPaintedAt: number
  queue: Promise<void>
  closed: boolean
}

export type ChromeBackendEvent =
  | { readonly kind: 'state'; readonly tabId: string; readonly state: BrowserNativeState }
  | { readonly kind: 'popup'; readonly tabId: string; readonly generation: number; readonly url: string }
  | { readonly kind: 'engine' }

export interface ChromeSessionRequest {
  readonly tabId: string
  readonly generation: number
  readonly profileId: string
  readonly incognito: boolean
  readonly viewport: { readonly width: number; readonly height: number }
}

/** A CDP call the UI prepared with the pure planners. */
export interface ChromeInputCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * Chrome as Heddlework's browser engine on hosts with no embedded browser (Linux today).
 *
 * Ownership follows the repository's existing browser contract: this backend translates the
 * service's ordered command FIFO and reports Chrome's own state back through `BrowserNativeState`,
 * so the sidebar's UI, persistence and generation guards are the ones already tested. It never
 * invents a second tab model and never applies a command twice - the acknowledged watermark lives
 * here and only advances as Chrome accepts each command.
 *
 * The debugging transport is Chrome's private fd3/fd4 pipe. No TCP debugging port is opened, Chrome
 * keeps its sandbox, and the app-owned data directory means the user's own Chrome profile is neither
 * read nor written.
 */
export class ChromeBrowserBackend {
  readonly #dataDirectory: string
  /** Device pixels per CSS pixel for streamed frames; see `chromeFrameScale`. */
  readonly #frameScale: number
  readonly #listeners = new Set<(event: ChromeBackendEvent) => void>()
  readonly #frameListeners = new Map<string, Set<(data: string) => void>>()
  readonly #sessions = new Map<string, ChromeSession>()
  readonly #contextTabs = new Map<string, number>()
  readonly #viewports = new Map<string, { width: number; height: number }>()
  #chrome: ManagedChrome | undefined
  #launch: Promise<ManagedChrome> | undefined
  #disposed = false
  #lastError: string | undefined
  #detachEvents: (() => void) | undefined

  constructor(options: { dataDirectory: string }) {
    this.#dataDirectory = join(options.dataDirectory, 'chrome')
    this.#frameScale = chromeFrameScale(process.env)
  }

  /** Whether this backend can run at all on this host. */
  get available(): boolean {
    return !this.#disposed && Boolean(findChromeExecutable())
  }

  get engineStatus(): BrowserEngineStatus {
    if (!findChromeExecutable()) return { kind: 'unavailable', available: false, message: CHROME_MISSING_MESSAGE, profileIsolation: 'limited' }
    if (this.#disposed) return { kind: 'unavailable', available: false, message: 'The managed Chrome browser has stopped.', profileIsolation: 'limited' }
    return {
      kind: 'chrome',
      available: true,
      message: this.#lastError ?? 'Google Chrome, managed by Heddlework',
      // Persistent profiles share one managed Chrome data directory, so isolation is not claimed as full.
      profileIsolation: 'limited',
    }
  }

  /** Tabs this backend currently holds a live Chrome session for. */
  get openTabIds(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  subscribe(listener: (event: ChromeBackendEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  subscribeFrames(tabId: string, generation: number, listener: (data: string) => void): () => void {
    const key = frameKey(tabId, generation)
    const listeners = this.#frameListeners.get(key) ?? new Set<(data: string) => void>()
    listeners.add(listener)
    this.#frameListeners.set(key, listeners)
    return () => {
      const current = this.#frameListeners.get(key)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.#frameListeners.delete(key)
    }
  }

  /** Open or reuse the session for a tab, creating nothing until a tab actually exists. */
  async open(request: ChromeSessionRequest): Promise<void> {
    if (this.#disposed) return
    const existing = this.#sessions.get(request.tabId)
    if (existing && existing.generation === request.generation) {
      if (request.viewport.width >= 2 && request.viewport.height >= 2) await this.setViewport(request.tabId, request.viewport.width, request.viewport.height)
      return
    }
    if (existing) await this.close(request.tabId)
    try {
      const chrome = await this.#ensureChrome()
      const contextId = request.incognito ? await this.#ephemeralContext(chrome, request.profileId) : undefined
      const { targetId } = await chrome.cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        ...(contextId ? { browserContextId: contextId } : {}),
      })
      const { sessionId } = await chrome.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      const session: ChromeSession = {
        tabId: request.tabId,
        generation: request.generation,
        targetId,
        sessionId,
        profileId: request.profileId,
        incognito: request.incognito,
        contextId,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        acknowledged: 0,
        viewport: this.#viewports.get(request.tabId) ?? {
          width: request.viewport.width >= 2 ? Math.round(request.viewport.width) : 800,
          height: request.viewport.height >= 2 ? Math.round(request.viewport.height) : 600,
        },
        streaming: false,
        lastPaintedAt: 0,
        queue: Promise.resolve(),
        closed: false,
      }
      if (contextId) this.#contextTabs.set(contextId, (this.#contextTabs.get(contextId) ?? 0) + 1)
      this.#sessions.set(request.tabId, session)
      await chrome.cdp.send('Page.enable', {}, sessionId)
      await chrome.cdp.send('Runtime.enable', {}, sessionId)
      // Headless pages do not take focus on their own, so focus-dependent UI would never respond.
      await chrome.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => undefined)
      await this.#applyViewport(chrome, session)
      this.#lastError = undefined
    } catch (error) {
      this.#reportLaunchFailure(error)
    }
  }

  async setViewport(tabId: string, width: number, height: number): Promise<void> {
    const session = this.#sessions.get(tabId)
    if (!session || session.closed) return
    const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
    this.#viewports.set(tabId, next)
    if (Math.abs(session.viewport.width - next.width) < 2 && Math.abs(session.viewport.height - next.height) < 2) return
    session.viewport = next
    const chrome = this.#chrome
    if (!chrome) return
    try { await this.#applyViewport(chrome, session) } catch { /* A resized surface keeps the previous frames. */ }
  }

  /**
   * Apply every command Chrome has not acknowledged yet, in order.
   *
   * Application is chained per tab so two overlapping renders cannot interleave Chrome calls for the
   * same page, and the watermark is re-read inside the chain: a command that ran once is not re-run
   * because a later render still saw it pending.
   */
  async applyCommands(tabId: string, generation: number, commands: readonly BrowserCommand[], commandSerial: number): Promise<void> {
    const session = this.#sessions.get(tabId)
    if (!session || session.closed || session.generation !== generation) return
    session.queue = session.queue.then(() => this.#runCommands(session, commands, commandSerial)).catch(() => undefined)
    return session.queue
  }

  async input(tabId: string, calls: readonly ChromeInputCall[]): Promise<void> {
    const session = this.#sessions.get(tabId)
    const chrome = this.#chrome
    if (!session || !chrome || session.closed || calls.length === 0) return
    for (const call of calls) {
      await chrome.cdp.send(call.method, call.params, session.sessionId).catch(() => undefined)
    }
  }

  /**
   * Read a JSON value out of a tab's page.
   *
   * App-internal readback for diagnostics and integration probes, over the same app-owned session the
   * surface uses. It is not an agent capability: nothing exposes it to a model, and agent browser access
   * stays behind BrowserAutomationAdapter and its per-profile grant.
   */
  async evaluate<T = unknown>(tabId: string, expression: string): Promise<T | undefined> {
    const session = this.#sessions.get(tabId)
    const chrome = this.#chrome
    if (!session || !chrome || session.closed) return undefined
    const evaluated = await chrome.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      session.sessionId,
    )
    return evaluated.result?.value as T | undefined
  }

  async close(tabId: string): Promise<void> {
    const session = this.#sessions.get(tabId)
    if (!session) return
    session.closed = true
    this.#sessions.delete(tabId)
    const chrome = this.#chrome
    if (chrome) {
      await chrome.cdp.send('Page.stopScreencast', {}, session.sessionId).catch(() => undefined)
      await chrome.cdp.send('Target.closeTarget', { targetId: session.targetId }).catch(() => undefined)
      if (session.contextId) await this.#releaseContext(chrome, session.contextId)
    }
    this.#viewports.delete(tabId)
    const key = frameKey(tabId, session.generation)
    this.#frameListeners.delete(key)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const tabs = [...this.#sessions.keys()]
    for (const tabId of tabs) await this.close(tabId).catch(() => undefined)
    this.#sessions.clear()
    this.#frameListeners.clear()
    this.#listeners.clear()
    const chrome = this.#chrome
    this.#chrome = undefined
    this.#launch = undefined
    this.#detachEvents?.()
    this.#detachEvents = undefined
    if (chrome) await chrome.dispose().catch(() => undefined)
  }

  async #ensureChrome(): Promise<ManagedChrome> {
    if (this.#chrome && !this.#chrome.cdp.closed) return this.#chrome
    const failed = this.#launch
    this.#launch = (async () => {
      const chrome = await ManagedChrome.launch(this.#dataDirectory)
      this.#detachEvents?.()
      this.#detachEvents = chrome.cdp.onEvent((event) => { void this.#onCdpEvent(event) })
      chrome.cdp.onClose(() => this.#onChromeClosed(chrome))
      await chrome.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
      this.#chrome = chrome
      return chrome
    })().catch((error: unknown) => {
      this.#launch = undefined
      throw error
    })
    void failed
    return this.#launch
  }

  async #applyViewport(chrome: ManagedChrome, session: ChromeSession): Promise<void> {
    const { metrics, screencast } = planChromeViewport(session.viewport.width, session.viewport.height, this.#frameScale)
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', metrics, session.sessionId).catch(() => undefined)
    if (session.streaming) await chrome.cdp.send('Page.stopScreencast', {}, session.sessionId).catch(() => undefined)
    await chrome.cdp.send('Page.startScreencast', screencast, session.sessionId)
    session.streaming = true
  }

  async #ephemeralContext(chrome: ManagedChrome, profileId: string): Promise<string> {
    const existing = this.#ephemeralContexts.get(profileId)
    if (existing) return existing
    const { browserContextId } = await chrome.cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: false })
    this.#ephemeralContexts.set(profileId, browserContextId)
    return browserContextId
  }

  readonly #ephemeralContexts = new Map<string, string>()

  async #releaseContext(chrome: ManagedChrome, contextId: string): Promise<void> {
    const remaining = (this.#contextTabs.get(contextId) ?? 1) - 1
    if (remaining > 0) {
      this.#contextTabs.set(contextId, remaining)
      return
    }
    this.#contextTabs.delete(contextId)
    for (const [profileId, id] of this.#ephemeralContexts) {
      if (id === contextId) this.#ephemeralContexts.delete(profileId)
    }
    await chrome.cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => undefined)
  }

  async #runCommands(session: ChromeSession, commands: readonly BrowserCommand[], commandSerial: number): Promise<void> {
    const chrome = this.#chrome
    if (!chrome || session.closed) return
    const pending = pendingChromeCommands({ commands, commandSerial }, session.acknowledged)
    for (const command of pending) {
      if (session.closed) return
      const planned = planChromeCommand(command)
      try {
        switch (planned.kind) {
          case 'navigate':
            session.loading = true
            await chrome.cdp.send('Page.navigate', { url: planned.url }, session.sessionId)
            break
          case 'history': {
            const history = await chrome.cdp.send<{ currentIndex: number; entries: unknown[] }>('Page.getNavigationHistory', {}, session.sessionId)
            const entryId = historyTarget(history, planned.delta)
            if (entryId !== undefined) await chrome.cdp.send('Page.navigateToHistoryEntry', { entryId }, session.sessionId)
            break
          }
          case 'reload':
            session.loading = true
            await chrome.cdp.send('Page.reload', {}, session.sessionId)
            break
          case 'stop':
            await chrome.cdp.send('Page.stopLoading', {}, session.sessionId)
            session.loading = false
            break
          case 'focus':
            await chrome.cdp.send('Target.activateTarget', { targetId: session.targetId }).catch(() => undefined)
            break
          case 'clearData': {
            await chrome.cdp.send('Network.clearBrowserCache', {}, session.sessionId).catch(() => undefined)
            const origin = originOf(session.url)
            if (origin) await chrome.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }, session.sessionId).catch(() => undefined)
            break
          }
          // A command this backend cannot perform is acknowledged rather than retried forever: the
          // sidebar only offers controls the engine implements, so this is a leftover, not a promise.
          case 'unsupported':
            break
        }
      } catch (error) {
        session.error = error instanceof Error ? error.message : 'Chrome rejected a browser command.'
        session.loading = false
      }
      session.acknowledged = Math.max(session.acknowledged, command.serial)
      this.#emitState(session, { commandSerial: command.serial })
      if (!session.error) await this.#refreshHistory(session)
    }
  }

  async #onCdpEvent(event: CdpEvent): Promise<void> {
    const chrome = this.#chrome
    if (!chrome) return
    if (event.method === 'Page.screencastFrame') {
      const session = this.#sessionBySessionId(event.sessionId)
      if (!session) return
      const frame = event.params as { data?: unknown; sessionId?: unknown }
      // Acknowledge with the frame's own number so Chrome keeps sending; the routing session is separate.
      await chrome.cdp.send('Page.screencastFrameAck', { sessionId: typeof frame.sessionId === 'number' ? frame.sessionId : 0 }, session.sessionId).catch(() => undefined)
      if (typeof frame.data !== 'string') return
      const now = Date.now()
      if (!shouldPaintChromeFrame(session.lastPaintedAt, now)) return
      session.lastPaintedAt = now
      for (const listener of this.#frameListeners.get(frameKey(session.tabId, session.generation)) ?? []) listener(frame.data)
      return
    }
    if (event.method === 'Target.targetDestroyed') {
      // A page that closed itself must not keep reporting the state it had before it went away.
      const targetId = (event.params as { targetId?: unknown }).targetId
      const session = typeof targetId === 'string' ? [...this.#sessions.values()].find((candidate) => candidate.targetId === targetId) : undefined
      if (session && !session.closed) {
        session.error = 'The page closed itself. Enter an address to continue.'
        session.loading = false
        this.#emitState(session, { loading: false })
      }
      return
    }
    if (event.method === 'Page.javascriptDialogOpening') {
      const session = this.#sessionBySessionId(event.sessionId)
      if (session) await chrome.cdp.send('Page.handleJavaScriptDialog', { accept: true }, session.sessionId).catch(() => undefined)
      return
    }
    const plan = planChromeEvent(event.method, event.params)
    const session = this.#sessionBySessionId(event.sessionId)
    if (!session) return
    switch (plan.kind) {
      case 'navigated':
        session.url = plan.url
        session.loading = true
        this.#emitState(session, { url: plan.url, loading: true })
        break
      case 'loaded':
        session.loading = false
        this.#emitState(session, { loading: false })
        await this.#refreshTitle(session)
        await this.#refreshHistory(session)
        break
      case 'windowOpen':
        // Chrome still opens the window it was asked for; Heddlework owns tabs, so the request becomes a tab
        // and the browser's own copy is closed instead of lingering as an unmanaged duplicate.
        if (plan.url) this.#emit({ kind: 'popup', tabId: session.tabId, generation: session.generation, url: plan.url })
        void this.#closeOrphanPopups()
        break
      case 'detached':
        session.error = 'The page session ended. Reload the tab to continue.'
        session.loading = false
        this.#emitState(session, { loading: false })
        break
      case 'dialog':
      case 'ignore':
        break
    }
  }

  #onChromeClosed(chrome: ManagedChrome): void {
    if (this.#chrome !== chrome) return
    this.#chrome = undefined
    this.#launch = undefined
    this.#lastError = 'Chrome exited. The next navigation starts it again.'
    for (const session of this.#sessions.values()) {
      session.error = this.#lastError
      session.loading = false
      this.#emitState(session, { loading: false })
    }
    this.#emit({ kind: 'engine' })
  }

  async #refreshTitle(session: ChromeSession): Promise<void> {
    const chrome = this.#chrome
    if (!chrome) return
    try {
      const evaluated = await chrome.cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: '({ title: document.title, href: location.href })', returnByValue: true },
        session.sessionId,
      )
      const value = evaluated.result?.value as { title?: unknown; href?: unknown } | undefined
      const title = typeof value?.title === 'string' && value.title.trim().length > 0 ? value.title.trim() : session.title
      const url = typeof value?.href === 'string' && value.href.length > 0 ? value.href : session.url
      session.title = title
      session.url = url
      this.#emitState(session, { title, url })
    } catch { /* A page that cannot be evaluated keeps the address Chrome already reported. */ }
  }

  async #refreshHistory(session: ChromeSession): Promise<void> {
    const chrome = this.#chrome
    if (!chrome) return
    try {
      const history = await chrome.cdp.send<{ currentIndex: number; entries: unknown[] }>('Page.getNavigationHistory', {}, session.sessionId)
      session.canGoBack = history.currentIndex > 0
      session.canGoForward = history.currentIndex < history.entries.length - 1
      this.#emitState(session, {})
    } catch { /* History stays as last reported. */ }
  }

  async #closeOrphanPopups(): Promise<void> {
    const chrome = this.#chrome
    if (!chrome) return
    // The popup target appears a moment after the request, so it is looked for once it can exist.
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (chrome.cdp.closed) return
    try {
      const { targetInfos } = await chrome.cdp.send<{ targetInfos: Array<{ type?: unknown; openerId?: unknown; targetId?: unknown }> }>('Target.getTargets')
      const owned = new Set([...this.#sessions.values()].map((candidate) => candidate.targetId))
      for (const targetId of planOrphanPopupTargets(targetInfos, owned)) {
        await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
      }
    } catch { /* A popup that cannot be reached is not worth failing the page over. */ }
  }

  #sessionBySessionId(sessionId: string | undefined): ChromeSession | undefined {
    if (!sessionId) return undefined
    for (const session of this.#sessions.values()) {
      if (session.sessionId === sessionId) return session
    }
    return undefined
  }

  #emitState(session: ChromeSession, patch: Partial<BrowserNativeState>): void {
    this.#emit({
      kind: 'state',
      tabId: session.tabId,
      state: {
        generation: session.generation,
        url: session.url,
        title: session.title,
        loading: session.loading,
        canGoBack: session.canGoBack,
        canGoForward: session.canGoForward,
        ...(session.error === undefined ? {} : { error: session.error }),
        ...patch,
      },
    })
  }

  #emit(event: ChromeBackendEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #reportLaunchFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : ''
    this.#lastError = message.length > 0 && /Chrome (was not found|could not start)/.test(message)
      ? message
      : 'Chrome could not start. Check that the installed browser can run, then reopen this surface.'
    this.#emit({ kind: 'engine' })
  }
}

function frameKey(tabId: string, generation: number): string {
  return `${tabId}:${generation}`
}
