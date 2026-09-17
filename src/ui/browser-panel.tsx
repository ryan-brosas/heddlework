import { useCallback, useEffect, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserProfile, BrowserTab } from '../browser/types.ts'
import { browserDisplayAddress } from '../browser/url.ts'
import type { WorkbenchSurfaceProps } from './extensions.ts'
import { Icon } from './icons.tsx'
import { IconButton, Button } from './primitives.tsx'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { colors } from './theme.ts'
import { useBrowserSnapshot } from './browser-context.tsx'
import { useWindowMetrics } from './window-metrics.tsx'
import { openExternal } from './open-external.ts'
import { sampleBrowserPlacement, type BrowserPlacementSample } from './browser-placement.ts'

interface BoundsRenderer {
  getElementBounds?(id: number): readonly number[] | undefined
}

export function BrowserPanel({
  service,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  panelWidth,
  onToggleFullscreen,
  onNewSurface,
  onClose,
}: WorkbenchSurfaceProps & { service: BrowserSessionService }) {
  const snapshot = useBrowserSnapshot(service)
  const activeId = snapshot.activeTabId
  const activeTab = snapshot.tabs.find((tab) => tab.id === activeId)
  const profile = snapshot.profiles.find((candidate) => candidate.id === activeTab?.profileId)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const systemBrowser = useSystemBrowser()
  const unavailable = !snapshot.engine.available
  const body = browserPanelBody({ available: !unavailable, hasTab: Boolean(activeTab), hasUrl: Boolean(activeTab?.url) })

  useEffect(() => { service.ensureTab() }, [service])

  const newTab = useCallback(() => {
    service.createTab({ profileId: activeTab?.profileId ?? snapshot.defaultProfileId })
    setProfileMenuOpen(false)
  }, [activeTab?.profileId, service, snapshot.defaultProfileId])

  return (
    <div testId="browser-panel" style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader
        icon="globe"
        title="Browser"
        compact
        fullscreen={fullscreen}
        fullscreenProgress={fullscreenProgress}
        fullscreenLocked={fullscreenLocked}
        tabs={snapshot.tabs.map((tab) => ({ id: tab.id, title: tab.title || 'New tab', icon: 'globe' as const, testId: `browser-tab-${tab.id}`, closeTestId: `browser-close-tab-${tab.id}` }))}
        {...(activeId ? { activeTabId: activeId } : {})}
        newTabLabel="New browser tab"
        newTabTestId="browser-new-tab"
        onSelectTab={(id) => { service.selectTab(id); setProfileMenuOpen(false) }}
        onCloseTab={(id) => { service.closeTab(id); setProfileMenuOpen(false) }}
        onNewTab={newTab}
        onNew={onNewSurface}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
      />
      <BrowserToolbar
        service={service}
        tab={activeTab}
        profile={profile}
        onOpenExternal={systemBrowser.open}
        profileMenuOpen={profileMenuOpen}
        onToggleProfileMenu={() => {
          if (profileMenuOpen && activeId) service.command(activeId, 'focus')
          setProfileMenuOpen((value) => !value)
        }}
      />
      <div testId="browser-panel-body" style={{ position: 'relative', flexGrow: 1, minHeight: 0, overflow: 'hidden', backgroundColor: colors.card }}>
        {body === 'surface' && activeTab ? (
          <BrowserSurfaceSlot service={service} tabId={activeTab.id} visible={!profileMenuOpen && !activeTab.error} />
        ) : body === 'empty' && activeTab ? (
          <BrowserEmptyState service={service} tab={activeTab} />
        ) : null}
        {!unavailable && activeTab?.error ? <BrowserError message={activeTab.error} onRetry={() => service.command(activeTab.id, 'reload')} /> : null}
        {systemBrowser.failure ? <BrowserError testId="browser-external-error" message={systemBrowser.failure} /> : null}
        {/* Without an engine this is the whole surface: an address bar and a Loading tab
            promised browsing that could never start. */}
        {unavailable ? (
          <BrowserUnavailable
            message={snapshot.engine.message}
            {...(activeTab?.url ? { url: activeTab.url } : {})}
            onOpenExternal={systemBrowser.open}
          />
        ) : null}
        {profileMenuOpen && activeTab ? (
          <ProfileMenu
            service={service}
            profiles={snapshot.profiles}
            activeProfileId={activeTab.profileId}
            defaultProfileId={snapshot.defaultProfileId}
            isolation={snapshot.engine.profileIsolation}
            onClose={() => setProfileMenuOpen(false)}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * What the panel body shows. Unavailable wins outright: an empty address surface and a "Loading…" tab
 * both promised browsing that could never start.
 */
export function browserPanelBody(options: { available: boolean; hasTab: boolean; hasUrl: boolean }): 'unavailable' | 'surface' | 'empty' | 'none' {
  if (!options.available) return 'unavailable'
  if (!options.hasTab) return 'none'
  return options.hasUrl ? 'surface' : 'empty'
}

/** The system browser is the user's own profile: Heddlework's browser is not involved. */
const SYSTEM_BROWSER_CAVEAT = "Opens in your own browser, not Heddlework's sandboxed profiles."

/**
 * One shared external-browser action for the toolbar and the unavailable panel.
 *
 * A launch that never started used to be invisible: the click did nothing and the surface looked
 * broken rather than unsupported.
 */
function useSystemBrowser(): { failure: string | undefined; open(url: string): void } {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const open = useCallback((url: string) => {
    setFailure(undefined)
    void openExternal(url).then((launched) => {
      if (!launched) setFailure(`Could not open ${browserDisplayAddress(url) || url} in your system browser`)
    })
  }, [])
  return { failure, open }
}

/**
 * The Browser surface for a build with no native browser host at all (the web companion).
 *
 * It replaces a placeholder that read as "the host is ready", which promised embedded browsing in a
 * client that has none.
 */
export function BrowserHostUnavailableSurface(props: WorkbenchSurfaceProps) {
  return (
    <div testId="browser-surface-unavailable" style={rightPanelStyle(props.fullscreen, props.panelWidth)}>
      <RightPanelHeader
        icon="globe"
        title="Browser"
        compact
        fullscreen={props.fullscreen}
        {...(props.fullscreenProgress === undefined ? {} : { fullscreenProgress: props.fullscreenProgress })}
        {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
        onNew={props.onNewSurface}
        onToggleFullscreen={props.onToggleFullscreen}
        onClose={props.onClose}
      />
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 28, backgroundColor: colors.card }}>
        <Icon name="globe" size={26} color={colors.textFaint} />
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>No embedded browser in this build</text>
        <text style={{ maxWidth: 330, color: colors.textMuted, fontSize: 10, lineHeight: 16, textAlign: 'center' }}>Browsing inside Heddlework needs the desktop app's native browser host. Open the address in your own browser instead.</text>
      </div>
    </div>
  )
}

function BrowserToolbar({
  service,
  profile,
  tab,
  onOpenExternal,
  profileMenuOpen,
  onToggleProfileMenu,
}: {
  service: BrowserSessionService
  tab?: BrowserTab | undefined
  profile?: BrowserProfile | undefined
  onOpenExternal(url: string): void
  profileMenuOpen: boolean
  onToggleProfileMenu(): void
}) {
  const [draft, setDraft] = useState(browserDisplayAddress(tab?.url ?? ''))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(browserDisplayAddress(tab?.url ?? ''))
  }, [editing, tab?.url])
  const submit = () => {
    if (tab && service.navigate(tab.id, draft)) setEditing(false)
  }

  return (
    <div testId="browser-toolbar" style={{ height: 38, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 7, paddingRight: 7, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <IconButton icon="chevronLeft" label="Back" testId="browser-back" disabled={!tab?.canGoBack} onClick={() => tab && service.command(tab.id, 'back')} />
      <IconButton icon="chevronRight" label="Forward" testId="browser-forward" disabled={!tab?.canGoForward} onClick={() => tab && service.command(tab.id, 'forward')} />
      <IconButton icon={tab?.status === 'loading' ? 'x' : 'refresh'} label={tab?.status === 'loading' ? 'Stop loading' : 'Reload'} testId="browser-reload" disabled={!tab?.url} onClick={() => tab && service.command(tab.id, tab.status === 'loading' ? 'stop' : 'reload')} />
      <div testId="browser-address-frame" style={{ minWidth: 80, height: 30, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 8, borderWidth: 1, borderColor: editing ? colors.primary : colors.borderStrong, backgroundColor: colors.input }}>
        <Icon name={tab?.url?.startsWith('https://') ? 'lock' : 'globe'} size={10} color={colors.textFaint} />
        <input
          testId="browser-address"
          value={draft}
          placeholder="Search or enter address"
          theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }}
          style={{ width: 0, minWidth: 0, height: 27, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10 }}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(String(event.value ?? ''))}
          onSubmit={submit}
        />
      </div>
      <div testId="browser-profile-button" tabIndex={0} style={{ height: 28, maxWidth: 100, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 7, paddingRight: 7, borderRadius: 7, borderWidth: 1, borderColor: profileMenuOpen ? colors.primary : colors.borderStrong, backgroundColor: profileMenuOpen ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onToggleProfileMenu} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onToggleProfileMenu() }}>
        <Icon name={profile?.kind === 'private' ? 'lock' : 'circle'} size={10} color={profile?.kind === 'workspace' ? colors.primary : colors.textFaint} />
        <text style={{ minWidth: 0, color: colors.textMuted, fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{profile?.name ?? 'Profile'}</text>
      </div>
      <IconButton icon="globe" label="Open in system browser" testId="browser-open-external" disabled={!tab?.url} onClick={() => tab?.url && onOpenExternal(tab.url)} />
    </div>
  )
}

function BrowserSurfaceSlot({ service, tabId, visible }: { service: BrowserSessionService; tabId: string; visible: boolean }) {
  const renderer = useGpuixRequired() as BoundsRenderer
  const elementId = useRef<number | undefined>(undefined)
  const setElementRef = useCallback((instance: { id: number } | null) => {
    elementId.current = instance?.id
  }, [])

  useEffect(() => {
    let previous: BrowserPlacementSample | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      const id = elementId.current
      const raw = id === undefined ? undefined : renderer.getElementBounds?.(id)
      const result = sampleBrowserPlacement(raw, visible, previous)
      previous = result.sample
      if (result.changed && result.sample) service.setPlacement(tabId, result.sample.bounds, result.sample.visible)
      timer = setTimeout(update, result.nextDelayMs)
    }
    update()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      service.hidePlacement(tabId)
    }
  }, [renderer, service, tabId, visible])

  return <div ref={setElementRef} testId="browser-surface-slot" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.card }} />
}

