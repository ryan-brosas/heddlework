import React from 'react'
import { describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { handleGpuixEvent } from '@gpuix/react'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { colors } from '../src/ui/theme.ts'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

class OverlayTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []

  async start(): Promise<void> { this.emitStatus({ state: 'running', pid: 1 }) }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false } as T
    if (command.type === 'get_messages') return { messages: [
      { role: 'user', content: 'Make extension interactions feel native.' },
      { role: 'assistant', content: 'I am checking the available extension contracts.' },
    ] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { totalMessages: 2 } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'get_commands') return { commands: [
      { name: 'fabric', description: 'Fabric dashboard, settings, and runtime controls', source: 'extension', sourceInfo: {} },
      { name: 'ledger', description: 'Show running billable totals', source: 'extension', sourceInfo: {} },
      { name: 'ledger-settings', description: 'Configure billing and receipt behavior', source: 'extension', sourceInfo: {} },
      { name: 'skill:brave-search', description: 'Search the web with Brave', source: 'skill', sourceInfo: {} },
    ] } as T
    return undefined as T
  }
  send(record: RpcRecord): void { this.sent.push(record) }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }
  getStderr(): string { return '' }
  emit(event: RpcRecord): void { for (const listener of this.events) listener(event) }
  emitStatus(status: TransportStatus): void { for (const listener of this.statuses) listener(status) }
}

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const screenshotDirectory = resolve(import.meta.dir, '../screenshots')

function screenshotPath(name: string): string {
  mkdirSync(screenshotDirectory, { recursive: true })
  return resolve(screenshotDirectory, name)
}

