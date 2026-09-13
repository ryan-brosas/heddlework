import type {
  BrowserAgentAccess,
  BrowserEngineKind,
  BrowserNativeState,
  BrowserRuntimeProfile,
  BrowserSurfaceBounds,
} from './types.ts'

export interface BrowserSurfaceEvents {
  stateChanged(state: BrowserNativeState): void
  openRequested(generation: number, url: string): void
  failed(generation: number, message: string): void
}

export interface BrowserSurfaceSession {
  readonly engine: BrowserEngineKind
  setBounds(bounds: BrowserSurfaceBounds): void
  setVisible(visible: boolean): void
  focus(): void
  navigate(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  print(): void
  clearData(): Promise<void>
  dispose(): void
}

export interface BrowserSurfaceAdapter {
  readonly engine: BrowserEngineKind
  open(profile: BrowserRuntimeProfile, events: BrowserSurfaceEvents): Promise<BrowserSurfaceSession>
}

export interface BrowserAutomationGrant {
  profileId: string
  access: BrowserAgentAccess
  grantedAt?: number | undefined
  expiresAt?: number | undefined
}

export interface BrowserAutomationAdapter {
  navigate(tabId: string, url: string, grant: BrowserAutomationGrant): Promise<void>
  evaluate<T>(tabId: string, expression: string, grant: BrowserAutomationGrant): Promise<T>
  screenshot(tabId: string, grant: BrowserAutomationGrant): Promise<Uint8Array>
}

export function roundToHalf(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 2) / 2 : 0
}

export function boundsEqual(a: BrowserSurfaceBounds, b: BrowserSurfaceBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function mayAutomateBrowser(grant: BrowserAutomationGrant, now = Date.now()): boolean {
  if (grant.access === 'denied') return false
  if (grant.access === 'allowed') return true
  return grant.grantedAt !== undefined && (grant.expiresAt === undefined || grant.expiresAt > now)
}
