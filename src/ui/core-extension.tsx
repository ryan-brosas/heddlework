import { useSyncExternalStore } from 'react'
import type { WorkbenchPlugin } from '../core/kernel.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { DiffPanel } from './diff-panel.tsx'
import { useOptionalBrowserService } from './browser-context.tsx'
import { BrowserPanel } from './browser-panel.tsx'
import {
  workbenchUiRegistryToken,
  type WorkbenchSurfaceContribution,
  type WorkbenchSurfaceProps,
  type WorkbenchUiExtension,
} from './extensions.ts'
import type { IconName } from './icons.tsx'
import { SurfacePlaceholderPanel } from './surface-picker.tsx'
import { useOptionalTerminalService } from './terminal-context.tsx'
import { TerminalPanel } from './terminal-panel.tsx'

export function createCoreUiExtensionPlugin(): WorkbenchPlugin {
  return {
    id: 'core-workbench-ui',
    requires: [workbenchUiRegistryToken, workbenchControllerToken],
    activate(ctx) {
      const registry = ctx.get(workbenchUiRegistryToken)
      const controller = ctx.get(workbenchControllerToken)
      ctx.effect(() => registry.register(createCoreUiExtension(controller)))
    },
  }
}

function BrowserSurface(props: WorkbenchSurfaceProps) {
  const service = useOptionalBrowserService()
  if (!service) {
    return (
      <SurfacePlaceholderPanel
        descriptor={{ id: 'browser', title: 'Browser', description: 'Open a local app or URL.', icon: 'globe' }}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
        panelWidth={props.panelWidth}
        onToggleFullscreen={props.onToggleFullscreen}
        onNew={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }
  return (
    <BrowserPanel
      service={service}
      fullscreen={props.fullscreen}
      fullscreenProgress={props.fullscreenProgress}
      {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
      panelWidth={props.panelWidth}
      onToggleFullscreen={props.onToggleFullscreen}
      onNewSurface={props.onNewSurface}
      onClose={props.onClose}
    />
  )
}

function TerminalSurface(props: WorkbenchSurfaceProps) {
  const service = useOptionalTerminalService()
  if (!service) {
    return (
      <SurfacePlaceholderPanel
        descriptor={{ id: 'terminal', title: 'Terminal', description: 'Start a shell in this workspace.', icon: 'terminal' }}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
        panelWidth={props.panelWidth}
        onToggleFullscreen={props.onToggleFullscreen}
        onNew={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }
  return (
    <TerminalPanel
      service={service}
      fullscreen={props.fullscreen}
      fullscreenProgress={props.fullscreenProgress}
      {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
      panelWidth={props.panelWidth}
      {...(props.appearance ? { appearance: props.appearance } : {})}
      onToggleFullscreen={props.onToggleFullscreen}
      onNewSurface={props.onNewSurface}
      onClose={props.onClose}
    />
  )
}

export function createCoreUiExtension(controller: WorkbenchController): WorkbenchUiExtension {
  function DiffSurface(props: WorkbenchSurfaceProps) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return (
      <DiffPanel
        diff={state.workspaceDiff}
        controller={controller}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
        panelWidth={props.panelWidth}
        {...(props.appearance ? { appearance: props.appearance } : {})}
        onToggleFullscreen={props.onToggleFullscreen}
        onNewSurface={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }

  return {
    id: 'heddlework.core',
    surfaces: [
      {
        id: 'browser',
        title: 'Browser',
        description: 'Open a local app or URL.',
        icon: 'globe',
        order: 10,
        component: BrowserSurface,
      },
      {
        id: 'terminal',
        title: 'Terminal',
        description: 'Start a shell in this workspace.',
        icon: 'terminal',
        order: 20,
        component: TerminalSurface,
      },
      placeholder('files', 'Files', 'Browse and read workspace files.', 'files', 30),
      {
        id: 'diff',
        title: 'Diff',
        description: 'Review working-tree changes.',
        icon: 'fileDiff',
        order: 40,
        component: DiffSurface,
        onOpen: () => { void controller.refreshWorkspaceDiff() },
      },
      placeholder('agents', 'Agents', 'Watch subagents and workflows run.', 'bot', 50),
    ],
  }
}

function placeholder(id: string, title: string, description: string, icon: IconName, order: number): WorkbenchSurfaceContribution {
  function PlaceholderSurface(props: WorkbenchSurfaceProps) {
    return (
      <SurfacePlaceholderPanel
        descriptor={{ id, title, description, icon }}
        fullscreen={props.fullscreen}
        fullscreenProgress={props.fullscreenProgress}
        {...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked })}
        panelWidth={props.panelWidth}
        onToggleFullscreen={props.onToggleFullscreen}
        onNew={props.onNewSurface}
        onClose={props.onClose}
      />
    )
  }

  return { id, title, description, icon, order, component: PlaceholderSurface }
}
