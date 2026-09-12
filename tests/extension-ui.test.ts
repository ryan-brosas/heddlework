import React from 'react'
import { describe, expect, it, jest } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { TRANSIENT_NOTICE_TTL_MS } from '../src/workbench/dialog-coordinator.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { colors } from '../src/ui/theme.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

class ManualTransport implements AgentTransport {
  constructor(readonly initialMessages: PiMessage[] = []) {}

  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []

  async start(): Promise<void> {
    this.emitStatus({ state: 'running', pid: 1 })
  }

  async stop(): Promise<void> {
    this.emitStatus({ state: 'stopped' })
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false } as T
    if (command.type === 'get_messages') return { messages: this.initialMessages } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { totalMessages: 0 } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'get_commands') return { commands: [{ name: 'ledger', description: 'Show ledger', source: 'extension', sourceInfo: {} }] } as T
    if (command.type === 'new_session') return { cancelled: false } as T
    return undefined as T
  }

  send(record: RpcRecord): void {
    this.sent.push(record)
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener)
    return () => this.statuses.delete(listener)
  }

  getStderr(): string {
    return ''
  }

  emit(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }

  emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

describe('Pi extension UI projection', () => {
  it('projects fire-and-forget surfaces and responds to dialogs', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({ type: 'extension_ui_request', id: 'notify-1', method: 'notify', message: 'Heads up', notifyType: 'warning' })
      transport.emit({ type: 'extension_ui_request', id: 'status-1', method: 'setStatus', statusKey: 'tests', statusText: 'Running tests' })
      transport.emit({
        type: 'extension_ui_request',
        id: 'widget-1',
        method: 'setWidget',
        widgetKey: 'todo',
        widgetLines: ['One remaining task'],
        widgetPlacement: 'aboveEditor',
      })
      transport.emit({ type: 'extension_ui_request', id: 'title-1', method: 'setTitle', title: 'Pi · test session' })
      transport.emit({ type: 'extension_ui_request', id: 'editor-1', method: 'set_editor_text', text: 'prefilled prompt' })
      transport.emit({
        type: 'extension_ui_request',
        id: 'select-1',
        method: 'select',
        title: 'Choose',
        options: ['Allow', 'Block'],
      })

      const state = controller.getSnapshot()
      expect(state.notices.at(-1)).toMatchObject({ kind: 'warning', message: 'Heads up' })
      expect(state.statusItems.tests).toBe('Running tests')
      expect(state.widgets.todo?.lines).toEqual(['One remaining task'])
      expect(state.windowTitle).toBe('Pi · test session')
      expect(state.editorText).toBe('prefilled prompt')
      expect(state.commands.find((command) => command.name === 'compact')).toMatchObject({ source: 'builtin' })
      expect(state.commands.find((command) => command.name === 'ledger')).toEqual({ name: 'ledger', description: 'Show ledger', source: 'extension', sourceInfo: {} })
      expect(state.dialog).toMatchObject({ id: 'select-1', method: 'select', options: ['Allow', 'Block'] })

      controller.respondToDialog({ value: 'Allow' })
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'select-1', value: 'Allow' })
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().notices).toHaveLength(1)
    } finally {
      await controller.dispose()
    }
  })

  it('keeps info banners transient and expires them while warnings stay durable', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      jest.useFakeTimers()
      transport.emit({ type: 'extension_ui_request', id: 'tps-1', method: 'notify', message: 'TPS 25.6 tok/s', notifyType: 'info' })

      const banner = controller.getSnapshot().notices.at(-1)
      expect(banner).toMatchObject({ kind: 'info', message: 'TPS 25.6 tok/s', transient: true })
      expect(banner?.transcriptPosition).toBeUndefined()
      expect(banner?.transcriptTurn).toBeUndefined()

      transport.emit({ type: 'extension_ui_request', id: 'warning-1', method: 'notify', message: 'Disk almost full', notifyType: 'warning' })
      expect(controller.getSnapshot().notices.at(-1)).toMatchObject({ kind: 'warning', message: 'Disk almost full' })

      jest.advanceTimersByTime(TRANSIENT_NOTICE_TTL_MS + 1)
      jest.useRealTimers()

      expect(controller.getSnapshot().notices.map((notice) => notice.message)).toEqual(['Disk almost full'])
    } finally {
      jest.useRealTimers()
      await controller.dispose()
    }
  })

  it('dismisses ledger engagement prompts outside an active conversation', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({
        type: 'extension_ui_request',
        id: 'draft-ledger',
        method: 'select',
        title: '⏱ Extend billable human time? Idle after the agent. Add a 20m pomodoro block?',
        options: ['Extend +20m', 'Stop billing'],
      })
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(transport.sent.at(-1)).toEqual({ type: 'extension_ui_response', id: 'draft-ledger', cancelled: true })
    } finally {
      await controller.dispose()
    }
  })

  it('queues concurrent dialogs and promotes the next response target', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({ type: 'extension_ui_request', id: 'first', method: 'select', title: 'First', options: ['One'] })
      transport.emit({ type: 'extension_ui_request', id: 'second', method: 'input', title: 'Second' })

      expect(controller.getSnapshot().dialog?.id).toBe('first')
      expect(controller.getSnapshot().dialogQueue.map((dialog) => dialog.id)).toEqual(['second'])
      controller.respondToDialog({ value: 'One' })
      expect(controller.getSnapshot().dialog?.id).toBe('second')
      expect(controller.getSnapshot().dialogQueue).toEqual([])
      controller.respondToDialog({ value: 'two' })
      expect(transport.sent.slice(-2)).toEqual([
        { type: 'extension_ui_response', id: 'first', value: 'One' },
        { type: 'extension_ui_response', id: 'second', value: 'two' },
      ])
    } finally {
      await controller.dispose()
    }
  })

  it('expires queued dialogs independently', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({ type: 'extension_ui_request', id: 'lasting', method: 'select', title: 'Lasting', options: ['Keep'] })
      transport.emit({ type: 'extension_ui_request', id: 'expiring', method: 'select', title: 'Expiring', options: ['Drop'], timeout: 5 })
      await Bun.sleep(70)
      expect(controller.getSnapshot().dialog?.id).toBe('lasting')
      expect(controller.getSnapshot().dialogQueue).toEqual([])
      expect(transport.sent.some((record) => record.id === 'expiring')).toBe(false)
    } finally {
      await controller.dispose()
    }
  })

  it('drives a complete ask-user fallback from one native submission', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({
        type: 'tool_execution_start',
        toolCallId: 'ask-1',
        toolName: 'ask_user_question',
        args: { questions: [
          { question: 'Which runtime?', header: 'Runtime', options: [{ label: 'Bun', description: 'Fast' }, { label: 'Node', description: 'Compatible' }] },
          { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Types', description: 'Typecheck' }, { label: 'Tests', description: 'Tests' }, { label: 'Build', description: 'Build' }] },
        ] },
      })
      transport.emit({ type: 'extension_ui_request', id: 'ask-select', method: 'select', title: '[Runtime] Which runtime?', options: ['1. Bun — Fast', '2. Node — Compatible', '3. Type something.'] })

      controller.setAskUserQuestionnaireCollapsed('ask-1', true)
      expect(controller.getSnapshot().questionnaireCollapsed).toBe('ask-1')

      controller.submitAskUserQuestionnaire('ask-1', [
        { kind: 'option', optionIndex: 1 },
        { kind: 'multi', optionIndices: [0, 2] },
      ])
      expect(transport.sent.at(-1)).toEqual({ type: 'extension_ui_response', id: 'ask-select', value: '2. Node — Compatible' })
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().questionnaireSubmitting).toBe('ask-1')
      expect(controller.getSnapshot().questionnaireCollapsed).toBeUndefined()

      transport.emit({ type: 'extension_ui_request', id: 'ask-input', method: 'input', title: '[Checks] Which checks?' })
      expect(transport.sent.at(-1)).toEqual({ type: 'extension_ui_response', id: 'ask-input', value: '1,3' })
      expect(controller.getSnapshot().dialog).toBeUndefined()

      transport.emit({ type: 'tool_execution_end', toolCallId: 'ask-1', toolName: 'ask_user_question', result: { content: [], details: { answers: [], cancelled: false } } })
      expect(controller.getSnapshot().questionnaireSubmitting).toBeUndefined()
    } finally {
      await controller.dispose()
    }
  })

  it('cancels active and queued dialogs when a new session begins', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({
        type: 'extension_ui_request',
        id: 'stale-dialog',
        method: 'select',
        title: 'Old session action',
        options: ['Continue'],
      })
      transport.emit({ type: 'extension_ui_request', id: 'queued-dialog', method: 'input', title: 'Also stale' })
      transport.emit({ type: 'extension_ui_request', id: 'old-notice', method: 'notify', message: 'Old session notice' })
      expect(controller.getSnapshot().dialog?.id).toBe('stale-dialog')
      expect(controller.getSnapshot().notices).toHaveLength(1)
      expect(controller.getSnapshot().dialogQueue).toHaveLength(1)

      const creatingSession = controller.newSession()
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'stale-dialog', cancelled: true })
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'queued-dialog', cancelled: true })
      await creatingSession

      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().notices).toHaveLength(0)
    } finally {
      await controller.dispose()
    }
  })

  it('withdraws pending dialog effects when the controller is disposed', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({ type: 'extension_ui_request', id: 'active-on-dispose', method: 'select', title: 'Active', options: ['Continue'], timeout: 5_000 })
      transport.emit({ type: 'extension_ui_request', id: 'queued-on-dispose', method: 'input', title: 'Queued', timeout: 5_000 })

      await controller.dispose()

      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().dialogQueue).toEqual([])
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'active-on-dispose', cancelled: true })
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'queued-on-dispose', cancelled: true })
      expect(transport.events.size).toBe(0)
      expect(transport.statuses.size).toBe(0)
    } finally {
      await controller.dispose()
    }
  })
})

