/**
 * Live integration probe for the managed-Chrome browser surface.
 *
 * This is the check that the sidebar actually browses: it drives the real `BrowserSessionService` command
 * contract into a real Chrome process over the private debugging pipe, then reads the page back. Unit tests
 * cover the planners; this covers the parts that only exist at runtime - a frame really arrives, a planned
 * click really lands, and quitting really leaves no browser behind.
 *
 * Run: bun scripts/chrome-sidebar-probe.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChromeBrowserBackend } from '../src/browser/chrome-backend.ts'
import { planChromeKey, planChromePointer } from '../src/browser/chrome-plan.ts'
import { findChromeExecutable } from '../src/browser/chrome-process.ts'
import { BrowserSessionService } from '../src/browser/service.ts'

const VIEWPORT = { width: 900, height: 620 }

interface Result {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const results: Result[] = []
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

async function waitFor<T>(description: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(120)
  }
}

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Heddlework Chrome Fixture</title></head>
<body style="margin:0;background:#101114;color:#eee;font:14px sans-serif">
<input id="text" style="position:absolute;left:24px;top:24px;width:220px;height:32px">
<button id="go" style="position:absolute;left:24px;top:80px;width:180px;height:40px">Go</button>
<button id="hist" style="position:absolute;" onclick="location.href='/second'">History</button>
<button id="pop" style="position:absolute;left:24px;top:200px;width:180px;height:40px" onclick="window.open('/popup','_blank')">Pop</button>
<script>
  window.__clicked = false
  window.__keys = []
  document.getElementById('go').addEventListener('click', () => { window.__clicked = true; document.title = 'clicked' })
  document.getElementById('hist').style.position = 'absolute'
  document.getElementById('hist').style.left = '24px'
  document.getElementById('hist').style.top = '140px'
  document.getElementById('hist').style.width = '180px'
  document.getElementById('hist').style.height = '40px'
  document.addEventListener('keydown', (event) => { window.__keys.push(event.key) })
</script>
</body></html>`

const second = '<!doctype html><html><head><title>Heddlework Second</title></head><body>second page</body></html>'
const popup = '<!doctype html><html><head><title>Heddlework Popup</title></head><body>popup page</body></html>'

// Checked before any probe resource exists: a host without Chrome should skip without leaving a temp root
// behind, which is what the early exit used to do by bypassing the cleanup below.
if (!findChromeExecutable()) {
  console.log('SKIP  no Chrome or Chromium executable was found on this host')
  process.exit(0)
}

let fixtureHits = 0
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/second') return new Response(second, { headers: { 'content-type': 'text/html' } })
    if (path === '/popup') return new Response(popup, { headers: { 'content-type': 'text/html' } })
    fixtureHits += 1
    return new Response(fixture, { headers: { 'content-type': 'text/html' } })
  },
})
const base = `http://127.0.0.1:${server.port}/`

const dataRoot = mkdtempSync(join(tmpdir(), 'heddlework-chrome-probe-'))
const service = new BrowserSessionService({ statePath: false, dataRoot })
const backend = new ChromeBrowserBackend({ dataDirectory: dataRoot })

// The same bridge the host component installs: Chrome's state is the authority for its tabs.
const unsubscribe = backend.subscribe((event) => {
  if (event.kind === 'state') service.applyNativeState(event.tabId, event.state)
  else if (event.kind === 'popup') service.openRequested(event.tabId, event.generation, event.url)
})

const frames = new Map<string, number>()
function watch(tabId: string, generation: number): void {
  backend.subscribeFrames(tabId, generation, (data) => {
    if (data.startsWith('/9j')) frames.set(tabId, (frames.get(tabId) ?? 0) + 1)
  })
}

// The host's reconcile step, run on demand so the probe stays deterministic.
async function reconcile(): Promise<void> {
  const live = new Set<string>()
  for (const tab of service.getSnapshot().tabs) {
    if (!tab.materialized || !tab.url) continue
    live.add(tab.id)
    await backend.open({ tabId: tab.id, generation: tab.generation, profileId: tab.profileId, incognito: false, viewport: VIEWPORT })
    watch(tab.id, tab.generation)
    await backend.applyCommands(tab.id, tab.generation, tab.commands, tab.commandSerial)
  }
  for (const tabId of backend.openTabIds) if (!live.has(tabId)) await backend.close(tabId)
}

/** The host's reconcile step without the serialization: every tab asks for its session at once. */
async function reconcileConcurrently(): Promise<void> {
  const tabs = service.getSnapshot().tabs.filter((tab) => tab.materialized && tab.url)
  await Promise.all(tabs.map((tab) => backend.open({ tabId: tab.id, generation: tab.generation, profileId: tab.profileId, incognito: false, viewport: VIEWPORT })))
  for (const tab of tabs) watch(tab.id, tab.generation)
  await Promise.all(tabs.map((tab) => backend.applyCommands(tab.id, tab.generation, tab.commands, tab.commandSerial)))
}

