import React from 'react'
import { rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { FlowRuntime } from '../src/flows/runtime.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { FlowsView } from '../src/ui/flows-view.tsx'
import { FlowRail } from '../src/ui/flow-rail.tsx'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from '../src/ui/responsive.tsx'
import { colors } from '../src/ui/theme.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { createTestUiRegistry, expectScrollWheelLatency, testControllerDependencies } from './helpers/workbench.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

async function renderFlowsView(session: PiSessionSummary) {
  const state = { ...createInitialState('/tmp'), connection: 'connected' as const, sessions: [session] }
  const controller = new WorkbenchController(new DemoTransport(), '/tmp', testControllerDependencies())
  const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
  const root = createTestRoot({ width: 1_352, height: 760 })
  root.render(
    <ResponsiveLayoutProvider layout={resolveResponsiveLayout(1_352)}>
      <div style={{ width: 1_352, height: 760, display: 'flex', flexDirection: 'row' }}>
        <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={() => undefined} onOpenSession={() => undefined} />
      </div>
    </ResponsiveLayoutProvider>,
  )
  const automation = await connectTest(root.renderer)
  return { controller, runtime, root, automation }
}

describeNative('Flows surface', () => {
  it('keeps the failed rail marker aligned with the other rail glyphs', async () => {
    const root = createTestRoot({ width: 80, height: 92 })
    root.render(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: colors.background }}><FlowRail status="succeeded" before={false} after /><FlowRail status="failed" before after={false} /></div>)
    const automation = await connectTest(root.renderer)
    try {
      const succeeded = await automation.getByTestId('flow-rail-glyph-succeeded').bounds()
      const failed = await automation.getByTestId('flow-rail-glyph-failed').bounds()
      expect(root.renderer.findByTestId('flow-rail-glyph-failed')?.style.fontSize).toBe(10)
      expect(failed.width).toBeLessThanOrEqual(succeeded.width)
      expect(failed.height).toBeLessThanOrEqual(succeeded.height)
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('opens above Search, projects a chat-authored queue with barriers, and creates a schedule', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-ui', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    runtime.start()
    const root = createTestRoot({ width: 1_180, height: 760 })
    root.render(<WorkbenchApp controller={controller} flows={runtime} presenters={new Map()} ui={createTestUiRegistry(controller)} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      root.renderer.flush()
      const flowsButton = await automation.getByTestId('sidebar-flows').bounds()
      const search = await automation.getByTestId('sidebar-search').bounds()
      expect(flowsButton.y).toBeLessThan(search.y)

      await automation.getByTestId('sidebar-flows').click()
      root.renderer.flush()
      expect(await automation.getByTestId('flows-view').count()).toBe(1)
      expect(await automation.getByTestId('flows-work').count()).toBe(1)

      expect(await automation.getByTestId('flow-intake').count()).toBe(0)
      await automation.getByTestId('flows-queue-in-chat').click()
      await waitFor(() => Boolean(root.renderer.findByTestId('composer')))

      for (const text of ['/new', '/fabric await reviewer', 'Prepare the native release']) {
        await automation.getByTestId('composer').fill(text)
        await automation.getByTestId('composer').press('alt-enter')
        await waitFor(() => controller.getSnapshot().queue.items.some((item) => item.text === text))
      }
      const queued = [...controller.getSnapshot().queue.items]
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().queue.paused).toBe(true)

      await automation.getByTestId('sidebar-flows').click()
      root.renderer.flush()
      for (const item of queued) expect(await automation.getByTestId(`flow-task-${item.id}`).count()).toBe(1)
      expect(root.renderer.getAllText()).toContain('New session')
      expect(root.renderer.getAllText()).toContain('Wait for reviewer')
      expect((await automation.getByTestId('flow-rail-node').all()).length).toBeGreaterThanOrEqual(3)
      expect((await automation.getByTestId('flow-rail-after').all()).length).toBeGreaterThan(0)
      expect((await automation.getByTestId('flow-rail-before').all()).length).toBeGreaterThan(0)
      expect((await automation.getByTestId('flow-rail-link').all()).length).toBeGreaterThanOrEqual(2)
      expect(root.renderer.findByTestId('flows-work-list')?.type).toBe('virtual-list')
      const projectedPrompt = queued.at(-1)!
      const taskBounds = await automation.getByTestId(`flow-task-${projectedPrompt.id}`).bounds()
      const firstRailBounds = (await automation.getByTestId('flow-rail-node').all())[0]!.bounds!
      expect(taskBounds.height).toBeCloseTo(42, 0)
      expect(firstRailBounds.x).toBeGreaterThan(taskBounds.x + taskBounds.width * 0.72)
      await automation.getByTestId(`flow-task-${projectedPrompt.id}`).click()
      root.renderer.flush()
      expect(await automation.getByTestId('flow-task-page').count()).toBe(1)
      expect((await automation.getByTestId('flow-rail').all()).length).toBeGreaterThan(0)
      await automation.getByTestId('flow-cancel-queue').click()
      await waitFor(() => !controller.getSnapshot().queue.items.some((item) => item.id === projectedPrompt.id))
      expect(await automation.getByTestId(`flow-task-${projectedPrompt.id}`).count()).toBe(0)

      await automation.getByTestId('flows-tab-scheduled').click()
      root.renderer.flush()
      await automation.getByTestId('new-schedule').click()
      await automation.getByTestId('flow-title').fill('Daily native audit')
      await automation.getByTestId('flow-prompt-0').fill('Audit native behavior')
      await automation.getByTestId('schedule-create').click()
      root.renderer.flush()
      expect(runtime.getSnapshot().schedules).toHaveLength(1)
      expect(runtime.getSnapshot().schedules[0]).toMatchObject({ title: 'Daily native audit', prompts: ['Audit native behavior'] })
      expect(root.renderer.getPaintedText()).toContain('Daily native audit')
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  }, 10_000)


  it('fans an ordinary active Work row into live Fabric participants and a join', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-live-fabric', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 1_180, height: 760 })
    root.render(<WorkbenchApp controller={controller} flows={runtime} presenters={new Map()} ui={createTestUiRegistry(controller)} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      await controller.submit('/name Live branch graph')
      await controller.submit('Stream the live branch graph')
      const sessionId = controller.getSnapshot().session.sessionId!
      const taskId = `PI-${sessionId.slice(0, 8).toUpperCase()}`
      controller.acceptAgentEvent({ type: 'tool_execution_start', toolCallId: 'live-fabric', toolName: 'fabric_exec', args: { display: { name: 'HW-LIVE-1' }, code: 'workflow.parallel([])' } })
      controller.acceptAgentEvent({
        type: 'tool_execution_update',
        toolCallId: 'live-fabric',
        toolName: 'fabric_exec',
        partialResult: {
          details: {
            audits: [
              { ref: 'agents.run', provider: 'agents', tool: 'run', args: { name: 'HW-LIVE-1/B1' }, preview: { kind: 'fabric-agent-tools', id: 'live-agent-a', name: 'HW-LIVE-1/B1', status: 'running', runner: 'pi', currentTool: 'grep branch graph', tools: [] } },
              { ref: 'agents.run', provider: 'agents', tool: 'run', args: { name: 'HW-LIVE-1/B2' }, preview: { kind: 'fabric-agent-tools', id: 'live-agent-b', name: 'HW-LIVE-1/B2', status: 'running', runner: 'pi', tools: [] } },
            ],
          },
        },
      })
      await automation.getByTestId('sidebar-flows').click()
      await waitFor(() => {
        root.renderer.flush()
        return Boolean(root.renderer.findByTestId('flow-fabric-branch-live-agent-a'))
      })
      expect(await automation.getByTestId(`flow-task-${taskId}`).count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-branch-live-agent-a').count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-branch-live-agent-b').count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-join').count()).toBe(1)
      expect(root.renderer.getAllText()).toContain('grep branch graph')
      expect(root.renderer.getAllText()).toContain('0/2 branches settled')
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('keeps wide project, triage, and automation layouts centered and contained', async () => {
    const sessions: PiSessionSummary[] = [
      visualSession('alpha001-session', '/tmp/project-alpha', 'Alpha task one', 1),
      visualSession('alpha002-session', '/tmp/project-alpha', 'Alpha task two', 2),
      visualSession('beta0001-session', '/tmp/project-beta', 'Beta task one', 3),
      visualSession('beta0002-session', '/tmp/project-beta', 'A long projected title that must wrap inside the details pane without clipping through the task list', 4, '<skill name="localterm" location="/Users/example/a-very-long-path-that-must-remain-inside-the-result-card">'.repeat(12)),
    ]
    sessions[1] = { ...sessions[1]!, parentSession: sessions[0]!.path }
    const state = { ...createInitialState('/tmp/flows-layout'), connection: 'connected' as const, sessions }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-layout', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 1_600, height: 900 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(1_600)}>
        <div style={{ width: 1_600, height: 900, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} titlebarInset={132} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      const viewBounds = await automation.getByTestId('flows-view').bounds()
      const firstTaskBounds = await automation.getByTestId('flow-task-PI-BETA0002').bounds()
      const leftInset = firstTaskBounds.x - viewBounds.x
      const rightInset = viewBounds.x + viewBounds.width - firstTaskBounds.x - firstTaskBounds.width
      expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(30)
      expect(leftInset).toBeGreaterThan(200)

      const betaTail = await automation.getByTestId('flow-task-PI-BETA0001').bounds()
      const alphaHead = await automation.getByTestId('flow-task-PI-ALPHA002').bounds()
      expect(alphaHead.y - betaTail.y - betaTail.height).toBeGreaterThan(30)
      const groupIcon = (await automation.getByTestId('flow-group-icon').all())[0]!.bounds!
      const groupTitle = (await automation.getByTestId('flow-group-title').all())[0]!.bounds!
      expect(Math.abs((groupIcon.y + groupIcon.height / 2) - (groupTitle.y + groupTitle.height / 2))).toBeLessThanOrEqual(2)
      expect(root.renderer.getAllText().join(' ')).not.toContain('Observed Pi session')
      expect(root.renderer.getAllText().join(' ')).not.toContain('observed Pi sessions')
      expect(root.renderer.getAllText()).toContain('Parent session')
      expect(root.renderer.getAllText()).toContain('Child session')

      await automation.getByTestId('flow-task-PI-BETA0002').click()
      root.renderer.flush()
      const back = root.renderer.findByTestId('flow-task-back')!
      const backIcon = root.renderer.getElement(back.children[0]!)!
      expect(decodeURIComponent(String(backIcon.customProps?.src ?? ''))).toContain('m15 18-6-6 6-6')
      await automation.getByTestId('flow-task-back').click()
      await automation.getByTestId('flow-task-PI-ALPHA002').click()
      root.renderer.flush()
      expect(root.renderer.getAllText()).toContain('Blocked by')
      expect(root.renderer.getAllText().join(' ')).toContain('Alpha task one')
      await automation.getByTestId('flow-task-back').click()

      await automation.getByTestId('flows-tab-triage').click()
      root.renderer.flush()
      const triageRows = await automation.getByTestId('triage-task-PI-BETA0002').all()
      expect(triageRows[0]!.bounds!.height).toBeGreaterThanOrEqual(62)
      const detailBounds = await automation.getByTestId('triage-detail').bounds()
      expect(root.renderer.findByTestId('triage-detail-list')?.type).toBe('virtual-list')
      expect(detailBounds.x + detailBounds.width).toBeLessThanOrEqual(viewBounds.x + viewBounds.width + 1)
      const resultCard = await automation.getByTestId('triage-result-card').bounds()
      const resultText = await automation.getByTestId('triage-result-text').bounds()
      expect(resultCard.x).toBeGreaterThanOrEqual(detailBounds.x)
      expect(resultCard.x + resultCard.width).toBeLessThanOrEqual(detailBounds.x + detailBounds.width)
      expect(resultText.x).toBeGreaterThanOrEqual(resultCard.x)
      expect(resultText.x + resultText.width).toBeLessThanOrEqual(resultCard.x + resultCard.width)

      await automation.getByTestId('flows-tab-scheduled').click()
      await automation.getByTestId('new-schedule').click()
      root.renderer.flush()
      const intakeBounds = await automation.getByTestId('schedule-intake').bounds()
      const intakeLeft = intakeBounds.x - viewBounds.x
      const intakeRight = viewBounds.x + viewBounds.width - intakeBounds.x - intakeBounds.width
      expect(Math.abs(intakeLeft - intakeRight)).toBeLessThanOrEqual(34)
      expect(intakeLeft).toBeGreaterThan(200)
      const titleFrame = await automation.getByTestId('flow-title-frame').bounds()
      const titleInput = await automation.getByTestId('flow-title').bounds()
      expect(root.renderer.findByTestId('flow-title-frame')?.style.paddingLeft).toBe(10)
      expect(root.renderer.findByTestId('flow-title')?.style.borderWidth).toBe(0)
      expect(titleInput.x + titleInput.width).toBeLessThanOrEqual(titleFrame.x + titleFrame.width)
      const cadence = await automation.getByTestId('schedule-kind').bounds()
      const scheduleValue = await automation.getByTestId('schedule-value-frame').bounds()
      expect(Math.abs(cadence.y - scheduleValue.y)).toBeLessThanOrEqual(1)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('keeps medium desktop Work spacing aligned and task rows compact', async () => {
    const width = 1_417
    const workspace = '/tmp/flows-medium-spacing'
    const sessions: PiSessionSummary[] = [
      visualSession('medium01-session', workspace, 'First compact task', 1),
      visualSession('medium02-session', workspace, 'Second compact task', 2),
    ]
    const state = { ...createInitialState(workspace), connection: 'connected' as const, sessions }
    const controller = new WorkbenchController(new DemoTransport(), workspace, testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width, height: 900 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(width)}>
        <div style={{ width, height: 900, display: 'flex', flexDirection: 'row' }}>
          <div style={{ width: 256, height: '100%' }} />
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} titlebarInset={24} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      const layout = resolveResponsiveLayout(width)
      const view = await automation.getByTestId('flows-view').bounds()
      const task = await automation.getByTestId('flow-task-PI-MEDIUM02').bounds()
      const toolbarContent = await automation.getByTestId('flows-work-toolbar-content').bounds()
      const search = await automation.getByTestId('flows-search-frame').bounds()
      const workTab = await automation.getByTestId('flows-tab-work').bounds()
      const summary = await automation.getByTestId('flows-summary').bounds()
      const tabs = await automation.getByTestId('flows-tabs').bounds()
      const taskLeftInset = task.x - view.x
      const taskRightInset = view.x + view.width - task.x - task.width
      const summaryClearance = tabs.y - summary.y - summary.height
      const toolbarClearance = toolbarContent.y - tabs.y - tabs.height

      expect(taskLeftInset).toBeGreaterThanOrEqual(layout.contentGutter)
      expect(Math.abs(taskLeftInset - taskRightInset)).toBeLessThanOrEqual(1)
      expect(Math.abs(task.x - toolbarContent.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(search.x - workTab.x)).toBeLessThanOrEqual(1)
      expect(summaryClearance).toBeGreaterThanOrEqual(10)
      expect(Math.abs(summaryClearance - toolbarClearance)).toBeLessThanOrEqual(1)
      expect(task.height).toBeCloseTo(42, 0)
      expect(root.renderer.findByTestId('flow-task-PI-MEDIUM02')?.style.borderBottomWidth ?? 0).toBe(0)
      expect(root.renderer.findByTestId('flow-priority-slot-PI-MEDIUM02')?.style.marginLeft).toBe(10)
      expect(root.renderer.findByTestId('flow-priority-slot-PI-MEDIUM02')?.style.marginRight).toBe(8)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('keeps the Flows title clear of collapsed macOS window chrome', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-chrome', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    runtime.start()
    const root = createTestRoot({ width: 1_180, height: 760 })
    root.render(<WorkbenchApp controller={controller} flows={runtime} presenters={new Map()} ui={createTestUiRegistry(controller)} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      await automation.getByTestId('sidebar-flows').click()
      root.renderer.flush()
      const brandTitle = await automation.getByText('Heddlework').bounds()
      const openFlowsTitle = await automation.getByTestId('flows-title').bounds()
      expect(Math.abs(brandTitle.y - openFlowsTitle.y)).toBeLessThanOrEqual(1)
      await automation.getByTestId('toggle-left-sidebar').click()
      await Bun.sleep(400)
      root.renderer.flush()
      const title = await automation.getByTestId('flows-title').bounds()
      expect(title.x).toBeGreaterThanOrEqual(process.platform === 'darwin' ? 128 : 50)
      expect(root.renderer.findByTestId('flows-title-block')?.style.marginTop).toBe(15)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  }, 10_000)

  it('uses one-line unread Triage rows and a compact detail drill-in with Back', async () => {
    const now = Date.now()
    const sessions: PiSessionSummary[] = [
      {
        id: 'failed01', path: '/tmp/triage/failed.jsonl', cwd: '/tmp/triage', title: 'Failed compact task', firstMessage: 'Inspect failure', messageCount: 2,
        createdAt: now - 20 * 60_000, modifiedAt: now - 2_000, lastAssistantText: 'First preview line\nSecond preview line\nThird preview line', lastAssistantStopReason: 'error',
      },
      {
        id: 'passed01', path: '/tmp/triage/passed.jsonl', cwd: '/tmp/triage', title: 'Succeeded compact task', firstMessage: 'Inspect success', messageCount: 2,
        createdAt: now - 10 * 60_000, modifiedAt: now - 1_000, lastAssistantText: 'One result line', lastAssistantStopReason: 'stop',
      },
    ]
    const state = { ...createInitialState('/tmp/triage'), connection: 'connected' as const, sessions }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/triage', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 889, height: 932 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(889)}>
        <div style={{ width: 889, height: 932, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      await automation.getByTestId('flows-tab-triage').click()
      root.renderer.flush()
      expect(await automation.getByTestId('triage-detail').count()).toBe(0)
      expect(await automation.getByTestId('triage-filter-failed-count-1').count()).toBe(1)
      expect(await automation.getByTestId('triage-filter-unread-count-2').count()).toBe(1)
      expect(await automation.getByTestId('triage-unread-dot').count()).toBe(2)
      const previews = await automation.getByTestId('triage-preview').all()
      expect(previews.every((preview) => !preview.text?.includes('\n'))).toBe(true)
      expect(previews.every((preview) => (preview.bounds?.height ?? 0) <= 14)).toBe(true)
      expect(root.renderer.getAllText()).toContain('First preview line Second preview line Third preview line')
      const triageBounds = await automation.getByTestId('flows-triage').bounds()
      const triageSearchBounds = await automation.getByTestId('triage-search-frame').bounds()
      const succeededFilterBounds = await automation.getByTestId('triage-filter-succeeded').bounds()
      const triageSearchRow = root.renderer.findByTestId('triage-search-row')!
      expect(triageSearchBounds.x - triageBounds.x).toBeGreaterThanOrEqual(9)
      expect(triageSearchRow.style.paddingLeft).toBe(12)
      expect(triageSearchRow.style.paddingRight).toBe(triageSearchRow.style.paddingLeft)
      expect(triageBounds.x + triageBounds.width - succeededFilterBounds.x - succeededFilterBounds.width).toBeGreaterThanOrEqual(7)

      await automation.getByTestId('triage-mark-all-read').click()
      expect(controller.getSnapshot().threadLifecycle['/tmp/triage/failed.jsonl']?.readAt).toBe(now - 2_000)
      expect(controller.getSnapshot().threadLifecycle['/tmp/triage/passed.jsonl']?.readAt).toBe(now - 1_000)

      await automation.getByTestId('triage-task-PI-FAILED01').click()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('triage-detail').count()).toBe(1)
      expect(await automation.getByTestId('triage-back').count()).toBe(1)
      expect(root.renderer.findByTestId('triage-prompt-content')?.style.maxHeight).toBe(90)
      expect(root.renderer.findByTestId('triage-output-content')?.style.maxHeight).toBe(160)
      await automation.getByTestId('triage-prompt-toggle').click()
      await automation.getByTestId('triage-output-toggle').click()
      root.renderer.flush()
      expect(root.renderer.findByTestId('triage-prompt-content')?.style.maxHeight).toBeUndefined()
      expect(root.renderer.findByTestId('triage-output-content')?.style.maxHeight).toBeUndefined()
      expect(controller.getSnapshot().threadLifecycle['/tmp/triage/failed.jsonl']?.readAt).toBe(now - 2_000)
      await automation.getByTestId('triage-back').click()
      root.renderer.flush()
      expect(await automation.getByTestId('flows-triage-list').count()).toBe(1)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('aligns Work search, collapses settled sessions, and edits priority and labels without horizontal detail scroll', async () => {
    const now = Date.now()
    const activePath = '/tmp/metadata/active.jsonl'
    const settledPath = '/tmp/metadata/settled.jsonl'
    const sessions: PiSessionSummary[] = [
      {
        id: 'active01', path: activePath, cwd: '/tmp/metadata', title: 'Active labeled task', firstMessage: 'Inspect active metadata', messageCount: 2,
        createdAt: now - 45 * 60_000, modifiedAt: now - 1_000, lastAssistantText: 'Active result', lastAssistantStopReason: 'stop',
      },
      {
        id: 'settled1', path: settledPath, cwd: '/tmp/metadata', title: 'Old settled task', firstMessage: 'Inspect settled metadata', messageCount: 2,
        createdAt: now - 8 * 24 * 60 * 60_000 - 3 * 60 * 60_000, modifiedAt: now - 8 * 24 * 60 * 60_000, lastAssistantText: 'Old result', lastAssistantStopReason: 'stop',
      },
    ]
    const state = {
      ...createInitialState('/tmp/metadata'),
      connection: 'connected' as const,
      sessions,
      threadLifecycle: { [activePath]: { labels: ['release', 'needs review'] } },
    }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/metadata', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 1_352, height: 932 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(1_352)}>
        <div style={{ width: 1_352, height: 932, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      const search = await automation.getByTestId('flows-search-frame').bounds()
      const activeRow = await automation.getByTestId('flow-task-PI-ACTIVE01').bounds()
      const priorityTarget = await automation.getByTestId('flow-priority-PI-ACTIVE01').bounds()
      const priorityHitTarget = await automation.getByTestId('flow-priority-PI-ACTIVE01-hit').bounds()
      const taskOpenTarget = await automation.getByTestId('flow-task-open-PI-ACTIVE01').bounds()
      expect(activeRow.x).toBeLessThanOrEqual(search.x)
      expect(Math.abs(search.x - priorityTarget.x)).toBeLessThanOrEqual(1)
      expect(priorityHitTarget).toEqual(priorityTarget)
      expect(root.renderer.findByTestId('flow-priority-PI-ACTIVE01-hit')?.style.pointerEvents).toBeUndefined()
      expect(taskOpenTarget.x - priorityTarget.x - priorityTarget.width).toBeGreaterThanOrEqual(7)
      const activeRowNode = root.renderer.findByTestId('flow-task-PI-ACTIVE01')!
      expect(activeRowNode.style.paddingLeft ?? 0).toBe(0)
      expect(activeRowNode.style.borderLeftWidth ?? 0).toBe(0)
      expect(activeRowNode.style.borderTopLeftRadius ?? 0).toBe(0)
      expect(activeRowNode.style.backgroundColor).toBe(colors.transparent)
      expect(root.renderer.findByTestId('flow-priority-PI-ACTIVE01')?.style.backgroundColor).toBe(colors.transparent)
      expect(root.renderer.findByTestId('flow-priority-PI-ACTIVE01-icon')?.style.color).toBe(colors.textMuted)
      expect(await automation.getByTestId('flow-task-PI-SETTLED1').count()).toBe(0)
      expect(root.renderer.getAllText()).toContain('Sessions · 1')
      expect(await automation.getByTestId('flow-label-pills').count()).toBe(1)

      await automation.getByTestId('flows-settled-toggle').click()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('flow-task-PI-SETTLED1').count()).toBe(1)
      expect(await automation.getByTestId('unsettle-PI-SETTLED1').count()).toBe(1)

      await automation.getByTestId('flow-priority-PI-ACTIVE01').click()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('flow-priority-menu').count()).toBe(1)
      expect(root.renderer.findByTestId('flow-priority-positioner')?.style.backgroundColor).toBe(colors.background)
      const priorityMotion = root.renderer.findByTestId('flow-priority-menu')?.customProps?.motion as { initial: { opacity: number; top: number }; animate: { opacity: number; top: number } }
      expect(priorityMotion.initial).toEqual({ opacity: 0, top: 4 })
      expect(priorityMotion.animate).toEqual({ opacity: 1, top: 0 })
      const trailingSlots = await automation.getByTestId('flow-priority-trailing').all()
      const priorityChecks = await automation.getByTestId('flow-priority-check').all()
      expect(trailingSlots).toHaveLength(6)
      expect(priorityChecks).toHaveLength(1)
      const automaticTrailing = trailingSlots[0]!.bounds!
      const automaticCheck = priorityChecks[0]!.bounds!
      expect(Math.abs(automaticTrailing.x + automaticTrailing.width - automaticCheck.x - automaticCheck.width)).toBeLessThanOrEqual(1)
      const priorityMenuIcons = ['auto', '0', '1', '2', '3', '4'].map((id) => root.renderer.findByTestId(`flow-priority-option-${id}-icon`))
      expect(priorityMenuIcons.every((icon) => icon?.style.color === colors.textMuted)).toBe(true)
      expect(root.renderer.findByTestId('flow-priority-option-1-glyph')?.style.backgroundColor).toBe(colors.textMuted)
      const urgentGlyph = await automation.getByTestId('flow-priority-option-1-glyph').bounds()
      const urgentStem = await automation.getByTestId('flow-priority-option-1-glyph-urgent-stem').bounds()
      const urgentDot = await automation.getByTestId('flow-priority-option-1-glyph-urgent-dot').bounds()
      expect(Math.abs(urgentStem.x + urgentStem.width / 2 - urgentGlyph.x - urgentGlyph.width / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs((urgentStem.y + urgentDot.y + urgentDot.height) / 2 - urgentGlyph.y - urgentGlyph.height / 2)).toBeLessThanOrEqual(1)
      await automation.getByTestId('flow-priority-option-1').click()
      expect(controller.getSnapshot().threadLifecycle[activePath]?.priority).toBe(1)
      const priorityExitMotion = root.renderer.findByTestId('flow-priority-menu')?.customProps?.motion as { animate: { opacity: number; top: number } }
      expect(priorityExitMotion.animate).toEqual({ opacity: 0, top: 4 })
      expect(root.renderer.findByTestId('flow-priority-positioner')?.style.pointerEvents).toBe('none')
      await Bun.sleep(180)
      root.renderer.flush()
      expect(await automation.getByTestId('flow-priority-menu').count()).toBe(0)

      await automation.getByTestId('flow-task-PI-ACTIVE01').click()
      root.renderer.flush()
      const detailScroll = root.renderer.findByTestId('flow-task-scroll')!
      expect(detailScroll.style.overflowX).toBe('hidden')
      expect(root.renderer.findByTestId('flow-task-prompt-content')?.style.maxHeight).toBe(95)
      expect(root.renderer.findByTestId('flow-task-output-content')?.style.maxHeight).toBe(160)
      expect(root.renderer.findByTestId('flow-task-output-toggle')?.style.backgroundColor).toBe(colors.transparent)
      const outputToggle = await automation.getByTestId('flow-task-output-toggle').bounds()
      await automation.call('mouseMove', { x: outputToggle.x + outputToggle.width / 2, y: outputToggle.y + outputToggle.height / 2 })
      await Bun.sleep(30)
      root.renderer.flush()
      expect(root.renderer.findByTestId('flow-task-output-toggle-label')?.style.color).toBe(colors.text)
      expect(root.renderer.findByTestId('flow-task-output-toggle')?.style.backgroundColor).toBe(colors.transparent)
      expect(await automation.getByTestId('flow-activity').count()).toBe(1)
      expect(root.renderer.getAllText()).toContain('Session started')
      expect(root.renderer.getAllText()).toContain('Prompted Pi')
      expect(root.renderer.getAllText()).toContain('Session completed')
      await automation.getByTestId('flow-task-prompt-toggle').click()
      await automation.getByTestId('flow-task-output-toggle').click()
      root.renderer.flush()
      expect(root.renderer.findByTestId('flow-task-prompt-content')?.style.maxHeight).toBeUndefined()
      expect(root.renderer.findByTestId('flow-task-output-content')?.style.maxHeight).toBeUndefined()
      const horizontalOffset = root.renderer.getScrollOffset(detailScroll.id)?.[0] ?? 0
      const detailBounds = await automation.getByTestId('flow-task-scroll').bounds()
      await automation.call('scrollWheel', { x: detailBounds.x + detailBounds.width / 2, y: detailBounds.y + detailBounds.height / 2, deltaX: 600, deltaY: 0 })
      root.renderer.flush()
      expect(Math.abs((root.renderer.getScrollOffset(detailScroll.id)?.[0] ?? 0) - horizontalOffset)).toBeLessThanOrEqual(0.01)
      await automation.call('scrollWheel', { x: detailBounds.x + detailBounds.width / 2, y: detailBounds.y + detailBounds.height / 2, deltaX: 0, deltaY: -10_000 })
      root.renderer.flush()
      expect(Math.abs(root.renderer.getScrollOffset(detailScroll.id)?.[1] ?? 0)).toBeLessThanOrEqual(0.01)
      expect(root.renderer.getAllText()).not.toContain('Pi session')
      expect(root.renderer.getAllText()).not.toContain('Project')

      await automation.getByTestId('flow-label-trigger').click()
      expect(root.renderer.findByTestId('flow-label-positioner')?.style.backgroundColor).toBe(colors.card)
      const labelMotion = root.renderer.findByTestId('flow-label-menu')?.customProps?.motion as { initial: { opacity: number; top: number }; animate: { opacity: number; top: number } }
      expect(labelMotion.initial).toEqual({ opacity: 0, top: 4 })
      expect(labelMotion.animate).toEqual({ opacity: 1, top: 0 })
      await automation.getByTestId('flow-label-search').fill('customer')
      root.renderer.flush()
      await automation.getByTestId('flow-label-create').click()
      expect(controller.getSnapshot().threadLifecycle[activePath]?.labels).toEqual(['release', 'needs review', 'customer'])
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('keeps collapsed task content bounded and reaches the end of expanded output', async () => {
    const now = Date.now()
    const longPrompt = Array.from({ length: 24 }, (_, index) => `Prompt requirement ${index + 1}`).join('\n')
    const longOutput = Array.from({ length: 160 }, (_, index) => `Output line ${index + 1}: projected detail remains reachable`).join('\n')
    const session: PiSessionSummary = {
      id: 'scroll01', path: '/tmp/flows-scroll/scroll.jsonl', cwd: '/tmp/flows-scroll', title: 'Long scrollable task', firstMessage: longPrompt, messageCount: 2,
      createdAt: now - 45 * 60_000, modifiedAt: now - 1_000, lastAssistantText: longOutput, lastAssistantStopReason: 'stop',
    }
    const state = { ...createInitialState('/tmp/flows-scroll'), connection: 'connected' as const, sessions: [session] }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-scroll', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 1_352, height: 620 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(1_352)}>
        <div style={{ width: 1_352, height: 620, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      await automation.getByTestId('flow-task-PI-SCROLL01').click()
      root.renderer.flush()
      const scroll = root.renderer.findByTestId('flow-task-scroll')!
      const scrollBounds = await automation.getByTestId('flow-task-scroll').bounds()
      const point = { x: scrollBounds.x + scrollBounds.width / 2, y: scrollBounds.y + scrollBounds.height / 2 }
      expect(root.renderer.findByTestId('flow-task-prompt-content')?.style.maxHeight).toBe(95)
      expect(root.renderer.findByTestId('flow-task-output-content')?.style.maxHeight).toBe(160)

      await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -10_000 })
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0).toBeLessThan(-100)
      await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: 10_000 })
      root.renderer.flush()
      expect(Math.abs(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0)).toBeLessThanOrEqual(0.01)

      await automation.getByTestId('flow-task-output-toggle').click()
      root.renderer.flush()
      expect(root.renderer.findByTestId('flow-task-output-content')?.style.maxHeight).toBeUndefined()
      await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -10_000 })
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0).toBeLessThan(-100)
      const outputBounds = await automation.getByTestId('flow-task-result-text').bounds()
      expect(outputBounds.y + outputBounds.height).toBeGreaterThan(scrollBounds.y)
      expect(outputBounds.y + outputBounds.height).toBeLessThanOrEqual(scrollBounds.y + scrollBounds.height + 1)

      await automation.getByTestId('flow-task-back').click()
      await automation.getByTestId('flows-tab-triage').click()
      root.renderer.flush()
      expect(root.renderer.findByTestId('triage-prompt-content')?.style.maxHeight).toBe(90)
      expect(root.renderer.findByTestId('triage-output-content')?.style.maxHeight).toBe(160)
      expect(root.renderer.findByTestId('triage-output-toggle')?.style.backgroundColor).toBe(colors.transparent)
      await automation.getByTestId('triage-output-toggle').click()
      root.renderer.flush()
      const triageList = root.renderer.findByTestId('triage-detail-list')!
      const triageBounds = await automation.getByTestId('triage-detail').bounds()
      for (const testId of ['triage-open-task', 'triage-prompt-toggle', 'triage-output-toggle', 'triage-result-card']) {
        const bounds = await automation.getByTestId(testId).bounds()
        expect(triageBounds.x + triageBounds.width - bounds.x - bounds.width).toBeGreaterThanOrEqual(8)
      }
      await automation.call('scrollWheel', { x: triageBounds.x + triageBounds.width / 2, y: triageBounds.y + triageBounds.height / 2, deltaX: 0, deltaY: -10_000 })
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(triageList.id)?.[1] ?? 0).toBeLessThan(-100)
      const triageOutputBounds = await automation.getByTestId('triage-result-text').bounds()
      expect(triageOutputBounds.y + triageOutputBounds.height).toBeGreaterThan(triageBounds.y)
      expect(triageOutputBounds.y + triageOutputBounds.height).toBeLessThanOrEqual(triageBounds.y + triageBounds.height + 1)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })

  it('progressively projects a large workspace through one bounded native list', async () => {
    const sessions: PiSessionSummary[] = Array.from({ length: 1_200 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, '0')}-session`,
      path: `/tmp/flows-large/session-${index}.jsonl`,
      cwd: '/tmp/flows-large',
      title: `Projected session ${index}`,
      firstMessage: `Inspect projected workspace item ${index}`,
      messageCount: 2,
      createdAt: Date.now() - (1_200 - index) * 1_000 - 60_000,
      modifiedAt: Date.now() - (1_200 - index) * 1_000,
      lastAssistantText: `Projected result ${index}`,
      lastAssistantStopReason: 'stop',
    }))
    const state = { ...createInitialState('/tmp/flows-large'), connection: 'connected' as const, sessions }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-large', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 1_000, height: 700 })
    const close = () => undefined
    const openSession = (_session: PiSessionSummary) => undefined
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(1_000)}>
        <div style={{ width: 1_000, height: 700, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={close} onOpenSession={openSession} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      const list = root.renderer.findByTestId('flows-work-list')!
      const listId = list.id
      const initialRails = await automation.getByTestId('flow-rail-node').count()
      expect(list.type).toBe('virtual-list')
      expect(list.customProps?.alignment).toBe('top')
      expect(list.customProps?.itemCount).toBeUndefined()
      expect(list.children.length).toBeLessThan(128)
      expect(initialRails).toBeGreaterThan(0)
      expect(initialRails).toBeLessThan(128)
      expect(await automation.getByTestId('flow-projection-continuation').count()).toBe(1)
      expect(root.renderer.getAllText().length).toBeLessThan(1_000)

      const surface = await automation.getByTestId('flows-work-scroll-surface').bounds()
      const initialOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
      await automation.call('scrollWheel', { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2, deltaX: 0, deltaY: -120 })
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(initialOffset - 10)
      await automation.call('scrollWheel', { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2, deltaX: 0, deltaY: 120 })
      root.renderer.flush()

      await expectScrollWheelLatency(automation, root, surface)

      for (let attempt = 0; attempt < 40 && root.renderer.findByTestId('flows-work-list')!.children.length < 1_201; attempt += 1) {
        await Bun.sleep(20)
        root.renderer.flush()
      }
      const settledList = root.renderer.findByTestId('flows-work-list')!
      expect(settledList.id).toBe(listId)
      expect(settledList.children.length).toBe(1_201)
      expect(await automation.getByTestId('flow-projection-continuation').count()).toBe(0)
      expect(root.renderer.getPaintedText().length).toBeLessThan(120)
      root.renderer.scrollToItem(settledList.id, 1_000)
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(settledList.id)?.[1] ?? 0).toBeLessThan(-10_000)
      expect(root.renderer.getPaintedText().length).toBeLessThan(120)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  }, 10_000)


  it('replays nested Fabric branches and their join on a parallel task page', async () => {
    const now = Date.now()
    const sessionPath = `/tmp/heddlework-flow-fabric-${process.pid}.jsonl`
    const records = [
      { type: 'message', id: 'fabric-user', parentId: null, message: { role: 'user', content: '[Flow HW-GRAPH]\n[Flow Task HW-GRAPH-1]\n\nTask:\nBuild the projected branch graph', timestamp: now - 4_000 } },
      { type: 'message', id: 'fabric-call', parentId: 'fabric-user', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fabric-exec', name: 'fabric_exec', arguments: { display: { name: 'HW-GRAPH-1' }, code: 'return await workflow.parallel([])' } }], timestamp: now - 3_000 } },
      {
        type: 'message',
        id: 'fabric-result',
        parentId: 'fabric-call',
        message: {
          role: 'toolResult',
          toolCallId: 'fabric-exec',
          toolName: 'fabric_exec',
          content: 'complete',
          timestamp: now - 2_000,
          details: {
            audits: [
              {
                ref: 'agents.run', provider: 'agents', tool: 'run', success: true,
                preview: {
                  kind: 'fabric-agent-tools', id: 'ui-agent-parent', name: 'HW-GRAPH-1/B1', status: 'completed', runner: 'pi', tools: [],
                  agents: [{ id: 'ui-agent-child', name: 'HW-GRAPH-1/B1.1', status: 'completed', runner: 'pi', currentTool: 'read src/graph.ts', tools: [] }],
                },
              },
              { ref: 'agents.run', provider: 'agents', tool: 'run', success: true, preview: { kind: 'fabric-agent-tools', id: 'ui-agent-sibling', name: 'HW-GRAPH-1/B2', status: 'completed', runner: 'pi', tools: [] } },
            ],
          },
        },
      },
      { type: 'message', id: 'fabric-answer', parentId: 'fabric-result', message: { role: 'assistant', content: 'Joined result', timestamp: now - 1_000 } },
    ]
    writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const session: PiSessionSummary = {
      id: 'fabric-graph-session', path: sessionPath, cwd: '/tmp', name: 'Flow HW-GRAPH/1:1 · Parallel graph', title: 'Parallel graph',
      firstMessage: '[Flow HW-GRAPH]\n[Flow Task HW-GRAPH-1]\n\nTask:\nBuild the projected branch graph', messageCount: records.length,
      createdAt: now - 4_000, modifiedAt: now - 1_000, lastAssistantText: 'Joined result', lastAssistantStopReason: 'stop',
    }
    const { controller, runtime, root, automation } = await renderFlowsView(session)
    try {
      await automation.getByTestId('flow-task-HW-GRAPH-1').click()
      await waitFor(() => {
        root.renderer.flush()
        return Boolean(root.renderer.findByTestId('flow-fabric-join'))
      })
      expect(await automation.getByTestId('flow-fabric-graph').count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-branch-ui-agent-parent').count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-branch-ui-agent-child').count()).toBe(1)
      expect(await automation.getByTestId('flow-fabric-branch-ui-agent-sibling').count()).toBe(1)
      expect(root.renderer.getAllText()).toContain('read src/graph.ts')
      expect(root.renderer.getAllText()).toContain('3 branches joined')
      expect((await automation.getByTestId('flow-rail-link').all()).length).toBeGreaterThan(0)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
      rmSync(sessionPath, { force: true })
    }
  })

  it('batches persisted session activity into the task timeline', async () => {
    const now = Date.now()
    const sessionPath = `/tmp/heddlework-flow-activity-${process.pid}.jsonl`
    const records = [
      { type: 'message', id: 'activity-user', parentId: null, message: { role: 'user', content: 'Inspect the activity projection', timestamp: now - 5_000 } },
      { type: 'message', id: 'activity-tools', parentId: 'activity-user', message: { role: 'assistant', timestamp: now - 4_000, content: [{ type: 'toolCall', id: 'read-a', name: 'read', arguments: { path: 'a.ts' } }, { type: 'toolCall', id: 'read-b', name: 'read', arguments: { path: 'b.ts' } }] } },
      { type: 'message', id: 'activity-result-a', parentId: 'activity-tools', message: { role: 'toolResult', toolCallId: 'read-a', toolName: 'read', content: 'a', timestamp: now - 3_000 } },
      { type: 'message', id: 'activity-result-b', parentId: 'activity-result-a', message: { role: 'toolResult', toolCallId: 'read-b', toolName: 'read', content: 'b', timestamp: now - 2_000 } },
      { type: 'message', id: 'activity-response', parentId: 'activity-result-b', message: { role: 'assistant', content: [{ type: 'text', text: 'The activity projection is complete.' }], timestamp: now - 1_000 } },
    ]
    writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const session: PiSessionSummary = {
      id: 'activity-session', path: sessionPath, cwd: '/tmp', title: 'Activity projection', firstMessage: 'Inspect the activity projection', messageCount: records.length,
      createdAt: now - 5_000, modifiedAt: now - 1_000, lastAssistantText: 'The activity projection is complete.', lastAssistantStopReason: 'stop',
    }
    const { controller, runtime, root, automation } = await renderFlowsView(session)
    try {
      await automation.getByTestId('flow-task-PI-ACTIVITY').click()
      await waitFor(() => {
        root.renderer.flush()
        return root.renderer.getAllText().includes('Ran 2 tool calls')
      })
      expect(root.renderer.getAllText()).toContain('read ×2')
      expect(root.renderer.getAllText()).toContain('The activity projection is complete.')
      expect(await automation.getByTestId('flow-activity-entry').count()).toBe(5)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
      rmSync(sessionPath, { force: true })
    }
  })

  it('keeps compact Factory rows and dependency nodes usable on mobile', async () => {
    const sessions: PiSessionSummary[] = Array.from({ length: 3 }, (_, index) => ({
      id: `mobile0${index + 1}-session`,
      path: `/tmp/flows-mobile/session-${index}.jsonl`,
      cwd: '/tmp/flows-mobile',
      title: `Mobile projected task ${index + 1}`,
      firstMessage: `Inspect mobile task ${index + 1}`,
      messageCount: 2,
      createdAt: Date.now() - (4 - index) * 1_000 - 60_000,
      modifiedAt: Date.now() - (4 - index) * 1_000,
      lastAssistantText: `Mobile result ${index + 1}`,
      lastAssistantStopReason: 'stop',
    }))
    const state = { ...createInitialState('/tmp/flows-mobile'), connection: 'connected' as const, sessions }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/flows-mobile', testControllerDependencies())
    const runtime = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const root = createTestRoot({ width: 390, height: 844 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(390)}>
        <div style={{ width: 390, height: 844, display: 'flex', flexDirection: 'row' }}>
          <FlowsView state={state} controller={controller} runtime={runtime} presenters={new Map()} onClose={() => undefined} onOpenSession={() => undefined} />
        </div>
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      const taskId = 'PI-MOBILE03'
      const viewBounds = await automation.getByTestId('flows-view').bounds()
      const searchBounds = await automation.getByTestId('flows-search').bounds()
      const toolbar = root.renderer.findByTestId('flows-work-toolbar')!
      const taskBounds = await automation.getByTestId(`flow-task-${taskId}`).bounds()
      const railBounds = (await automation.getByTestId('flow-rail-node').all())[0]!.bounds!
      expect(viewBounds.width).toBe(390)
      expect(searchBounds.width).toBeGreaterThan(320)
      expect(toolbar.style.paddingLeft).toBe(resolveResponsiveLayout(390).contentGutter)
      expect(toolbar.style.paddingRight).toBe(toolbar.style.paddingLeft)
      const taskLeftInset = taskBounds.x - viewBounds.x
      const taskRightInset = viewBounds.x + viewBounds.width - taskBounds.x - taskBounds.width
      expect(taskBounds.width).toBeCloseTo(366, 0)
      expect(taskLeftInset).toBeGreaterThanOrEqual(11)
      expect(Math.abs(taskLeftInset - taskRightInset)).toBeLessThanOrEqual(1)
      expect(railBounds.x).toBeGreaterThan(taskBounds.x + taskBounds.width * 0.85)
      const statusGlyphs = await automation.getByTestId('flow-status-glyph').all()
      expect(statusGlyphs.length).toBeGreaterThanOrEqual(2)
      const statusSizes = statusGlyphs.map((glyph) => glyph.bounds?.width ?? 0)
      expect(Math.min(...statusSizes)).toBeGreaterThanOrEqual(14)
      expect(Math.max(...statusSizes) - Math.min(...statusSizes)).toBeLessThanOrEqual(2)

      await automation.getByTestId(`flow-task-${taskId}`).click()
      root.renderer.flush()
      expect((await automation.getByTestId('flow-task-page').bounds()).width).toBe(390)
      expect(await automation.getByTestId('flow-open-thread').count()).toBe(1)
    } finally {
      await automation.close()
      root.unmount()
      runtime.dispose()
      await controller.dispose()
    }
  })
})

function visualSession(id: string, cwd: string, title: string, order: number, result = `Completed ${title}`): PiSessionSummary {
  const modifiedAt = Date.now() - (10 - order) * 1_000
  return {
    id,
    path: `${cwd}/${id}.jsonl`,
    cwd,
    title,
    firstMessage: `Inspect ${title}`,
    messageCount: 2,
    createdAt: modifiedAt - order * 10 * 60_000,
    modifiedAt,
    lastAssistantText: result,
    lastAssistantStopReason: 'stop',
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for the Flow session identity')
}