class TreeTransport extends ManualTransport {
  constructor(readonly treeResponse: unknown) {
    super()
  }

  override async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_tree') return this.treeResponse as T
    return super.request<T>(command)
  }
}

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('Pi extension conversation overlay', () => {

  it('renders a ten-thousand-branch session as compact connected virtual rows', async () => {
    const branchCount = 10_000
    const treeResponse = {
      leafId: `branch-${branchCount - 1}`,
      tree: [{
        entry: { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Root prompt' } },
        children: Array.from({ length: branchCount }, (_, index) => ({
          entry: { type: 'message', id: `branch-${index}`, parentId: 'root', message: { role: 'assistant', content: `Branch ${index}` } },
          children: [],
          ...(index === 42 ? { label: 'checkpoint', labelTimestamp: '2026-08-30T10:15:00.000Z' } : {}),
        })),
      }],
    }
    const controller = new WorkbenchController(new TreeTransport(treeResponse), '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    const root = createTestRoot({ width: 1_000, height: 700 })
    root.render(React.createElement(WorkbenchApp, { controller, presenters: new Map(), ui: createTestUiRegistry(controller) }))
    await controller.start()
    const automation = await connectTest(root.renderer)
    try {
      const startedAt = performance.now()
      await controller.openSessionTree()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(performance.now() - startedAt).toBeLessThan(2_500)

      const list = root.renderer.findByTestId('session-tree-list')!
      expect(list.type).toBe('virtual-list')
      expect(list.customProps?.alignment).toBe('bottom')
      expect(list.customProps?.estimatedItemHeight).toBe(32)
      expect(await automation.getByTestId('session-tree-active').textContent()).toBe('ACTIVE')

      const activeRow = root.renderer.findByTestId(`session-tree-row-${branchCount}`)!
      const activeRail = root.renderer.findByTestId(`session-tree-rail-${branchCount}`)!
      expect(activeRow.style.height).toBe(32)
      expect(activeRail.style.width).toBe(36)
      expect(root.renderer.findByTestId(`session-tree-detail-${branchCount}`)?.style.whiteSpace).toBe('nowrap')
      expect(await automation.getByTestId('session-tree-controls').count()).toBe(1)
      expect(await automation.getByTestId('session-tree-status').textContent()).toContain('Default')
      expect(root.renderer.findByTestId('extension-dialog-transition')?.customProps?.motion).toBeUndefined()
      expect(root.renderer.findByTestId('extension-dialog-options')?.customProps?.motion).toBeUndefined()

      await automation.getByTestId('session-tree-cycle-next').click()
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-status').textContent()).toContain('No tools')
      await automation.getByTestId('session-tree-cycle-previous').click()
      await automation.getByTestId('session-tree-filter-labeled-only').click()
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-label-0').textContent()).toBe('[checkpoint]')
      await automation.getByTestId('session-tree-label-time').click()
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-label-time-0').count()).toBe(1)
      await automation.getByTestId('extension-dialog-search').press('ctrl-u')
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-kind-0').textContent()).toBe('user')
      await automation.getByTestId('session-tree-filter-assistant-only').click()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(await automation.getByTestId(`session-tree-kind-${branchCount - 1}`).textContent()).toBe('assistant')
      expect(await automation.getByTestId('session-tree-status').textContent()).toContain('Assistant')
      await automation.getByTestId('extension-dialog-search').press('ctrl-d')
      await Bun.sleep(25)
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-active').count()).toBe(1)

      await automation.getByTestId('extension-dialog-search').fill('Branch 42')
      root.renderer.flush()
      expect(await automation.getByText('Branch 42').count()).toBeGreaterThan(0)
      await automation.getByTestId('extension-dialog-search').fill('no-entry-can-match-this')
      root.renderer.flush()
      expect(root.renderer.getPaintedText()).toContain('No entries match this search and view.')
      await automation.getByTestId('extension-dialog-search').fill('')
      await Bun.sleep(25)
      root.renderer.flush()
      expect(await automation.getByTestId('session-tree-active').count()).toBe(1)
      const restoredActiveBounds = await automation.getByTestId('session-tree-active').bounds()
      const restoredListBounds = await automation.getByTestId('extension-dialog-options').bounds()
      expect(restoredActiveBounds.y).toBeGreaterThanOrEqual(restoredListBounds.y)
      expect(restoredActiveBounds.y + restoredActiveBounds.height).toBeLessThanOrEqual(restoredListBounds.y + restoredListBounds.height + 1)

      const restoredList = root.renderer.findByTestId('session-tree-list')!
      root.renderer.scrollToItem(restoredList.id, 0)
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(root.renderer.findByTestId('session-tree-row-0')).toBeDefined()
      expect(root.renderer.findByTestId(`session-tree-row-${branchCount}`)).toBeUndefined()
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  }, 10_000)

  it('wraps a long title inside the main conversation area', async () => {
    const transport = new ManualTransport([
      { role: 'user', content: 'Review the active session.' },
      { role: 'assistant', content: 'The session is ready.' },
    ])
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    const root = createTestRoot()
    root.render(React.createElement(WorkbenchApp, { controller, presenters: new Map(), ui: createTestUiRegistry(controller) }))
    await controller.start()
    const automation = await connectTest(root.renderer)
    try {
      transport.emit({
        type: 'extension_ui_request',
        id: 'long-dialog',
        method: 'select',
        title: '⏱ Extend billable human time? Idle after the agent. Add a 20m pomodoro block? · 27m still provisioned — extending adds more.',
        options: ['Extend +20m', 'Stop billing'],
      })
      await Bun.sleep(25)
      root.renderer.flush()

      const panelBounds = await automation.getByTestId('extension-dialog').bounds()
      const markerBounds = await automation.getByTestId('extension-dialog-marker').bounds()
      const titleBounds = await automation.getByTestId('extension-dialog-title').bounds()
      expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width - 12)
      expect(titleBounds.height).toBeGreaterThan(17)
      expect(titleBounds.x - (markerBounds.x + markerBounds.width)).toBeLessThanOrEqual(12)
      const firstOptionStyle = root.renderer.findByTestId('extension-dialog-option-0')?.style
      const secondOptionStyle = root.renderer.findByTestId('extension-dialog-option-1')?.style
      expect(firstOptionStyle?.borderBottomWidth).toBe(0)
      expect(secondOptionStyle?.borderBottomWidth).toBe(0)
      expect(firstOptionStyle?.borderRadius).toBe(8)
      expect((firstOptionStyle?.hover as { backgroundColor?: string } | undefined)?.backgroundColor).toBe(colors.sidebarHover)
      await automation.getByTestId('extension-dialog-option-0').hover()
      await Bun.sleep(20)
      root.renderer.flush()

      if (process.platform === 'darwin') {
        const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
        mkdirSync(screenshotDirectory, { recursive: true })
        const screenshot = resolve(screenshotDirectory, 'workbench-extension-dialog.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }

      await automation.getByTestId('sidebar-new-thread').click()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-dialog').count()).toBe(0)
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'long-dialog', cancelled: true })
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })
})
