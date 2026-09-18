import { describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { SPRING_SETTLE_MS } from '../src/ui/motion.ts'
import { resolveResponsiveLayout } from '../src/ui/responsive.tsx'
import { ThemeManager } from '../src/ui/theme-manager.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'
import { describeNative } from './helpers/native-renderer.ts'

describe('responsive layout', () => {
  it('classifies mobile, tablet, and desktop widths with adaptive gutters', () => {
    expect(resolveResponsiveLayout(390)).toMatchObject({
      viewportClass: 'mobile',
      navigationOverlay: true,
      panelOverlay: true,
      contentGutter: 12,
      composerGutter: 10,
    })
    expect(resolveResponsiveLayout(1_024)).toMatchObject({
      viewportClass: 'tablet',
      navigationOverlay: true,
      panelOverlay: true,
      contentGutter: 16,
    })
    expect(resolveResponsiveLayout(1_280)).toMatchObject({
      viewportClass: 'desktop',
      navigationOverlay: false,
      panelOverlay: false,
      contentGutter: 20,
    })
  })
})

describeNative('responsive workbench shell', () => {
  it('uses drawers, compact controls, and fullscreen secondary surfaces on mobile', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/heddlework-mobile-project', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    const ui = createTestUiRegistry(controller)
    const themeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    const root = createTestRoot({ width: 390, height: 760 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={ui} themeManager={themeManager} />)
    await controller.start()
    await Bun.sleep(40)
    root.renderer.flush()
    const automation = await connectTest(root.renderer)

    try {
      const safeArea = await automation.getByTestId('workbench-safe-area').bounds()
      expect(safeArea.width).toBe(390)
      expect(await automation.getByTestId('left-sidebar-host').count()).toBe(0)
      expect(await automation.getByTestId('chat-project-crumb').count()).toBe(0)
      expect(await automation.getByTestId('header-open').count()).toBe(0)
      expect(await automation.getByTestId('header-export').count()).toBe(0)

      const toggleBounds = await automation.getByTestId('toggle-left-sidebar').bounds()
      const titleBounds = await automation.getByTestId('chat-thread-title').bounds()
      expect(titleBounds.x).toBeGreaterThanOrEqual(toggleBounds.x + toggleBounds.width + 10)

      const composerBounds = await automation.getByTestId('composer-surface').bounds()
      expect(composerBounds.x).toBeGreaterThanOrEqual(safeArea.x)
      expect(composerBounds.x + composerBounds.width).toBeLessThanOrEqual(safeArea.x + safeArea.width)
      const modelBounds = await automation.getByTestId('model-picker').bounds()
      const thinkingBounds = await automation.getByTestId('thinking-picker').bounds()
      const contextBounds = await automation.getByTestId('context-meter').bounds()
      const sendBounds = await automation.getByTestId('send').bounds()
      expect(modelBounds.x + modelBounds.width).toBeLessThanOrEqual(thinkingBounds.x + 1)
      expect(thinkingBounds.x + thinkingBounds.width).toBeLessThanOrEqual(contextBounds.x + 1)
      expect(contextBounds.x + contextBounds.width).toBeLessThanOrEqual(sendBounds.x + 1)
      expect(sendBounds.x + sendBounds.width).toBeLessThanOrEqual(composerBounds.x + composerBounds.width)

      await automation.getByTestId('workspace-chooser-trigger').click()
      root.renderer.flush()
      const workspaceMenu = await automation.getByTestId('workspace-menu').bounds()
      expect(workspaceMenu.x).toBeGreaterThanOrEqual(safeArea.x)
      expect(workspaceMenu.x + workspaceMenu.width).toBeLessThanOrEqual(safeArea.x + safeArea.width)
      await automation.getByTestId('workspace-menu-dismiss').click()
      if (process.platform === 'darwin') {
        const screenshot = resolve(import.meta.dir, '../screenshots/workbench-mobile.png')
        mkdirSync(resolve(import.meta.dir, '../screenshots'), { recursive: true })
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }

      await automation.getByTestId('toggle-left-sidebar').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect((await automation.getByTestId('left-sidebar-host').bounds()).width).toBeCloseTo(256, 0)
      expect(await automation.getByTestId('navigation-scrim').count()).toBe(1)
      await automation.getByTestId('sidebar-settings').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect(await automation.getByTestId('left-sidebar-host').count()).toBe(0)
      expect((await automation.getByTestId('settings-view').bounds()).width).toBe(390)
      const settingsTitle = await automation.getByText('Settings').bounds()
      expect(settingsTitle.x).toBeGreaterThanOrEqual(toggleBounds.x + toggleBounds.width + 10)
      await automation.getByText('Done').click()

      await automation.getByTestId('toggle-left-sidebar').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      await automation.getByTestId('sidebar-notifications').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect(Math.abs((await automation.getByTestId('notification-panel').bounds()).width - 390)).toBeLessThanOrEqual(2)
      expect(await automation.getByTestId('notification-panel-close').count()).toBe(1)
      await automation.getByTestId('notification-panel-close').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()

      await automation.getByTestId('toggle-diff').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      const panelBounds = await automation.getByTestId('diff-panel').bounds()
      expect(Math.abs(panelBounds.x - safeArea.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(panelBounds.width - safeArea.width)).toBeLessThanOrEqual(2)
      expect(await automation.getByTestId('right-panel-fullscreen').count()).toBe(0)
      expect(await automation.getByTestId('right-panel-restore').count()).toBe(0)
      await automation.getByTestId('close-diff').click()
    } finally {
      await automation.close()
      root.unmount()
      ui.dispose()
      themeManager.dispose()
      await controller.dispose()
    }
  }, 10_000)

  it('keeps tablet navigation out of the content flow while retaining compact project actions', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/heddlework-tablet-project', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    const ui = createTestUiRegistry(controller)
    const themeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    const root = createTestRoot({ width: 820, height: 720 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={ui} themeManager={themeManager} />)
    await controller.start()
    await Bun.sleep(40)
    root.renderer.flush()
    const automation = await connectTest(root.renderer)

    try {
      expect(await automation.getByTestId('left-sidebar-host').count()).toBe(0)
      expect(await automation.getByTestId('chat-project-crumb').count()).toBe(1)
      expect(await automation.getByTestId('header-open').count()).toBe(1)
      expect(await automation.getByTestId('header-export').count()).toBe(1)
      expect((await automation.getByTestId('add-action').bounds()).width).toBeLessThanOrEqual(31)

      await automation.getByTestId('toggle-diff').click()
      await Bun.sleep(SPRING_SETTLE_MS + 80)
      root.renderer.flush()
      expect((await automation.getByTestId('right-panel-host').bounds()).width).toBeCloseTo(820, 0)
      expect(await automation.getByTestId('right-panel-fullscreen').count()).toBe(0)
    } finally {
      await automation.close()
      root.unmount()
      ui.dispose()
      themeManager.dispose()
      await controller.dispose()
    }
  }, 10_000)
})