/** Read page state back through the same session the surface uses. */
async function evaluate(tabId: string, expression: string): Promise<unknown> {
  return backend.evaluate(tabId, expression)
}

let exitCode = 0
try {
  // Two tabs exist before Chrome does, and they are opened at the same instant: this is the race that must
  // share one app-owned browser, because a second launch against the same profile directory fails.
  const tabId = service.createTab({ address: base })
  const racingTabId = service.createTab({ address: `${base}second` })
  await reconcileConcurrently()
  await reconcile()
  await backend.setViewport(tabId, VIEWPORT.width, VIEWPORT.height)
  await reconcile()

  // The title is Chrome's, reported after the load event, so it is waited for rather than asserted early.
  const ready = await waitFor('the fixture to load', () => {
    const tab = service.getSnapshot().tabs.find((candidate) => candidate.id === tabId)
    return tab && tab.status === 'ready' && tab.url === base && tab.title === 'Heddlework Chrome Fixture' ? tab : undefined
  })
  record('a tab navigates through the service command queue', ready.url === base && ready.title === 'Heddlework Chrome Fixture', `url=${ready.url} title=${ready.title}`)
  record('Chrome frames reach the surface', await waitFor('a jpeg frame', () => (frames.get(tabId) ?? 0) > 0 ? true : undefined).catch(() => false) === true, `${frames.get(tabId) ?? 0} frames`)
  record('two tabs opened at once share one Chrome', await waitFor('the racing tab to stream too', () => (frames.get(racingTabId) ?? 0) > 0 ? true : undefined, 20_000).catch(() => false) === true, `${frames.get(racingTabId) ?? 0} frames on the second tab`)

  // Input lands where the planner says it does: measure the real element, plan a click, dispatch it.
  const box = await evaluate(tabId, "(() => { const rect = document.getElementById('go').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()") as { x: number; y: number }
  const bounds = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }
  const pressed = planChromePointer({ x: box.x, y: box.y, button: 0, clickCount: 1 }, bounds, 'mousePressed')
  const released = planChromePointer({ x: box.x, y: box.y, button: 0, clickCount: 1 }, bounds, 'mouseReleased')
  if (pressed && released) await backend.input(tabId, [{ method: 'Input.dispatchMouseEvent', params: pressed }, { method: 'Input.dispatchMouseEvent', params: released }])
  const clicked = await waitFor('the page to report the click', () => evaluate(tabId, 'window.__clicked === true'), 8_000).catch(() => false)
  record('a planned click reaches the page', clicked === true, `pointer at ${Math.round(box.x)},${Math.round(box.y)}`)

  // Focus the field through the same planned-click path, then type: the whole chain, not just the API.
  const textBox = await evaluate(tabId, "(() => { const rect = document.getElementById('text').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()") as { x: number; y: number }
  const textPressed = planChromePointer({ x: textBox.x, y: textBox.y, button: 0, clickCount: 1 }, bounds, 'mousePressed')
  const textReleased = planChromePointer({ x: textBox.x, y: textBox.y, button: 0, clickCount: 1 }, bounds, 'mouseReleased')
  if (textPressed && textReleased) await backend.input(tabId, [{ method: 'Input.dispatchMouseEvent', params: textPressed }, { method: 'Input.dispatchMouseEvent', params: textReleased }])
  const textPlan = planChromeKey({ key: 'h', keyChar: 'h' })
  if (textPlan.kind === 'text') await backend.input(tabId, [{ method: 'Input.insertText', params: { text: 'heddlework' } }])
  const typed = await waitFor('the field to hold the typed text', () => evaluate(tabId, "document.getElementById('text').value === 'heddlework' ? 'heddlework' : undefined"), 8_000).catch(() => undefined)
  record('a clicked field receives typed text', typed === 'heddlework', `field held "${String(typed ?? '')}"`)

  const enter = planChromeKey({ key: 'Enter' })
  if (enter.kind === 'press') await backend.input(tabId, [{ method: enter.params.method as string, params: (enter.params.params ?? {}) as Record<string, unknown> }])
  const keys = await evaluate(tabId, 'JSON.stringify(window.__keys)') as string
  record('a named key is dispatched as a key event', enter.kind === 'press' && keys.includes('Enter'), `page saw ${keys}`)

  // History through the real Chrome history stack.
  service.navigate(tabId, `${base}second`)
  await reconcile()
  await waitFor('the second page', () => {
    const tab = service.getSnapshot().tabs.find((candidate) => candidate.id === tabId)
    return tab && tab.status === 'ready' && tab.url === `${base}second` && tab.canGoBack ? tab : undefined
  })
  service.command(tabId, 'back')
  await reconcile()
  const wentBack = await waitFor('history back', () => {
    const tab = service.getSnapshot().tabs.find((candidate) => candidate.id === tabId)
    return tab && tab.url === base && tab.canGoForward ? tab : undefined
  }, 10_000).catch(() => undefined)
  record('back and forward follow Chrome history', Boolean(wentBack), wentBack ? `url=${wentBack.url}` : 'did not return to the first page')

  // Re-applying an acknowledged command must not run it again.
  const hitsBefore = fixtureHits
  await reconcile()
  await reconcile()
  await Bun.sleep(400)
  record('an acknowledged command is not applied twice', fixtureHits === hitsBefore, `${hitsBefore} -> ${fixtureHits} fixture loads`)

  // A page-directed popup becomes an app tab instead of a hidden Chrome window.
  const popBox = await evaluate(tabId, "(() => { const rect = document.getElementById('pop').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()") as { x: number; y: number }
  const popPressed = planChromePointer({ x: popBox.x, y: popBox.y, button: 0, clickCount: 1 }, bounds, 'mousePressed')
  const popReleased = planChromePointer({ x: popBox.x, y: popBox.y, button: 0, clickCount: 1 }, bounds, 'mouseReleased')
  if (popPressed && popReleased) await backend.input(tabId, [{ method: 'Input.dispatchMouseEvent', params: popPressed }, { method: 'Input.dispatchMouseEvent', params: popReleased }])
  // Found by its own address: any-other-tab would be satisfied by the tab the race left open.
  const popupTab = await waitFor('the popup to become a tab', () => {
    return service.getSnapshot().tabs.find((tab) => tab.url === `${base}popup`)
  }, 12_000).catch(() => undefined)
  record('a page popup becomes an app-managed tab', popupTab !== undefined, popupTab ? `url=${popupTab.url}` : 'no popup tab')
} catch (error) {
  record('probe completed without an unexpected failure', false, error instanceof Error ? error.message : String(error))
} finally {
  unsubscribe()
  await service.dispose()
  await backend.dispose()
  server.stop(true)

  // A reusable profile directory is the proof that the browser actually exited.
  const relaunch = await import('../src/browser/chrome-process.ts')
  try {
    const chrome = await relaunch.ManagedChrome.launch(dataRoot)
    await chrome.dispose()
    record('quitting leaves no browser holding the profile', true)
  } catch (error) {
    record('quitting leaves no browser holding the profile', false, error instanceof Error ? error.message : String(error))
  }
  rmSync(dataRoot, { recursive: true, force: true })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) exitCode = 1
}

process.exit(exitCode)
