import { expect } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { performance } from 'node:perf_hooks'
import { PiSessionCatalog } from '../../src/pi/session-catalog.ts'
import type { WorkbenchController, WorkbenchControllerDependencies } from '../../src/workbench/controller.ts'
import type { SessionCatalogService } from '../../src/workbench/services.ts'
import { loadWorkspaceDiff } from '../../src/workspace/git-diff.ts'
import { createCoreUiExtension } from '../../src/ui/core-extension.tsx'
import { WorkbenchUiRegistry } from '../../src/ui/extensions.ts'

export function testControllerDependencies(sessionCatalog: SessionCatalogService = new PiSessionCatalog({ scope: 'cwd' })): WorkbenchControllerDependencies {
  return {
    sessionCatalog,
    workspaceDiff: { load: loadWorkspaceDiff },
  }
}

/** Shared scroll-wheel latency probe: emits 20 alternating wheel events, then asserts the flush budget. */
export async function expectScrollWheelLatency(
  automation: Awaited<ReturnType<typeof connectTest>>,
  root: ReturnType<typeof createTestRoot>,
  surface: { x: number; y: number; width: number; height: number },
  budgetMs = 400,
): Promise<void> {
  const wheelStarted = performance.now()
  for (let index = 0; index < 20; index += 1) {
    await automation.call('scrollWheel', { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2, deltaX: 0, deltaY: index % 2 ? -120 : 120 })
    root.renderer.flush()
  }
  expect(performance.now() - wheelStarted).toBeLessThan(budgetMs)
}

export function createTestUiRegistry(controller: WorkbenchController): WorkbenchUiRegistry {
  const registry = new WorkbenchUiRegistry()
  registry.register(createCoreUiExtension(controller))
  return registry
}
