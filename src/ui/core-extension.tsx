import React, { useSyncExternalStore } from 'react'
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
import { SurfacePlaceholderPanel, type SurfaceDescriptor } from './surface-picker.tsx'
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

/** Chrome/geometry props every surface forwards unchanged to its panel or fallback. */
function surfaceChrome(props: WorkbenchSurfaceProps) {
  return {
    fullscreen: props.fullscreen,
    fullscreenProgress: props.fullscreenProgress,
    ...(props.fullscreenLocked === undefined ? {} : { fullscreenLocked: props.fullscreenLocked }),
    panelWidth: props.panelWidth,
    onToggleFullscreen: props.onToggleFullscreen,
    onClose: props.onClose,
  }
}

function SurfaceFallback(props: WorkbenchSurfaceProps & { descriptor: SurfaceDescriptor }) {
  return <SurfacePlaceholderPanel descriptor={props.descriptor} {...surfaceChrome(props)} onNew={props.onNewSurface} />
}

const browserDescriptor: SurfaceDescriptor = { id: 'browser', title: 'Browser', description: 'Open a local app or URL.', icon: 'globe' }
const terminalDescriptor: SurfaceDescriptor = { id: 'terminal', title: 'Terminal', description: 'Start a shell in this workspace.', icon: 'terminal' }

function BrowserSurface(props: WorkbenchSurfaceProps) {
  const service = useOptionalBrowserService()
  if (!service) return <SurfaceFallback {...props} descriptor={browserDescriptor} />
  return <BrowserPanel service={service} {...surfaceChrome(props)} onNewSurface={props.onNewSurface} />
}

function TerminalSurface(props: WorkbenchSurfaceProps) {
  const service = useOptionalTerminalService()
  if (!service) return <SurfaceFallback {...props} descriptor={terminalDescriptor} />
  return (
    <TerminalPanel
      service={service}
      {...surfaceChrome(props)}
      {...(props.appearance ? { appearance: props.appearance } : {})}
      onNewSurface={props.onNewSurface}
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
        {...surfaceChrome(props)}
        {...(props.appearance ? { appearance: props.appearance } : {})}
        onNewSurface={props.onNewSurface}
      />
    )
  }

  return {
    id: 'heddlework.core',
    surfaces: [
      { ...browserDescriptor, order: 10, component: BrowserSurface },
      { ...terminalDescriptor, order: 20, component: TerminalSurface },
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
    return <SurfaceFallback {...props} descriptor={{ id, title, description, icon }} />
  }

  return { id, title, description, icon, order, component: PlaceholderSurface }
}
