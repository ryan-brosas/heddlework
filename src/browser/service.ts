import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { claimBrowserDataRoot, readBrowserState, writeBrowserState } from './persistence.ts'
import { boundsEqual, roundToHalf } from './adapter.ts'
import {
  DEFAULT_BROWSER_PROFILES,
  UNAVAILABLE_BROWSER_ENGINE,
  type BrowserAgentAccess,
  type BrowserCommand,
  type BrowserCommandKind,
  type BrowserEngineStatus,
  type BrowserNativeState,
  type BrowserProfile,
  type BrowserProfileKind,
  type BrowserRuntimeProfile,
  type BrowserSnapshot,
  type BrowserSurfaceBounds,
  type BrowserTab,
  type PersistedBrowserState,
} from './types.ts'
import { isBrowserUrlAllowed, resolveBrowserAddress } from './url.ts'

const MAX_RESTORED_TABS = 24
const NATIVE_STATE_PERSIST_DELAY_MS = 300

const generationGlobal = globalThis as typeof globalThis & {
  __heddleworkBrowserGeneration?: number | undefined
}

function nextBrowserGeneration(): number {
  const generation = (generationGlobal.__heddleworkBrowserGeneration ?? 0) + 1
  if (!Number.isSafeInteger(generation)) throw new Error('Browser generation sequence is exhausted')
  generationGlobal.__heddleworkBrowserGeneration = generation
  return generation
}

export class BrowserSessionService {
  readonly #listeners = new Set<() => void>()
  readonly #statePath: string | false
  readonly #profilesRoot: string
  readonly #profiles = new Map<string, BrowserProfile>()
  readonly #profileLockError: string | undefined
  readonly #tabs = new Map<string, BrowserTab>()
  #defaultProfileId = 'workspace'
  #activeTabId: string | undefined
  #placement: BrowserSnapshot['placement']
  #engine: BrowserEngineStatus = UNAVAILABLE_BROWSER_ENGINE
  #snapshot: BrowserSnapshot
  #persistTimer: ReturnType<typeof setTimeout> | undefined
  readonly #profileDataRemovals = new Set<string>()
  #disposed = false

