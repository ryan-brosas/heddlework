import { useSyncExternalStore } from 'react'
import { expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createQueueState } from '../src/workbench/queue.ts'
import { Composer } from '../src/ui/composer.tsx'
import { QueueDock, queueDockReserveHeight } from '../src/ui/queue-dock.tsx'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { testControllerDependencies } from './helpers/workbench.ts'
import { describeNative } from './helpers/native-renderer.ts'

describeNative('queue dock', () => {
  it('reveals the queue shortcut, queues with Alt+Enter, and resumes with empty Enter', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/queue-ui-stopped', testControllerDependencies())
    await controller.start()

    function Fixture() {
      const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
      return <div style={{ width: 820, padding: 20 }}><Composer state={state} controller={controller} draft /></div>
    }

    const root = createTestRoot({ width: 900, height: 620 })
    root.render(<Fixture />)
    const automation = await connectTest(root.renderer)
    try {
      expect(root.renderer.getPaintedText()).not.toContain('Queue')
      expect(await automation.getByTestId('composer-queue').count()).toBe(0)
      const collapsedSendWidth = (await automation.getByTestId('send').bounds()).width
      const expandedSendWidth = process.platform === 'darwin' ? 92 : 126
      await automation.getByTestId('composer').fill('Parked follow-up')
      await automation.getByTestId('composer').click()
      await Bun.sleep(70)
      root.renderer.flush()
      expect(root.renderer.getPaintedText()).toContain(process.platform === 'darwin' ? '⌥↵ queue' : 'Alt+Enter queue')
      expect(root.renderer.findByTestId('composer-queue-hint')?.style.fontSize).toBe(11)
      const expandingSendWidth = (await automation.getByTestId('send').bounds()).width
      expect(expandingSendWidth).toBeGreaterThan(collapsedSendWidth)
      expect(expandingSendWidth).toBeLessThan(expandedSendWidth)
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      expect((await automation.getByTestId('send').bounds()).width).toBeCloseTo(expandedSendWidth, 0)
      await automation.getByTestId('composer').press('alt-enter')
      await Bun.sleep(0)
      root.renderer.flush()
      expect(controller.getSnapshot().session.isStreaming).toBe(false)
      expect(controller.getSnapshot().queue.pauseReason).toBe('manual')
      expect(controller.getSnapshot().queue.items.map((item) => item.text)).toEqual(['Parked follow-up'])
      expect(controller.getSnapshot().queue.items[0]?.lane).toBe('followUp')
      expect(await automation.getByTestId('queue-resume').count()).toBe(1)
      expect(root.renderer.getPaintedText()).not.toContain(process.platform === 'darwin' ? '⌥↵ queue' : 'Alt+Enter queue')

      const emptyComposer = root.renderer.findByTestId('composer')!
      root.renderer.nativeSimulateKeystrokes(emptyComposer.id, 'enter')
      await Bun.sleep(0)
      expect(controller.getSnapshot().queue.paused).toBe(false)
      expect(controller.getSnapshot().queue.items).toEqual([])
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })

  it('stacks twenty rows, springs upward, scrolls, edits, and drag-reorders from the left handle', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/queue-ui', testControllerDependencies())
    for (let index = 1; index <= 20; index += 1) controller.queueInput(index === 1 ? '/compact focus on decisions' : `Queued task ${String(index).padStart(2, '0')}`)
    controller.acceptAgentEvent({ type: 'agent_start' })

    function Fixture() {
      const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
      return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ position: 'absolute', left: 40, right: 40, bottom: 30 }}>
            <QueueDock state={state} controller={controller} />
          </div>
        </div>
      )
    }

    const root = createTestRoot({ width: 900, height: 620 })
    root.render(<Fixture />)
    const automation = await connectTest(root.renderer)

    try {
      expect(queueDockReserveHeight(createQueueState())).toBe(0)
      expect(queueDockReserveHeight(controller.getSnapshot().queue)).toBe(50)
      expect(root.renderer.getPaintedText()).toContain('20 queued')
      const collapsed = await automation.getByTestId('queue-dock').bounds()
      const collapsedHeader = await automation.getByTestId('queue-header').bounds()
      const collapsedPanel = await automation.getByTestId('queue-panel').bounds()
      expect(collapsed.height).toBeLessThanOrEqual(43)
      expect(collapsedHeader.width).toBe(collapsed.width)
      expect(collapsedPanel.x - collapsed.x).toBeGreaterThanOrEqual(0)
      expect(collapsedPanel.x - collapsed.x).toBeLessThanOrEqual(1)
      expect(collapsedPanel.width + 2).toBe(collapsedHeader.width)
      const anchoredBottom = collapsed.y + collapsed.height

      await automation.getByTestId('queue-header').click()
      await Bun.sleep(70)
      root.renderer.flush()
      const opening = await automation.getByTestId('queue-dock').bounds()
      expect(opening.height).toBeGreaterThan(collapsed.height)
      expect(opening.height).toBeLessThan(307)
      expect(Math.abs(opening.y + opening.height - anchoredBottom)).toBeLessThanOrEqual(1)

      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      const expanded = await automation.getByTestId('queue-dock').bounds()
      expect(expanded.height).toBeGreaterThanOrEqual(305)
      expect(Math.abs(expanded.y + expanded.height - anchoredBottom)).toBeLessThanOrEqual(1)
      const scroll = (await automation.getByTestId('queue-scroll').all())[0]!
      expect(root.renderer.getScrollOffset(scroll.id)).not.toBeNull()
      root.renderer.scrollTo(scroll.id, 0, -320)
      expect(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0).toBeLessThan(-250)
      root.renderer.scrollTo(scroll.id, 0, 0)
      expect(root.renderer.getPaintedText()).toContain('CONTROL · COMPACT')
      expect(await automation.getByTestId('queue-drain').count()).toBe(1)
      expect(await automation.getByTestId('queue-pause').count()).toBe(1)
      expect(await automation.getByTestId('queue-peer-gate').count()).toBe(1)

      const first = controller.getSnapshot().queue.items[0]!
      expect(await automation.getByTestId(`queue-steer:${first.id}`).count()).toBe(0)
      const heldRowBounds = await automation.getByTestId(`queue-row:${first.id}`).bounds()
      await automation.call('mouseMove', { x: heldRowBounds.x + heldRowBounds.width / 2, y: heldRowBounds.y + heldRowBounds.height / 2 })
      await Bun.sleep(160)
      root.renderer.flush()
      await automation.getByTestId(`queue-row-pause:${first.id}`).click()
      expect(controller.getSnapshot().queue.items[0]?.paused).toBe(true)
      await automation.getByTestId(`queue-row-pause:${first.id}`).click()
      expect(controller.getSnapshot().queue.items[0]?.paused).toBe(false)
      await automation.getByTestId(`queue-edit:${first.id}`).click()
      await automation.getByTestId(`queue-editor:${first.id}`).fill('/skill:review edited in queue')
      const editor = root.renderer.findByTestId(`queue-editor:${first.id}`)!
      root.renderer.nativeSimulateKeystrokes(editor.id, 'enter')
      expect(controller.getSnapshot().queue.items[0]?.text).toBe('/skill:review edited in queue')
      expect(await automation.getByTestId(`queue-steer:${first.id}`).count()).toBe(1)
      const dragged = controller.getSnapshot().queue.items[0]!
      const target = controller.getSnapshot().queue.items[5]!
      const draggedRowBounds = await automation.getByTestId(`queue-row:${dragged.id}`).bounds()
      const handleBounds = await automation.getByTestId(`queue-drag:${dragged.id}`).bounds()
      const targetBounds = await automation.getByTestId(`queue-row:${target.id}`).bounds()
      await automation.call('mouseMove', { x: draggedRowBounds.x + draggedRowBounds.width / 2, y: draggedRowBounds.y + draggedRowBounds.height / 2 })
      await Bun.sleep(160)
      root.renderer.flush()
      root.renderer.nativeSimulateMouseDown(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2)
      root.renderer.nativeSimulateMouseMove(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2, 0)
      root.renderer.nativeSimulateMouseUp(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2)
      expect(controller.getSnapshot().queue.items[5]?.id).toBe(dragged.id)

      const movedRowBounds = await automation.getByTestId(`queue-row:${dragged.id}`).bounds()
      await automation.call('mouseMove', { x: movedRowBounds.x + movedRowBounds.width / 2, y: movedRowBounds.y + movedRowBounds.height / 2 })
      await Bun.sleep(160)
      root.renderer.flush()
      await automation.getByTestId(`queue-lane:${dragged.id}`).click()
      expect(controller.getSnapshot().queue.items[0]).toMatchObject({ id: dragged.id, lane: 'steer' })

      const removable = controller.getSnapshot().queue.items[0]!
      const removableBounds = await automation.getByTestId(`queue-row:${removable.id}`).bounds()
      await automation.call('mouseMove', { x: removableBounds.x + removableBounds.width / 2, y: removableBounds.y + removableBounds.height / 2 })
      await Bun.sleep(160)
      root.renderer.flush()
      await automation.getByTestId(`queue-remove:${removable.id}`).click()
      expect(controller.getSnapshot().queue.items).toHaveLength(19)

      await automation.getByTestId('queue-header').click()
      await Bun.sleep(70)
      root.renderer.flush()
      const closing = await automation.getByTestId('queue-dock').bounds()
      expect(closing.height).toBeGreaterThan(collapsed.height)
      expect(closing.height).toBeLessThan(expanded.height)
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      expect((await automation.getByTestId('queue-dock').bounds()).height).toBeLessThanOrEqual(43)
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  }, 5_000)
})
