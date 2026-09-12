import { Window } from 'happy-dom'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createInitialState } from '../src/workbench/state.ts'
import { colors } from '../src/ui/theme.ts'
// Desktop width: 1024 is exactly the tablet breakpoint, and a compact layout forces the
// lifecycle controls onto every card, which would make the idle mark-only branch untestable.
const window = new Window({ url: `http://localhost/#token=${'a'.repeat(43)}`, width: 1_280, height: 900 })
window.document.body.innerHTML = '<div id="root"></div>'
const initial = createInitialState('/workspace/mobile')
const sessionPath = '/workspace/mobile/session-1.jsonl'
const state = {
  ...initial,
  connection: 'connected' as const,
  connectionMessage: 'Connected',
  // One active, streaming session so the sidebar card renders its running controls: the card
  // surface and both controls must share a single fill, and the running label must stay animated.
  session: { ...initial.session, isStreaming: true, sessionFile: sessionPath },
  sessions: [{
    id: 'session-1',
    path: sessionPath,
    cwd: '/workspace/mobile',
    title: 'Measure the turn',
    firstMessage: 'Measure the turn',
    messageCount: 2,
    createdAt: 1,
    modifiedAt: Date.now(),
  }, {
    // A second, idle session: `showLifecycleActions` is false there, so that card must render the
    // harness mark alone, with no lifecycle controls and no running treatment.
    id: 'session-2',
    path: '/workspace/mobile/session-2.jsonl',
    cwd: '/workspace/mobile',
    title: 'Idle thread',
    firstMessage: 'Idle thread',
    messageCount: 1,
    createdAt: 1,
    modifiedAt: Date.now() - 5 * 60 * 1_000,
  }],
  // A session status line is chat content (Pi's showStatus), so it must render in the transcript
  // and must never surface as an extension notification banner.
  messages: [
    { role: 'user' as const, content: 'Measure the turn', timestamp: 1 },
    { role: 'assistant' as const, content: 'Measured.', timestamp: 2 },
  ],
  statusLines: [{ id: 1, text: 'TPS 25.6 tok/s', createdAt: 3, turn: 0 }],
}
class FakeWebSocket extends window.EventTarget {
  static readonly OPEN = 1; readyState = 0; bufferedAmount = 0
  constructor(readonly url: string) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new window.Event('open')) }) }
  send(raw: string) { const message = JSON.parse(raw) as { kind: string }; if (message.kind === 'hello') queueMicrotask(() => this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ kind: 'welcome', protocol: 2, workspacePath: '/workspace/mobile', snapshot: state, flows: { schedules: [], pending: [] }, terminal: { sessions: [] } }) }))) }
  close() { this.readyState = 3; this.dispatchEvent(new window.Event('close')) }
}
const globals = globalThis as unknown as Record<string, unknown>
Object.assign(globals, { window, document: window.document, navigator: window.navigator, location: window.location, history: window.history, localStorage: window.localStorage, sessionStorage: window.sessionStorage, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MessageEvent: window.MessageEvent, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, InputEvent: window.InputEvent, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), WebSocket: FakeWebSocket })
await import(`${pathToFileURL(resolve(import.meta.dir, '../dist/web/main.js')).href}?probe=${Date.now()}`)
for (let attempt = 0; attempt < 200 && !window.document.querySelector('[data-testid="workbench-root"]'); attempt += 1) await Bun.sleep(10)
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
assert(window.document.querySelector('[data-testid="workbench-root"]'), 'Shared WorkbenchApp did not mount')
assert(window.document.querySelector('[data-testid="workbench-main"]'), 'Workbench main surface did not mount')
assert(window.location.hash === '', 'Pairing fragment was not stripped')
assert(window.sessionStorage.getItem('heddlework.token') === 'a'.repeat(43), 'Pairing token was not retained for this tab')
assert(!window.document.documentElement.outerHTML.includes('windowdragregion'), 'Native drag props leaked into DOM')
assert(window.document.body.textContent?.includes('TPS 25.6 tok/s'), 'Session status line did not render in the transcript')
assert(!window.document.querySelector('[data-testid="composer-notification-stack"]'), 'Extension status leaked into a notification banner')
// Pi's showStatus line carries no notification chrome: no card, no border, no timestamp. Asserting the
// exact text also proves no time-of-day element was appended beside it.
const statusLine = window.document.querySelector('[data-testid="session-status-line"]')
assert(statusLine, 'Pi showStatus line did not render as a session status line')
assert(statusLine.textContent?.trim() === 'TPS 25.6 tok/s', `Pi showStatus line carried extra chrome: ${statusLine.textContent}`)
const statusLineCss = statusLine.getAttribute('style') ?? ''
assert(!/(^|;)\s*(background-color|border-width|border-color)\s*:/u.test(statusLineCss), `Pi showStatus line rendered notification chrome: ${statusLineCss}`)
assert(!window.document.querySelector('[data-testid="session-status-line"] [data-testid^="timestamp"]'), 'Pi showStatus line rendered a timestamp')
// At desktop width the sidebar is inline; a compact window would render it as a closed overlay.
const sidebarToggle = window.document.querySelector('[data-testid="toggle-left-sidebar"]')
if (window.document.querySelector('[data-testid="sidebar"]') === null) {
  assert(sidebarToggle, 'Sidebar toggle did not render')
  sidebarToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await Bun.sleep(250)
}
assert(window.document.querySelector('[data-testid="sidebar"]') !== null, 'Sidebar did not render')
// The session card controls sit above the card, so their opaque fill has to match the surface
// underneath: filling with the bare sidebar colour punches a dark slab into an active card and
// spilled past the card padding when the action slot was fixed-width.
// Structural typing: happy-dom's Element is not the DOM lib's Element.
const styleOf = (element: { getAttribute(name: string): string | null }) => element.getAttribute('style') ?? ''
const fillOf = (element: { getAttribute(name: string): string | null }) => (/background-color:\s*([^;]+)/u.exec(styleOf(element))?.[1] ?? '').trim()
const card = window.document.querySelector('[data-testid="sidebar-session-card-active"]')
assert(card, 'Sidebar session card did not render for the active streaming session')
const surface = card.querySelector('[data-testid="sidebar-session-surface"]')
const snooze = card.querySelector('[data-testid="sidebar-snooze"]')
const settle = card.querySelector('[data-testid="sidebar-settle"]')
assert(surface, 'Session card surface did not render')
assert(snooze, 'Session snooze control did not render')
assert(settle, 'Session settle control did not render')
const brand = window.document.querySelector('[data-testid="sidebar-brand"]')
assert(brand, 'Sidebar brand did not render')
const surfaceFill = fillOf(surface)
const pageFill = fillOf(brand)
assert(surfaceFill.length > 0 && pageFill.length > 0, 'Card fills were not rendered inline')
assert(surfaceFill !== pageFill, `Active card reused the bare sidebar fill ${surfaceFill}`)
assert(fillOf(snooze) === surfaceFill, `Snooze control filled ${fillOf(snooze)} instead of the card surface ${surfaceFill}`)
assert(fillOf(settle) === surfaceFill, `Settle control filled ${fillOf(settle)} instead of the card surface ${surfaceFill}`)
// The Pi mark is the card's harness identity: it must coexist with the lifecycle controls on a
// live card, stay the rightmost element of the row, and keep its brand colour unclipped.
const badge = card.querySelector('[data-testid="sidebar-harness-badge"]')
assert(badge, 'Active card lost the Pi harness mark to the lifecycle controls')
assert(badge.textContent === 'π', `Harness mark rendered ${JSON.stringify(badge.textContent)}`)
assert(/color:\s*#E9705A/iu.test(styleOf(badge)), `Harness mark lost its brand colour: ${styleOf(badge)}`)
assert(/flex-shrink:\s*0/u.test(styleOf(badge)), 'Harness mark was shrinkable and could be clipped')
const badgeRow = badge.parentElement
assert(badgeRow, 'Harness mark had no parent row')
assert(badgeRow.querySelector('[data-testid="sidebar-snooze"]') !== null, 'Harness mark replaced the snooze control')
assert(Array.from(badgeRow.children).at(-1) === badge, 'Harness mark was not the rightmost element of the row')
// The running label is the animated shimmer, and it sits on the metadata row beside the branch.
const status = card.querySelector('[data-testid="sidebar-session-status"]')
assert(status, 'Running session rendered no status label')
assert(status.classList.contains('gx-shimmer'), `Running session label was not the animated shimmer: ${status.outerHTML}`)
assert(/animation-duration/u.test(styleOf(status)), 'Shimmer label carried no animation duration')
assert(status.parentElement?.textContent?.includes('main') === true, 'Status label did not sit on the session metadata row beside the branch')
// The idle card takes the other branch of the same decision: no lifecycle controls, so the
// harness mark is the only element in the action slot, and the running shimmer stays scoped to
// the session that is actually running.
const idleCard = window.document.querySelector('[data-testid="sidebar-session-card"]')
assert(idleCard, 'Idle session card did not render')
const idleBadge = idleCard.querySelector('[data-testid="sidebar-harness-badge"]')
assert(idleBadge, 'Idle card lost the Pi harness mark')
const idleSlot = idleBadge.parentElement
assert(idleSlot, 'Idle harness mark had no parent row')
assert(Array.from(idleSlot.children).at(-1) === idleBadge, 'Idle harness mark was not the rightmost element of the row')
assert(idleSlot.children.length === 1, `Idle action slot rendered ${idleSlot.children.length} children; only the harness mark belongs there`)
const idleStatus = idleCard.querySelector('[data-testid="sidebar-session-status"]')
assert(idleStatus, 'Idle card lost its status label')
assert(!idleStatus.classList.contains('gx-shimmer'), 'Idle card showed the running shimmer')
assert(/^\d+m$/u.test(idleStatus.textContent ?? ''), `Idle card status was ${JSON.stringify(idleStatus.textContent)}`)
console.log('web DOM probe passed')
process.exit(0)
