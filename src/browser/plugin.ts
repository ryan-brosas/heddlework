import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { ChromeBrowserBackend } from './chrome-backend.ts'
import { browserDataRoot, browserStatePath } from './persistence.ts'
import { BrowserSessionService } from './service.ts'

export const browserSessionToken = serviceToken<BrowserSessionService>('browser-session')
export const chromeBrowserToken = serviceToken<ChromeBrowserBackend>('chrome-browser')

export function createBrowserPlugin(options: {
  statePath?: string | false
  dataRoot?: string
  cleanupOrphanedProfiles?: boolean
} = {}): WorkbenchPlugin {
  return {
    id: 'browser-session',
    activate(ctx) {
      const service = new BrowserSessionService({
        statePath: options.statePath ?? browserStatePath(),
        dataRoot: options.dataRoot ?? browserDataRoot(),
        cleanupOrphanedProfiles: options.cleanupOrphanedProfiles ?? true,
      })
      ctx.provide(browserSessionToken, service)
      ctx.effect(() => () => service.dispose())
      // The managed Chrome process is app-owned: it starts lazily with the first tab and is awaited on
      // unload, so quitting never leaves a browser behind holding the app's profile directory.
      const chrome = new ChromeBrowserBackend({ dataDirectory: options.dataRoot ?? browserDataRoot() })
      ctx.provide(chromeBrowserToken, chrome)
      ctx.effect(() => () => chrome.dispose())
    },
  }
}
