import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  console.log('[heddlework-browser-smoke] skipped: macOS only')
  process.exit(0)
}

const root = resolve(import.meta.dir, '..')
const app = resolve(root, 'dist', 'Heddlework.app')
const executable = resolve(app, 'Contents', 'MacOS', 'Heddlework')
if (!existsSync(executable)) throw new Error(`Build the packaged app first: ${executable}`)

const temporary = mkdtempSync(join(tmpdir(), 'heddlework-browser-smoke-'))
let requests = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    requests += 1
    const path = new URL(request.url).pathname
    return new Response(`<!doctype html><html><head><title>Heddlework Browser Smoke ${path}</title></head><body><label>Smoke input <input id="smoke-input"></label></body></html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  },
})

const netLogPath = resolve(temporary, 'netlog.json')
const child = Bun.spawn([
  executable,
  '--disable-features=ValidateNetworkServiceProcessIdentity',
  '--use-mock-keychain',
  '--enable-logging=stderr',
  '--v=1',
  `--log-net-log=${netLogPath}`,
  '--net-log-capture-mode=Everything',
], {
  cwd: root,
  env: {
    ...process.env,
    HEDDLEWORK_DEMO: '1',
    HEDDLEWORK_BROWSER_DATA_DIR: resolve(temporary, 'data'),
    HEDDLEWORK_BROWSER_SMOKE_URL: process.env.HEDDLEWORK_BROWSER_SMOKE_URL ?? `http://127.0.0.1:${server.port}/initial`,
    GPUIX_CEF_DEBUG: '1',
  },
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
})
const stdoutPromise = new Response(child.stdout).text()
const stderrPromise = new Response(child.stderr).text()
let sawSandboxedHelper = false
let lastProcessList = ''
let monitorBusy = false
const helperNeedle = `${app}/Contents/Frameworks/Heddlework Helper`
const monitor = setInterval(() => {
  if (monitorBusy) return
  monitorBusy = true
  const result = Bun.spawn(['/bin/ps', '-axo', 'command='], { stdout: 'pipe', stderr: 'ignore' })
  void new Response(result.stdout).text().then((processes) => {
    lastProcessList = processes.split('\n').filter((line) => line.includes(helperNeedle)).join('\n')
    if (processes.split('\n').some((line) => line.includes(helperNeedle) && line.includes('--seatbelt-client'))) {
      sawSandboxedHelper = true
    }
  }).finally(() => { monitorBusy = false })
}, 250)

let timedOut = false
try {
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(45_000).then(() => {
      timedOut = true
      child.kill()
      return -1
    }),
  ])
  clearInterval(monitor)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const configuredViewsWindows = stderr.match(/\[gpuix-cef\] frameless Views window style=\d+ tabbing=2/g)?.length ?? 0
  const closedBrowsers = stderr.match(/\[gpuix-cef\] browser closed/g)?.length ?? 0
  const destroyedViewsWindows = stderr.match(/\[gpuix-cef\] browser Views window destroyed/g)?.length ?? 0
  if (
    timedOut
    || exitCode !== 0
    || !stdout.includes('[heddlework-browser-smoke] passed')
    || !stderr.includes('[gpuix-cef] shutting down 1 browser(s), 0 pending creation(s)')
    || !stderr.includes('[gpuix-cef] browser closed remaining=0')
    || configuredViewsWindows < 3
    || closedBrowsers < 3
    || destroyedViewsWindows < 3
    || requests < 4
    || !sawSandboxedHelper
  ) {
    const chromiumLogPath = resolve(temporary, 'data', 'profiles', 'chromium.log')
    const chromiumLog = existsSync(chromiumLogPath) ? readFileSync(chromiumLogPath, 'utf8') : ''
    const netLog = existsSync(netLogPath) ? readFileSync(netLogPath, 'utf8') : ''
    writeFileSync('/tmp/heddlework-cef-netlog.json', netLog)
    throw new Error([
      `Packaged browser smoke failed (exit=${exitCode}, requests=${requests}, sandboxedHelper=${sawSandboxedHelper})`,
      `configuredViewsWindows=${configuredViewsWindows}, closedBrowsers=${closedBrowsers}, destroyedViewsWindows=${destroyedViewsWindows}`,
      stdout.slice(-8_000),
      stderr.slice(-8_000),
      chromiumLog.slice(-8_000),
      `netlog-bytes=${netLog.length} contains-smoke-url=${netLog.includes(String(server.port))}`,
      lastProcessList,
    ].filter(Boolean).join('\n'))
  }
  console.log(`[heddlework-browser-smoke] verified ${requests} requests, isolated profiles, tab teardown, FIFO commands, sandboxed helpers, CEF Views teardown, and clean shutdown`)
} finally {
  clearInterval(monitor)
  if (timedOut) await child.exited.catch(() => undefined)
  await server.stop(true)
  rmSync(temporary, { recursive: true, force: true })
}