async function openOverlayWorkbench(options: { workspace?: string; window?: { width: number; height: number } } = {}) {
  const transport = new OverlayTransport()
  const controller = new WorkbenchController(transport, options.workspace ?? '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
  const root = createTestRoot(options.window)
  root.render(React.createElement(WorkbenchApp, { controller, presenters: new Map(), ui: createTestUiRegistry(controller) }))
  await controller.start()
  const automation = await connectTest(root.renderer)
  return { transport, controller, root, automation }
}

describeNative('conversation extension overlays', () => {
  it('shows extension statuses and command discovery above the composer', async () => {
    const { transport, controller, root, automation } = await openOverlayWorkbench()
    try {
      transport.emit({ type: 'extension_ui_request', id: 'ledger-status', method: 'setStatus', statusKey: 'ledger', statusText: '\u001b[32m$18.40 · agent 0.7h · human 0.4h\u001b[0m' })
      transport.emit({ type: 'extension_ui_request', id: 'below-widget', method: 'setWidget', widgetKey: 'ledger-detail', widgetLines: ['Below-editor ledger detail'], widgetPlacement: 'belowEditor' })
      transport.emit({ type: 'extension_ui_request', id: 'fabric-status', method: 'setStatus', statusKey: 'fabric', statusText: '2 agents · 1 approval pending' })
      transport.emit({ type: 'extension_ui_request', id: 'above-widget', method: 'setWidget', widgetKey: 'fabric-activity', widgetLines: ['Above-editor Fabric activity'], widgetPlacement: 'aboveEditor' })
      transport.emit({ type: 'extension_ui_request', id: 'mesh-status', method: 'setStatus', statusKey: 'mesh', statusText: '12 peers · synchronized' })
      controller.setEditorText('/led')
      await Bun.sleep(380)
      root.renderer.flush()

      expect(await automation.getByTestId('extension-surface-rail').count()).toBe(1)
      expect(await automation.getByTestId('command-palette').count()).toBe(1)
      const rail = root.renderer.findByTestId('extension-surface-rail')!
      expect(rail.style.overflowX).toBe('scroll')
      expect(rail.style.overflowY).toBe('hidden')
      expect(root.renderer.findByTestId('command-palette')?.style.marginBottom).toBe(rail.style.paddingBottom)
      expect(rail.style.paddingBottom).toBe(6)
      const orderedSurfaceIds = root.renderer.findByType('div')
        .map((node) => node.testId)
        .filter((testId) => testId?.startsWith('extension-widget-') || testId?.startsWith('extension-status-'))
      expect(orderedSurfaceIds).toEqual([
        'extension-widget-above-fabric-activity',
        'extension-widget-below-ledger-detail',
        'extension-status-ledger',
        'extension-status-fabric',
        'extension-status-mesh',
      ])
      const surfaceMotion = (testId: string) => root.renderer.findByTestId(testId)?.customProps?.motion as { initial?: { opacity?: number; top?: number }; animate?: { opacity?: number; top?: number }; transition?: { delay?: number } } | undefined
      const motionDelay = (testId: string) => surfaceMotion(testId)?.transition?.delay ?? -1
      expect(surfaceMotion('extension-widget-above-fabric-activity')?.initial).toEqual({ opacity: 0, top: 4 })
      expect(surfaceMotion('extension-widget-above-fabric-activity')?.animate).toEqual({ opacity: 1, top: 0 })
      expect(motionDelay('extension-widget-above-fabric-activity')).toBe(0)
      expect(motionDelay('extension-widget-below-ledger-detail')).toBeGreaterThan(motionDelay('extension-widget-above-fabric-activity'))
      expect(motionDelay('extension-status-ledger')).toBeGreaterThan(motionDelay('extension-widget-below-ledger-detail'))
      root.renderer.scrollTo(rail.id, -10_000, 0)
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(rail.id)?.[0] ?? 0).toBeLessThan(0)
      root.renderer.scrollTo(rail.id, 0, 0)
      root.renderer.flush()
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-extension-status-commands.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }
      await automation.getByTestId('command-option-ledger').click()
      expect(controller.getSnapshot().editorText).toBe('/ledger ')
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })

  it('tab-completes the active slash command without inserting a tab character', async () => {
    const { transport, controller, root, automation } = await openOverlayWorkbench()
    try {
      await automation.getByTestId('composer').click()
      await automation.getByTestId('composer').fill('/led')
      root.renderer.flush()
      expect(await automation.getByTestId('command-palette').count()).toBe(1)
      expect(await automation.getByTestId('command-option-ledger').count()).toBe(1)

      expect(await automation.getByTestId('slash-tab-catcher').count()).toBe(1)
      await automation.getByTestId('composer').press('tab')
      root.renderer.flush()
      if (controller.getSnapshot().editorText === '/led') {
        const catcherId = root.renderer.findByTestId('slash-tab-catcher')!.id
        handleGpuixEvent({ elementId: catcherId, eventType: 'focus' }, root.renderer)
        root.renderer.flush()
      }
      expect(controller.getSnapshot().editorText).toBe('/ledger ')
      expect(controller.getSnapshot().editorText).not.toContain('\t')
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })

  it('keeps conversation actions above persistent extension statuses', async () => {
    const { transport, controller, root, automation } = await openOverlayWorkbench({ workspace: '/tmp/status-spacing', window: { width: 1_280, height: 800 } })
    try {
      await Bun.sleep(30)
      root.renderer.flush()
      const baseSpacerHeight = (await automation.getByTestId('composer-spacer').bounds()).height
      transport.emit({ type: 'extension_ui_request', id: 'fabric-status', method: 'setStatus', statusKey: 'fabric', statusText: '2 agents · 1 approval pending' })
      await Bun.sleep(30)
      root.renderer.flush()

      const enteringSpacerHeight = (await automation.getByTestId('composer-spacer').bounds()).height
      expect(enteringSpacerHeight).toBeGreaterThan(baseSpacerHeight)
      expect(enteringSpacerHeight).toBeLessThan(baseSpacerHeight + 35)
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect((await automation.getByTestId('composer-spacer').bounds()).height).toBeCloseTo(baseSpacerHeight + 35, 0)
      const railBounds = await automation.getByTestId('extension-surface-rail').bounds()
      const conversationBottom = Math.max(...(await automation.getByTestId('message-footer').all()).flatMap((footer) => {
        const bounds = footer.bounds
        return bounds ? [bounds.y + bounds.height] : []
      }))
      expect(conversationBottom).toBeLessThanOrEqual(railBounds.y)

      transport.emit({ type: 'extension_ui_request', id: 'fabric-status-clear', method: 'setStatus', statusKey: 'fabric', statusText: '' })
      await Bun.sleep(30)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-surface-rail').count()).toBe(0)
      const exitingSpacerHeight = (await automation.getByTestId('composer-spacer').bounds()).height
      expect(exitingSpacerHeight).toBeGreaterThan(baseSpacerHeight)
      expect(exitingSpacerHeight).toBeLessThan(baseSpacerHeight + 35)
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect((await automation.getByTestId('composer-spacer').bounds()).height).toBeCloseTo(baseSpacerHeight, 0)
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })

  it('renders nested Fabric settings as static searchable rows in the main conversation area', async () => {
    const { transport, controller, root, automation } = await openOverlayWorkbench()
    try {
      transport.emit({ type: 'extension_ui_request', id: 'fabric-settings', method: 'select', title: 'Fabric settings\nEditing: Project overrides (.pi/fabric.json)', options: [
        'Full code mode · true — Fabric owns Pi core tools through fabric_exec.',
        'Executor · quickjs · 2m — Runtime and resource limits for fabric_exec programs.',
        'Approvals · ask — Per-action approval policy.',
        'MCP · enabled — Model Context Protocol provider discovery and invocation.',
        'Prewalk · in-place · Ask each time — Continue Main or hand off to a child trajectory.',
        'Agents · pi · Inherit · Medium — One-shot child agents spawned from fabric_exec.',
        'Capture · enabled — Registered tool capture and model visibility policy.',
        'UI · auto — Fabric activity widget and dashboard.',
        'Compaction · fabric — Compaction engine used at session boundaries.',
        'Retention · 6h · 1d · 7d — Cleanup for inactive Fabric run artifacts.',
        'Mesh · enabled — Durable mesh coordination store and actors.',
        'Code previews · auto — Core tool previews, diffs, and syntax highlighting.',
        'Switch save scope · Global defaults',
        'Done',
      ] })
      await Bun.sleep(30)
      root.renderer.flush()

      expect(await automation.getByTestId('conversation-extension-overlay').count()).toBe(1)
      expect(await automation.getByTestId('extension-dialog-search').count()).toBe(1)
      expect(await automation.getByTestId('extension-dialog-options').count()).toBe(1)
      expect(root.renderer.findByTestId('extension-dialog-transition')?.customProps?.motion).toBeUndefined()
      expect(root.renderer.findByTestId('extension-dialog-options')?.customProps?.motion).toBeUndefined()
      expect(root.renderer.findByTestId('extension-dialog-option-0')?.style.borderBottomWidth).toBe(0)
      expect(root.renderer.findByTestId('extension-dialog-option-1')?.style.borderBottomWidth).toBe(0)
      expect((root.renderer.findByTestId('extension-dialog-option-0')?.style.hover as { backgroundColor?: string } | undefined)?.backgroundColor).toBe(colors.sidebarHover)
      const searchFrameBounds = await automation.getByTestId('extension-dialog-search-frame').bounds()
      const searchBounds = await automation.getByTestId('extension-dialog-search').bounds()
      expect(root.renderer.findByTestId('extension-dialog-search-frame')?.style.height).toBe(34)
      expect(root.renderer.findByTestId('extension-dialog-search')?.style.height).toBe(28)
      expect(searchFrameBounds.height).toBeGreaterThan(searchBounds.height)
      expect(Math.abs(searchBounds.y + searchBounds.height / 2 - (searchFrameBounds.y + searchFrameBounds.height / 2))).toBeLessThanOrEqual(1)
      const dialogElementId = root.renderer.findByTestId('extension-dialog')!.id
      const searchElementId = root.renderer.findByTestId('extension-dialog-search')!.id
      const optionsElementId = root.renderer.findByTestId('extension-dialog-options')!.id
      await automation.getByTestId('extension-dialog-option-0').hover()
      await Bun.sleep(20)
      root.renderer.flush()
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-fabric-settings-overlay.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }
      await automation.getByTestId('extension-dialog-search').fill('activity widget')
      await Bun.sleep(20)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-dialog-option-label-0').textContent()).toBe('UI')
      await automation.getByTestId('extension-dialog-option-0').click()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-dialog').count()).toBe(0)
      expect(await automation.getByTestId('conversation-extension-overlay').count()).toBe(0)
      transport.emit({ type: 'extension_ui_request', id: 'fabric-settings-ui', method: 'select', title: 'Fabric settings › UI\nFabric activity widget and dashboard.', options: [
        'Enabled · true — Render Fabric UI surfaces.',
        'Widget · auto — Show activity automatically, always, or keep it hidden.',
        'Tool display · compact — Use full nested cards or a compact summary.',
        'Agent tool preview · true — Show nested tool previews from child agents.',
        'Update debounce · 100ms — Coalesce live card updates.',
        'Max rows · 6 — Maximum rows rendered by the activity widget.',
        'Refresh interval · 250ms — Refresh interval for the activity widget.',
        'Event history · 80 — Mesh events retained in the dashboard.',
        '← Back',
      ] })
      await Bun.sleep(20)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-dialog-search').count()).toBe(1)
      expect(root.renderer.findByTestId('extension-dialog')?.id).not.toBe(dialogElementId)
      expect(root.renderer.findByTestId('extension-dialog-search')?.id).not.toBe(searchElementId)
      expect(root.renderer.findByTestId('extension-dialog-options')?.id).not.toBe(optionsElementId)
      expect(root.renderer.findByTestId('extension-dialog-option-0')?.style.borderBottomWidth).toBe(0)
      expect(root.renderer.findByTestId('extension-dialog-transition')?.customProps?.motion).toBeUndefined()
      expect(root.renderer.findByTestId('extension-dialog-options')?.customProps?.motion).toBeUndefined()
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-fabric-settings-nested.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }
      controller.respondToDialog({ cancelled: true })
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })

  it('renders and iterates the ask-user questionnaire, review, and collapsed states', async () => {
    const { transport, controller, root, automation } = await openOverlayWorkbench()
    try {
      transport.emit({ type: 'agent_start' })
      transport.emit({
        type: 'tool_execution_start',
        toolCallId: 'ask-overlay',
        toolName: 'ask_user_question',
        args: { questions: [
          {
            question: 'Which conversation layout should we use?',
            header: 'Layout',
            options: [
              { label: 'Focused card (Recommended)', description: 'Keep the decision centered over the conversation.', preview: '# Focused card\n\n```text\nConversation\n┌──────────────────┐\n│ Decision overlay │\n└──────────────────┘\nComposer\n```' },
              { label: 'Inline panel', description: 'Insert the decision between transcript messages.', preview: '# Inline panel\n\nThe question becomes part of the scrolling transcript.' },
            ],
          },
          {
            question: 'Which interaction details should be retained?',
            header: 'Details',
            multiSelect: true,
            options: [
              { label: 'Tabs', description: 'Move between grouped questions.' },
              { label: 'Preview pane', description: 'Compare authored Markdown previews.' },
              { label: 'Collapse', description: 'Hide and reopen while the agent waits.' },
            ],
          },
        ] },
      })
      transport.emit({ type: 'extension_ui_request', id: 'ask-first', method: 'select', title: '[Layout] Which conversation layout should we use?', options: ['1. Focused card (Recommended) — Keep the decision centered over the conversation.', '2. Inline panel — Insert the decision between transcript messages.', '3. Type something.'] })
      await Bun.sleep(30)
      root.renderer.flush()

      expect(await automation.getByTestId('ask-user-overlay').count()).toBe(1)
      expect(await automation.getByTestId('ask-user-preview').count()).toBe(1)
      expect(root.renderer.findByTestId('conversation-extension-overlay')?.customProps?.motion).toBeUndefined()
      expect(root.renderer.findByTestId('ask-user-overlay')?.customProps?.motion).toBeUndefined()
      const conversationBounds = await automation.getByTestId('conversation-body').bounds()
      const overlayBounds = await automation.getByTestId('conversation-extension-overlay').bounds()
      expect(Math.abs(overlayBounds.x - conversationBounds.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(overlayBounds.y - conversationBounds.y)).toBeLessThanOrEqual(1)
      expect(Math.abs(overlayBounds.width - conversationBounds.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(overlayBounds.height - conversationBounds.height)).toBeLessThanOrEqual(1)
      expect(root.renderer.findByTestId('conversation-extension-overlay')?.style.backgroundColor).toBe(colors.background)
      expect(root.renderer.findByTestId('ask-user-option-0')?.style.borderBottomWidth).toBe(0)
      expect(root.renderer.findByTestId('ask-user-option-0')?.style.borderRadius).toBe(8)
      expect((root.renderer.findByTestId('ask-user-option-0')?.style.hover as { backgroundColor?: string } | undefined)?.backgroundColor).toBe(colors.sidebarHover)
      expect(root.renderer.findByTestId('ask-user-custom-option')?.style.borderBottomWidth).toBe(0)
      await automation.getByTestId('ask-user-option-0').hover()
      await Bun.sleep(20)
      root.renderer.flush()
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-ask-user-questionnaire.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }

      await automation.getByTestId('ask-user-option-0').click()
      await automation.getByTestId('ask-user-tab-1').click()
      await automation.getByTestId('ask-user-option-0').click()
      await automation.getByTestId('ask-user-option-2').click()
      await automation.getByTestId('ask-user-tab-submit').click()
      await Bun.sleep(20)
      root.renderer.flush()
      expect(await automation.getByTestId('ask-user-review').count()).toBe(1)
      expect(root.renderer.findByTestId('ask-user-review-0')?.style.borderBottomWidth).toBe(0)
      expect((root.renderer.findByTestId('ask-user-review-0')?.style.hover as { backgroundColor?: string } | undefined)?.backgroundColor).toBe(colors.sidebarHover)
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-ask-user-review.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }

      await automation.getByTestId('ask-user-review-0').click()
      const spacerHeightBeforeCollapse = (await automation.getByTestId('composer-spacer').bounds()).height
      await automation.getByTestId('ask-user-collapse').click()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('ask-user-collapsed').count()).toBe(1)
      const growingSpacerHeight = (await automation.getByTestId('composer-spacer').bounds()).height
      expect(growingSpacerHeight).toBeGreaterThan(spacerHeightBeforeCollapse)
      expect(growingSpacerHeight).toBeLessThan(spacerHeightBeforeCollapse + 53)
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect((await automation.getByTestId('composer-spacer').bounds()).height).toBeCloseTo(spacerHeightBeforeCollapse + 53, 0)
      const dockBounds = await automation.getByTestId('ask-user-collapsed').bounds()
      const conversationRows = [
        ...await automation.getByTestId('assistant-message').all(),
        ...await automation.getByTestId('execution-trace').all(),
        ...await automation.getByTestId('tool-row').all(),
      ]
      const conversationBottom = Math.max(...conversationRows.flatMap((row) => {
        const bounds = row.bounds
        return bounds ? [bounds.y + bounds.height] : []
      }))
      expect(conversationBottom).toBeLessThanOrEqual(dockBounds.y)
      if (process.platform === 'darwin') {
        const screenshot = screenshotPath('workbench-ask-user-collapsed.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }
      await automation.getByTestId('ask-user-reopen').click()
      controller.cancelAskUserQuestionnaire('ask-overlay')
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })
})
