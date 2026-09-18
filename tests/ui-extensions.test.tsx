import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import {
  workbenchUiRegistryToken,
  type WorkbenchPlugin,
  type WorkbenchSurfaceProps,
} from '../src/plugin-api.ts'
import { describeNative } from './helpers/native-renderer.ts'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { createCoreUiExtension } from '../src/ui/core-extension.tsx'
import { workbenchUiHostPlugin } from '../src/ui/extensions.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

function FixtureSurface(_props: WorkbenchSurfaceProps) {
  return (
    <div testId="fixture-surface" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <text>One in-process feature surface</text>
    </div>
  )
}

function featurePlugin(surfaceIds: string[]): WorkbenchPlugin {
  return {
    id: 'fixture-feature',
    requires: [workbenchUiRegistryToken],
    activate(ctx) {
      const registry = ctx.get(workbenchUiRegistryToken)
      ctx.effect(() => registry.register({
        id: 'fixture.feature',
        surfaces: surfaceIds.map((id, index) => ({
          id,
          title: `Fixture ${index + 1}`,
          description: 'Contributed by one cohesive feature plugin.',
          icon: 'box',
          order: 200 - index,
          component: FixtureSurface,
        })),
      }))
    },
  }
}

describe('workbench UI extensions', () => {
  it('registers several ordered surfaces as one reversible feature', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(workbenchUiHostPlugin)
    const registry = kernel.get(workbenchUiRegistryToken)
    let changes = 0
    const unsubscribe = registry.subscribe(() => { changes += 1 })
    const removeFeature = kernel.mount(featurePlugin(['fixture-a', 'fixture-b']))

    expect(registry.getSnapshot().surfaces.map((surface) => surface.id)).toEqual(['fixture-b', 'fixture-a'])
    expect(new Set(registry.getSnapshot().surfaces.map((surface) => surface.extensionId))).toEqual(new Set(['fixture.feature']))
    expect(changes).toBe(1)
    expect(() => registry.register({
      id: 'collision',
      surfaces: [{ id: 'fixture-a', title: 'Collision', description: '', icon: 'box', component: FixtureSurface }],
    })).toThrow('UI surface already registered: fixture-a')
    expect(registry.getSnapshot().surfaces).toHaveLength(2)

    await removeFeature()
    expect(registry.getSnapshot().surfaces).toEqual([])
    expect(changes).toBe(2)
    unsubscribe()
    await kernel.dispose()
  })
})

describeNative('workbench UI extension host', () => {
  it('opens a user-contributed component from the shared surface picker', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/ui-extension-workspace', testControllerDependencies())
    const kernel = new WorkbenchKernel()
    kernel.mount(workbenchUiHostPlugin)
    const registry = kernel.get(workbenchUiRegistryToken)
    registry.register(createCoreUiExtension(controller))
    const removeFeature = kernel.mount(featurePlugin(['fixture-custom']))
    const root = createTestRoot()
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={registry} />)
    const automation = await connectTest(root.renderer)

    try {
      await controller.start()
      root.renderer.flush()
      await automation.getByTestId('toggle-diff').click()
      await Bun.sleep(SPRING_SETTLE_MS)
      root.renderer.flush()
      await automation.getByTestId('right-panel-new-tab').click()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('surface-option-fixture-custom').count()).toBe(1)
      await automation.getByTestId('surface-option-fixture-custom').click()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(await automation.getByTestId('fixture-surface').count()).toBe(1)

      await removeFeature()
      await Bun.sleep(30)
      root.renderer.flush()
      expect(await automation.getByTestId('fixture-surface').count()).toBe(0)
    } finally {
      await removeFeature()
      await automation.close()
      root.unmount()
      await controller.dispose()
      await kernel.dispose()
    }
  }, 10_000)
})
