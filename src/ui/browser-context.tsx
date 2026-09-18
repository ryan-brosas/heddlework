import React, { createContext, useContext, useSyncExternalStore } from 'react'
import type { ChromeBrowserBackend } from '../browser/chrome-backend.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserSnapshot } from '../browser/types.ts'

const BrowserServiceContext = createContext<BrowserSessionService | undefined>(undefined)

export function BrowserServiceProvider({
  service,
  children,
}: {
  service?: BrowserSessionService | undefined
  children: React.ReactNode
}) {
  return <BrowserServiceContext.Provider value={service}>{children}</BrowserServiceContext.Provider>
}

export function useOptionalBrowserService(): BrowserSessionService | undefined {
  return useContext(BrowserServiceContext)
}

const ChromeBackendContext = createContext<ChromeBrowserBackend | undefined>(undefined)

/** Present only on hosts whose browser engine is managed Chrome; absent keeps the native surface path. */
export function ChromeBackendProvider({
  backend,
  children,
}: {
  backend?: ChromeBrowserBackend | undefined
  children: React.ReactNode
}) {
  return <ChromeBackendContext.Provider value={backend}>{children}</ChromeBackendContext.Provider>
}

export function useOptionalChromeBackend(): ChromeBrowserBackend | undefined {
  return useContext(ChromeBackendContext)
}

export function useBrowserSnapshot(service: BrowserSessionService): BrowserSnapshot {
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
}
