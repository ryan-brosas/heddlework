import { useEffect, useMemo, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { ChromeBrowserBackend } from '../browser/chrome-backend.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserEngineKind, BrowserEngineStatus, BrowserNativeState } from '../browser/types.ts'
import { useBrowserSnapshot } from './browser-context.tsx'

interface BrowserRenderer {
  supportsNativeBrowser?(): boolean
  nativeBrowserEngine?(): string
  nativeBrowserProfileIsolation?(): string
  nativeBrowserError?(): string | null
}

interface BrowserEvent {
  value?: string | undefined
}

interface BrowserValueEvent {
  generation: number
  value: string
}

/**
 * The one owner of browser engine selection, native element placement, and Chrome's own state feed.
 *
 * A build has at most one usable engine, and the sidebar's chrome depends on knowing which one that is:
 * two components setting the engine made the panel offer controls for an engine that had already lost.
 * Native elements are only materialized when the native engine won.
 */
export function BrowserHost({ service, suspended = false, chrome }: {
  service: BrowserSessionService
  suspended?: boolean
  chrome?: ChromeBrowserBackend | undefined
}) {
  const renderer = useGpuixRequired() as BrowserRenderer
  const snapshot = useBrowserSnapshot(service)
  const native = useMemo(() => probeBrowserEngine(renderer), [renderer])
  const [chromeEngine, setChromeEngine] = useState<BrowserEngineStatus | undefined>(() => chrome?.engineStatus)
  const chromeActive = Boolean(chrome?.available) && !native.available

  useEffect(() => { setChromeEngine(chrome?.engineStatus) }, [chrome])

  // Chrome reports its own page state, popups and failures; the service stays the side that owns tabs.
  useEffect(() => {
    if (!chrome || !chromeActive) return
    return chrome.subscribe((event) => {
      if (event.kind === 'state') service.applyNativeState(event.tabId, event.state)
      else if (event.kind === 'popup') service.openRequested(event.tabId, event.generation, event.url)
      else setChromeEngine(chrome.engineStatus)
    })
  }, [chrome, chromeActive, service])

  useEffect(() => { service.setEngine(selectBrowserEngine(native, chromeEngine, chromeActive)) }, [service, native, chromeEngine, chromeActive])

  // Sessions follow the service's tabs: one Chrome page per materialized tab, and nothing left behind
  // for a tab that no longer exists.
  useEffect(() => {
    if (!chrome || !chromeActive) return
    const live = new Set<string>()
    for (const tab of snapshot.tabs) {
      if (!tab.materialized || !tab.url) continue
      live.add(tab.id)
      const profile = service.runtimeProfile(tab.profileId)
      void chrome.open({
        tabId: tab.id,
        generation: tab.generation,
        profileId: tab.profileId,
        incognito: profile?.incognito ?? false,
        viewport: { width: 0, height: 0 },
      })
      void chrome.applyCommands(tab.id, tab.generation, tab.commands, tab.commandSerial)
    }
    for (const tabId of chrome.openTabIds) {
      if (!live.has(tabId)) void chrome.close(tabId)
    }
  }, [chrome, chromeActive, service, snapshot.tabs])

  if (!native.available) return null
  const placement = snapshot.placement

  return (
    <div testId="browser-native-host" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' }}>
      {snapshot.tabs.map((tab) => {
        if (!tab.materialized || !tab.url) return null
        const profile = service.runtimeProfile(tab.profileId)
        if (!profile) return null
        const shown = !suspended && placement?.tabId === tab.id && placement.visible
        const bounds = shown ? placement.bounds : { x: 0, y: 0, width: 1, height: 1 }
        return (
          <browser
            key={`${tab.id}:${tab.generation}`}
            testId={`native-browser-${tab.id}`}
            source={tab.url}
            generation={tab.generation}
            profileId={profile.id}
            profilePath={profile.path}
            incognito={profile.incognito}
            visible={Boolean(shown)}
            command={JSON.stringify(tab.commands)}
            style={{
              position: 'absolute',
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              pointerEvents: 'none',
            }}
            onBrowserState={(event: BrowserEvent) => {
              const state = parseBrowserState(event.value)
              if (state) service.applyNativeState(tab.id, state)
            }}
            onBrowserOpen={(event: BrowserEvent) => {
              const opened = parseBrowserValue(event.value)
              if (opened) service.openRequested(tab.id, opened.generation, opened.value)
            }}
            onBrowserError={(event: BrowserEvent) => {
              const failure = parseBrowserValue(event.value)
              if (failure) service.applyNativeState(tab.id, { generation: failure.generation, loading: false, error: failure.value })
            }}
          />
        )
      })}
    </div>
  )
}

export function selectBrowserEngine(native: BrowserEngineStatus, chrome: BrowserEngineStatus | undefined, chromeActive: boolean): BrowserEngineStatus {
  if (native.available) return native
  if (chromeActive && chrome?.available) return chrome
  return native
}

function probeBrowserEngine(renderer: BrowserRenderer): BrowserEngineStatus {
  try {
    if (renderer.supportsNativeBrowser?.() !== true) {
      return {
        kind: 'unavailable',
        available: false,
        message: renderer.nativeBrowserError?.() ?? 'This GPUix build does not include a native browser surface.',
        profileIsolation: 'limited',
      }
    }
    const rawKind = renderer.nativeBrowserEngine?.()
    const kind: BrowserEngineKind = rawKind === 'cef' || rawKind === 'chromium' ? 'cef' : rawKind === 'remote' ? 'remote' : 'system'
    const rawIsolation = renderer.nativeBrowserProfileIsolation?.()
    const profileIsolation = rawIsolation === 'full' || rawIsolation === 'remote' ? rawIsolation : 'limited'
    return {
      kind,
      available: true,
      message: kind === 'cef' ? 'Chromium Embedded Framework' : kind === 'remote' ? 'Remote browser bridge' : 'System WebView',
      profileIsolation,
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      available: false,
      message: error instanceof Error ? error.message : 'Native browser initialization failed.',
      profileIsolation: 'limited',
    }
  }
}

function parseBrowserState(value: string | undefined): BrowserNativeState | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as BrowserNativeState
    return parsed && typeof parsed === 'object' && validGeneration(parsed.generation) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseBrowserValue(value: string | undefined): BrowserValueEvent | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as BrowserValueEvent
    return parsed && typeof parsed === 'object' && validGeneration(parsed.generation) && typeof parsed.value === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
