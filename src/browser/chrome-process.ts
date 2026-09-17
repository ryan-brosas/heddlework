import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from './cdp.ts'

export function findChromeExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.HEDDLEWORK_CHROME_PATH
  if (configured) return isAbsolute(configured) ? Bun.which(configured) ?? undefined : undefined
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const found = Bun.which(name)
    if (found) return found
  }
  return undefined
}

export class ManagedChrome {
  readonly cdp: CdpConnection
  readonly exited: Promise<void>
  #stopping: Promise<void> | undefined

  private constructor(private readonly child: ChildProcess) {
    this.cdp = new CdpConnection(child.stdio[4] as Readable, child.stdio[3] as Writable)
    this.exited = new Promise((resolve) => {
      child.once('exit', () => { this.cdp.close(); resolve() })
      child.once('error', () => { this.cdp.close(); resolve() })
    })
    // Drain stderr without retaining page URLs, cookies, or protocol contents in logs.
    child.stderr?.resume()
  }

  static async launch(dataDirectory: string, executable = findChromeExecutable()): Promise<ManagedChrome> {
    if (!executable) throw new Error('Chrome was not found. Install Chrome/Chromium or set HEDDLEWORK_CHROME_PATH to its absolute executable path, then restart Heddlework.')
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const child = spawn(executable, [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dataDirectory}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-sync', '--disable-extensions', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const chrome = new ManagedChrome(child)
    try {
      await chrome.cdp.send('Browser.getVersion')
      await chrome.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
      return chrome
    } catch {
      await chrome.dispose()
      throw new Error('Chrome could not start. Check the executable, sandbox support, and whether this managed profile is already in use. Your normal Chrome profile is not used.')
    }
  }

  dispose(): Promise<void> {
    return this.#stopping ??= this.#stop()
  }

  async #stop(): Promise<void> {
    const child = this.child
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') child.kill(name)
        else process.kill(-child.pid, name)
      } catch { /* Already exited. Never signal an unrelated process. */ }
    }
    signal('SIGTERM')
    const timer = setTimeout(() => signal('SIGKILL'), 2_000)
    try { await this.exited } finally {
      clearTimeout(timer)
      this.cdp.close()
      for (const stream of child.stdio) stream?.destroy()
    }
  }
}