function BrowserEmptyState({ service, tab }: { service: BrowserSessionService; tab?: BrowserTab | undefined }) {
  const suggestions = ['localhost:3000', 'github.com', 'chatgpt.com']
  return (
    <div testId="browser-empty" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
      <div style={{ width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: colors.raised }}><Icon name="globe" size={21} color={colors.textMuted} /></div>
      <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Browse inside Heddlework</text>
      <text style={{ maxWidth: 320, color: colors.textFaint, fontSize: 10, lineHeight: 15, textAlign: 'center' }}>Sessions keep their own app-managed profile. Workspace profiles can later be granted to an agent without exposing personal browser data.</text>
      <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
        {suggestions.map((address) => <Button key={address} label={address} compact onClick={() => { if (tab) service.navigate(tab.id, address) }} />)}
      </div>
    </div>
  )
}

function BrowserError({ message, onRetry, testId = 'browser-error' }: { message: string; onRetry?(): void; testId?: string }) {
  return (
    <div testId={testId} style={{ position: 'absolute', left: 18, right: 18, bottom: 18, minHeight: 44, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.error, backgroundColor: colors.popover }}>
      <Icon name="circle" size={12} color={colors.error} />
      <text style={{ minWidth: 0, flexGrow: 1, color: colors.textMuted, fontSize: 10, lineHeight: 15 }}>{message}</text>
      {onRetry ? <Button label="Retry" compact onClick={onRetry} /> : null}
    </div>
  )
}

