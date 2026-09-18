export type BrowserProfileKind = 'workspace' | 'personal' | 'private'
export type BrowserAgentAccess = 'allowed' | 'prompt' | 'denied'
export type BrowserEngineKind = 'cef' | 'chrome' | 'system' | 'remote' | 'unavailable'
export type BrowserLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface BrowserProfile {
  id: string
  name: string
  kind: BrowserProfileKind
  persistent: boolean
  agentAccess: BrowserAgentAccess
  builtIn: boolean
}

export interface BrowserTab {
  id: string
  profileId: string
  url: string
  title: string
  status: BrowserLoadStatus
  canGoBack: boolean
  canGoForward: boolean
  error?: string | undefined
  createdAt: number
  lastActiveAt: number
  materialized: boolean
  generation: number
  commandSerial: number
  commands: BrowserCommand[]
}

export type BrowserCommandKind =
  | 'none'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'focus'
  | 'devtools'
  | 'clearData'
  | 'print'

export interface BrowserCommand {
  serial: number
  kind: BrowserCommandKind
  value?: string | undefined
}

export interface BrowserNativeState {
  generation: number
  url?: string | undefined
  title?: string | undefined
  loading?: boolean | undefined
  canGoBack?: boolean | undefined
  canGoForward?: boolean | undefined
  error?: string | undefined
  commandSerial?: number | undefined
}

export interface BrowserSurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSurfacePlacement {
  tabId: string
  bounds: BrowserSurfaceBounds
  visible: boolean
}

export interface BrowserEngineStatus {
  kind: BrowserEngineKind
  available: boolean
  message: string
  profileIsolation: 'full' | 'limited' | 'remote'
}

export interface BrowserSnapshot {
  profiles: readonly BrowserProfile[]
  tabs: readonly BrowserTab[]
  activeTabId?: string | undefined
  defaultProfileId: string
  placement?: BrowserSurfacePlacement | undefined
  engine: BrowserEngineStatus
}

export interface BrowserRuntimeProfile {
  id: string
  path: string
  incognito: boolean
  agentAccess: BrowserAgentAccess
}

export interface PersistedBrowserState {
  version: 1
  profiles: BrowserProfile[]
  defaultProfileId: string
  tabs: Array<Pick<BrowserTab, 'id' | 'profileId' | 'url' | 'title' | 'createdAt' | 'lastActiveAt'>>
  activeTabId?: string | undefined
}

export const DEFAULT_BROWSER_PROFILES: readonly BrowserProfile[] = Object.freeze([
  Object.freeze({
    id: 'workspace',
    name: 'Workspace',
    kind: 'workspace',
    persistent: true,
    agentAccess: 'allowed',
    builtIn: true,
  }),
  Object.freeze({
    id: 'personal',
    name: 'Personal',
    kind: 'personal',
    persistent: true,
    agentAccess: 'denied',
    builtIn: true,
  }),
  Object.freeze({
    id: 'private',
    name: 'Private',
    kind: 'private',
    persistent: false,
    agentAccess: 'denied',
    builtIn: true,
  }),
])

export const UNAVAILABLE_BROWSER_ENGINE: BrowserEngineStatus = Object.freeze({
  kind: 'unavailable',
  available: false,
  message: 'This build does not include a native browser engine.',
  profileIsolation: 'limited',
})