  constructor(options: { statePath?: string | false; dataRoot: string; cleanupOrphanedProfiles?: boolean }) {
    const requestedStatePath = options.statePath ?? false
    const claim = claimBrowserDataRoot(options.dataRoot, requestedStatePath)
    this.#statePath = claim.statePath ?? requestedStatePath
    this.#profilesRoot = claim.profilesRoot ?? join(resolve(options.dataRoot), 'profiles')
    this.#profileLockError = claim.acquired ? undefined : claim.message ?? 'Browser profile storage is unavailable.'
    const restored = claim.acquired ? readBrowserState(this.#statePath) : undefined
    this.#restore(restored)
    if (claim.acquired && restored && options.cleanupOrphanedProfiles !== false) removeOrphanedProfileData(this.#profilesRoot, this.#profiles)
    if (this.#profileLockError) this.#engine = lockedBrowserEngine(this.#profileLockError)
    this.#snapshot = this.#createSnapshot()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): BrowserSnapshot => this.#snapshot

  canInitializeNativeBrowser(): boolean {
    return !this.#profileLockError
  }

  nativeProfileRoot(): string | undefined {
    return this.#profileLockError ? undefined : this.#profilesRoot
  }

  ensureTab(): string {
    if (this.#activeTabId) {
      const tab = this.#tabs.get(this.#activeTabId)
      if (tab) {
        if (tab.url && !tab.materialized) {
          this.#replaceTab(tab.id, { materialized: true })
          this.#commit()
        }
        return tab.id
      }
    }
    return this.createTab()
  }

  createTab(options: { profileId?: string; address?: string; activate?: boolean } = {}): string {
    this.#assertLive()
    const profileId = this.#profiles.has(options.profileId ?? '') ? options.profileId! : this.#defaultProfileId
    const now = Date.now()
    const id = randomUUID()
    const url = options.address ? (resolveBrowserAddress(options.address) ?? '') : ''
    const tab: BrowserTab = {
      id,
      profileId,
      url,
      title: url ? 'Loading…' : 'New tab',
      status: url ? 'loading' : 'idle',
      canGoBack: false,
      canGoForward: false,
      createdAt: now,
      lastActiveAt: now,
      materialized: Boolean(url) && options.activate !== false,
      generation: nextBrowserGeneration(),
      commandSerial: url ? 2 : 0,
      commands: url
        ? [{ serial: 1, kind: 'navigate', value: url }, { serial: 2, kind: 'focus' }]
        : [],
    }
    this.#tabs.set(id, tab)
    if (options.activate !== false || !this.#activeTabId) this.#activeTabId = id
    this.#commit()
    return id
  }

  closeTab(id: string): void {
    if (!this.#tabs.delete(id)) return
    if (this.#placement?.tabId === id) this.#placement = undefined
    if (this.#activeTabId === id) {
      this.#activeTabId = [...this.#tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id
    }
    if (!this.#activeTabId) {
      this.createTab()
      return
    }
    this.#commit()
  }

  selectTab(id: string): void {
    const tab = this.#tabs.get(id)
    if (!tab || id === this.#activeTabId) return
    this.#activeTabId = id
    const materialized = tab.materialized || Boolean(tab.url)
    this.#replaceTab(id, {
      lastActiveAt: Date.now(),
      materialized,
      ...(materialized ? appendCommands(tab, { kind: 'focus' }) : {}),
    })
    this.#commit()
  }

  navigate(id: string, address: string): boolean {
    const url = resolveBrowserAddress(address)
    if (!url) return false
    const tab = this.#tabs.get(id)
    if (!tab) return false
    this.#replaceTab(id, {
      url,
      title: tab.url === url ? tab.title : 'Loading…',
      status: 'loading',
      error: undefined,
      materialized: true,
      ...appendCommands(tab, { kind: 'navigate', value: url }, { kind: 'focus' }),
    })
    this.#commit()
    return true
  }

  command(id: string, kind: Exclude<BrowserCommandKind, 'none' | 'navigate'>): void {
    const tab = this.#tabs.get(id)
    if (!tab || (!tab.materialized && kind !== 'focus')) return
    const refocus = kind === 'back' || kind === 'forward' || kind === 'reload' || kind === 'stop'
    this.#replaceTab(id, {
      ...appendCommands(tab, { kind }, ...(refocus ? [{ kind: 'focus' as const }] : [])),
      error: undefined,
    })
    this.#publish(false)
  }

  applyNativeState(id: string, state: BrowserNativeState): void {
    if (this.#disposed) return
    const tab = this.#tabs.get(id)
    if (!tab || state.generation !== tab.generation) return
    const url = state.url && isBrowserUrlAllowed(state.url) ? state.url : tab.url
    const includesError = Object.prototype.hasOwnProperty.call(state, 'error')
    const status = includesError && state.error
      ? 'error'
      : !includesError && tab.error
        ? 'error'
        : state.loading === true
          ? 'loading'
          : state.loading === false
            ? 'ready'
            : tab.status
    const acknowledgedSerial = Number.isSafeInteger(state.commandSerial) && (state.commandSerial ?? -1) >= 0
      ? Math.min(state.commandSerial!, tab.commandSerial)
      : undefined
    const commands = acknowledgedSerial === undefined
      ? tab.commands
      : tab.commands.filter((command) => command.serial > acknowledgedSerial)
    const error = includesError ? state.error : tab.error
    const next: Partial<BrowserTab> = {
      url,
      status,
      title: cleanTitle(state.title) ?? tab.title,
      canGoBack: state.canGoBack ?? tab.canGoBack,
      canGoForward: state.canGoForward ?? tab.canGoForward,
      ...(commands === tab.commands ? {} : { commands }),
    }
    if (includesError) next.error = error
    if (
      next.url === tab.url
      && next.status === tab.status
      && next.title === tab.title
      && next.canGoBack === tab.canGoBack
      && next.canGoForward === tab.canGoForward
      && error === tab.error
      && commands === tab.commands
    ) return
    this.#replaceTab(id, next)
    this.#commit(true)
  }

  openRequested(sourceId: string, generation: number, address: string): string | undefined {
    if (this.#disposed) return undefined
    const source = this.#tabs.get(sourceId)
    const url = resolveBrowserAddress(address)
    if (!source || source.generation !== generation || !url) return undefined
    return this.createTab({ profileId: source.profileId, address: url })
  }

  switchTabProfile(tabId: string, profileId: string): void {
    const tab = this.#tabs.get(tabId)
    if (!tab || !this.#profiles.has(profileId) || tab.profileId === profileId) return
    this.#replaceTab(tabId, {
      profileId,
      generation: nextBrowserGeneration(),
      canGoBack: false,
      canGoForward: false,
      error: undefined,
      status: tab.url ? 'loading' : 'idle',
      materialized: Boolean(tab.url),
      ...(tab.url
        ? appendCommands({ ...tab, commands: [] }, { kind: 'navigate', value: tab.url }, { kind: 'focus' })
        : { commands: [] }),
    })
    this.#commit()
  }

  createProfile(options: { name: string; kind?: Exclude<BrowserProfileKind, 'private'>; agentAccess?: BrowserAgentAccess }): string {
    const name = cleanProfileName(options.name)
    if (!name) throw new Error('Profile name is required')
    const id = `profile-${randomUUID()}`
    const kind = options.kind ?? 'workspace'
    this.#profiles.set(id, {
      id,
      name,
      kind,
      persistent: true,
      agentAccess: options.agentAccess ?? (kind === 'workspace' ? 'prompt' : 'denied'),
      builtIn: false,
    })
    this.#commit()
    return id
  }

  renameProfile(id: string, name: string): void {
    const profile = this.#profiles.get(id)
    const clean = cleanProfileName(name)
    if (!profile || !clean || profile.builtIn) return
    this.#profiles.set(id, { ...profile, name: clean })
    this.#commit()
  }

  removeProfile(id: string): boolean {
    const profile = this.#profiles.get(id)
    if (!profile || profile.builtIn) return false
    this.#profiles.delete(id)
    if (this.#defaultProfileId === id) this.#defaultProfileId = 'workspace'
    for (const tab of this.#tabs.values()) {
      if (tab.profileId === id) this.switchTabProfile(tab.id, 'workspace')
    }
    this.#commit()
    this.#profileDataRemovals.add(join(this.#profilesRoot, safePathSegment(id)))
    return true
  }

  flushRemovedProfileData(): void {
    if (this.#profileLockError) return
    for (const path of this.#profileDataRemovals) rmSync(path, { recursive: true, force: true })
    this.#profileDataRemovals.clear()
  }

  setDefaultProfile(id: string): void {
    if (!this.#profiles.has(id) || this.#defaultProfileId === id) return
    this.#defaultProfileId = id
    this.#commit()
  }

  runtimeProfile(id: string): BrowserRuntimeProfile | undefined {
    if (this.#profileLockError) return undefined
    const profile = this.#profiles.get(id)
    if (!profile) return undefined
    return {
      id: profile.id,
      path: profile.persistent ? join(this.#profilesRoot, safePathSegment(profile.id)) : '',
      incognito: !profile.persistent,
      agentAccess: profile.agentAccess,
    }
  }

  setPlacement(tabId: string, bounds: BrowserSurfaceBounds, visible: boolean): void {
    if (!this.#tabs.has(tabId)) return
    const normalized = {
      x: roundToHalf(bounds.x),
      y: roundToHalf(bounds.y),
      width: Math.max(1, roundToHalf(bounds.width)),
      height: Math.max(1, roundToHalf(bounds.height)),
    }
    const previous = this.#placement
    if (previous?.tabId === tabId && previous.visible === visible && boundsEqual(previous.bounds, normalized)) return
    this.#placement = { tabId, bounds: normalized, visible }
    this.#publish(false)
  }

  hidePlacement(tabId?: string): void {
    if (!this.#placement || (tabId && this.#placement.tabId !== tabId) || !this.#placement.visible) return
    this.#placement = { ...this.#placement, visible: false }
    this.#publish(false)
  }

  setEngine(engine: BrowserEngineStatus): void {
    const effective = this.#profileLockError ? lockedBrowserEngine(this.#profileLockError) : engine
    if (engineEqual(this.#engine, effective)) return
    this.#engine = effective
    this.#publish(false)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#flushPersistence()
    this.#disposed = true
    this.#placement = undefined
    this.#listeners.clear()
  }

  #restore(value: PersistedBrowserState | undefined): void {
    for (const profile of DEFAULT_BROWSER_PROFILES) this.#profiles.set(profile.id, { ...profile })
    for (const profile of value?.profiles ?? []) {
      const parsed = restoreProfile(profile)
      if (parsed && !parsed.builtIn && !this.#profiles.has(parsed.id)) this.#profiles.set(parsed.id, parsed)
    }
    if (value?.defaultProfileId && this.#profiles.has(value.defaultProfileId)) this.#defaultProfileId = value.defaultProfileId
    for (const saved of (value?.tabs ?? []).slice(-MAX_RESTORED_TABS)) {
      const profile = this.#profiles.get(saved.profileId)
      if (!profile?.persistent || !saved.id || (saved.url && !isBrowserUrlAllowed(saved.url))) continue
      this.#tabs.set(saved.id, {
        id: saved.id,
        profileId: saved.profileId,
        url: saved.url,
        title: cleanTitle(saved.title) ?? (saved.url ? 'New tab' : 'New tab'),
        status: saved.url ? 'idle' : 'idle',
        canGoBack: false,
        canGoForward: false,
        createdAt: finiteTimestamp(saved.createdAt),
        lastActiveAt: finiteTimestamp(saved.lastActiveAt),
        materialized: false,
        generation: nextBrowserGeneration(),
        commandSerial: 0,
        commands: [],
      })
    }
    if (value?.activeTabId && this.#tabs.has(value.activeTabId)) this.#activeTabId = value.activeTabId
    this.#activeTabId ??= [...this.#tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id
  }

  #replaceTab(id: string, patch: Partial<BrowserTab>): void {
    const tab = this.#tabs.get(id)
    if (tab) this.#tabs.set(id, { ...tab, ...patch })
  }

  #commit(deferPersistence = false): void {
    if (deferPersistence) this.#schedulePersistence()
    else this.#flushPersistence()
    this.#publish(false)
  }

  #schedulePersistence(): void {
    if (!this.#statePath || this.#persistTimer) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      if (!this.#disposed) this.#persist()
    }, NATIVE_STATE_PERSIST_DELAY_MS)
  }

  #flushPersistence(): void {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = undefined
    }
    this.#persist()
  }

  #persist(): void {
    if (this.#profileLockError) return
    const persistentTabs = [...this.#tabs.values()]
      .filter((tab) => this.#profiles.get(tab.profileId)?.persistent)
      .map(({ id, profileId, url, title, createdAt, lastActiveAt }) => ({ id, profileId, url, title, createdAt, lastActiveAt }))
    const activeTabId = persistentTabs.some((tab) => tab.id === this.#activeTabId) ? this.#activeTabId : undefined
    writeBrowserState(this.#statePath, {
      version: 1,
      profiles: [...this.#profiles.values()].map((profile) => ({ ...profile })),
      defaultProfileId: this.#defaultProfileId,
      tabs: persistentTabs,
      ...(activeTabId ? { activeTabId } : {}),
    })
  }

  #publish(_persisted: boolean): void {
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #createSnapshot(): BrowserSnapshot {
    return {
      profiles: [...this.#profiles.values()].map((profile) => ({ ...profile })),
      tabs: [...this.#tabs.values()].map((tab) => ({ ...tab, commands: tab.commands.map((command) => ({ ...command })) })),
      activeTabId: this.#activeTabId,
      defaultProfileId: this.#defaultProfileId,
      placement: this.#placement ? { ...this.#placement, bounds: { ...this.#placement.bounds } } : undefined,
      engine: { ...this.#engine },
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('Browser service is disposed')
  }
}

function appendCommands(
  tab: Pick<BrowserTab, 'commandSerial' | 'commands'>,
  ...entries: Array<Omit<BrowserCommand, 'serial'>>
): Pick<BrowserTab, 'commandSerial' | 'commands'> {
  let commandSerial = tab.commandSerial
  const commands = [...tab.commands]
  for (const entry of entries) {
    commandSerial += 1
    commands.push({ serial: commandSerial, ...entry })
  }
  return { commandSerial, commands }
}

function restoreProfile(value: BrowserProfile): BrowserProfile | undefined {
  if (!value || typeof value.id !== 'string' || !/^profile-[a-f0-9-]{20,}$/iu.test(value.id)) return undefined
  const name = cleanProfileName(value.name)
  const kind = value.kind === 'personal' ? 'personal' : 'workspace'
  const agentAccess = value.agentAccess === 'allowed' || value.agentAccess === 'prompt' ? value.agentAccess : 'denied'
  return name ? { id: value.id, name, kind, persistent: true, agentAccess, builtIn: false } : undefined
}

function cleanProfileName(value: string): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, 64) : ''
}

function cleanTitle(value: string | undefined): string | undefined {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, 240) : ''
  return title || undefined
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Date.now()
}

function lockedBrowserEngine(message: string): BrowserEngineStatus {
  return { kind: 'unavailable', available: false, message, profileIsolation: 'limited' }
}

function engineEqual(a: BrowserEngineStatus, b: BrowserEngineStatus): boolean {
  return a.kind === b.kind && a.available === b.available && a.message === b.message && a.profileIsolation === b.profileIsolation
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-z0-9-]/giu, '-')
}

function removeOrphanedProfileData(root: string, profiles: ReadonlyMap<string, BrowserProfile>): void {
  const retained = new Set([...profiles.keys()].map(safePathSegment))
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || retained.has(entry.name) || !/^profile-[a-f0-9-]{20,}$/iu.test(entry.name)) continue
      rmSync(join(root, entry.name), { recursive: true, force: true })
    }
  } catch {
    // Missing or read-only profile roots do not prevent browser startup.
  }
}