function BrowserUnavailable({ message, url, onOpenExternal }: { message: string; url?: string | undefined; onOpenExternal(url: string): void }) {
  return (
    <div testId="browser-unavailable" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 28, backgroundColor: colors.card }}>
      <Icon name="globe" size={26} color={colors.textFaint} />
      <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Native browser unavailable</text>
      <text style={{ maxWidth: 330, color: colors.textMuted, fontSize: 10, lineHeight: 16, textAlign: 'center' }}>{message}</text>
      <text style={{ maxWidth: 330, color: colors.textFaint, fontSize: 9, lineHeight: 15, textAlign: 'center' }}>{SYSTEM_BROWSER_CAVEAT}</text>
      {url ? <Button label="Open in system browser" compact icon="globe" onClick={() => onOpenExternal(url)} /> : null}
    </div>
  )
}

function ProfileMenu({
  service,
  profiles,
  activeProfileId,
  defaultProfileId,
  isolation,
  onClose,
}: {
  service: BrowserSessionService
  profiles: readonly BrowserProfile[]
  activeProfileId: string
  defaultProfileId: string
  isolation: 'full' | 'limited' | 'remote'
  onClose(): void
}) {
  const windowSize = useWindowMetrics().size
  const menuWidth = Math.max(160, Math.min(310, windowSize.width - 32))
  const menuHeight = Math.max(80, windowSize.height - 112)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const activeTabId = service.getSnapshot().activeTabId
  const create = () => {
    const clean = name.trim()
    if (!clean || !activeTabId) return
    const id = service.createProfile({ name: clean, kind: 'workspace', agentAccess: 'prompt' })
    service.switchTabProfile(activeTabId, id)
    setName('')
    setCreating(false)
    onClose()
  }
  return (
    <div testId="browser-profile-menu" style={{ position: 'absolute', top: 8, right: 8, width: menuWidth, maxHeight: Math.min(620, menuHeight), display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'scroll' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 5, paddingRight: 3 }}>
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 650 }}>Browser profiles</text>
          <text style={{ color: colors.textFaint, fontSize: 8 }}>{isolation === 'full' ? 'Isolated cookies, storage, cache, and logins' : 'System engine: profile isolation may be limited'}</text>
        </div>
        <IconButton icon="x" label="Close profiles" onClick={onClose} />
      </div>
      {profiles.map((profile) => {
        const active = profile.id === activeProfileId
        return (
          <div key={profile.id} testId={`browser-profile-${profile.id}`} style={{ minHeight: 50, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 9, paddingRight: 6, borderRadius: 8, borderWidth: 1, borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.raised : colors.card }}>
            <div tabIndex={0} style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3, cursor: 'pointer' }} onClick={() => { if (activeTabId) service.switchTabProfile(activeTabId, profile.id); onClose() }} onKeyDown={(event) => { if ((event.key === 'enter' || event.key === 'space') && activeTabId) { service.switchTabProfile(activeTabId, profile.id); onClose() } }}>
              <text style={{ color: colors.text, fontSize: 10, fontWeight: 650 }}>{profile.name}{profile.id === defaultProfileId ? ' · default' : ''}</text>
              <text style={{ color: colors.textFaint, fontSize: 8 }}>{profile.persistent ? `${profile.kind} · agent ${profile.agentAccess}` : 'Ephemeral · erased when closed'}</text>
            </div>
            {profile.id !== defaultProfileId && profile.persistent ? <Button label="Default" compact onClick={() => service.setDefaultProfile(profile.id)} /> : null}
            {!profile.builtIn ? <IconButton icon="x" label={`Remove ${profile.name}`} onClick={() => service.removeProfile(profile.id)} /> : null}
          </div>
        )
      })}
      {creating ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <div style={{ height: 31, minWidth: 0, flexGrow: 1, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.input }}>
            <input testId="browser-profile-name" value={name} placeholder="Profile name" autoFocus theme={{ caret: colors.text, text: colors.text, textMuted: colors.placeholder, bg: colors.transparent }} style={{ height: 28, minWidth: 0, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10 }} onChange={(event) => setName(String(event.value ?? ''))} onKeyDown={(event) => { if (event.key === 'enter') create(); if (event.key === 'escape') setCreating(false) }} />
          </div>
          <Button label="Create" compact disabled={!name.trim()} onClick={create} />
        </div>
      ) : <Button testId="browser-create-profile" label="New workspace profile" compact icon="plus" onClick={() => setCreating(true)} />}
    </div>
  )
}
