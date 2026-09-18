import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claimBrowserDataRoot } from '../src/browser/persistence.ts'
import { BrowserSessionService } from '../src/browser/service.ts'

const roots: string[] = []

function storage(): { dataRoot: string; canonical: string } {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-lock-'))
  roots.push(root)
  const dataRoot = join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  return { dataRoot, canonical: realpathSync(dataRoot) }
}

/** A pid that is guaranteed to have exited, so "the holder is gone" is a fact rather than an assumption. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['sleep', '0.01'], { stdio: ['ignore', 'ignore', 'ignore'] })
  const pid = child.pid
  await child.exited
  return pid
}

function staleLock(path: string, pid: number): void {
  writeFileSync(path, `${pid}\n`, { encoding: 'utf8', mode: 0o600 })
  // Older than the settle window, so the lock is not one that is still being written.
  const past = new Date(Date.now() - 60_000)
  utimesSync(path, past, past)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('browser profile locks', () => {
  it('reclaims a lock whose holder has exited', async () => {
    const { dataRoot, canonical } = storage()
    stubProfiles(canonical)
    staleLock(`${canonical}.lock`, await deadPid())
    staleLock(`${canonical}/profiles.lock`, await deadPid())

    const claim = claimBrowserDataRoot(dataRoot, false)
    expect(claim.acquired).toBe(true)
    expect(claim.profilesRoot).toBe(`${canonical}/profiles`)
    // The stale files are replaced by this process's claim, not left naming a dead pid.
    expect(readFileSync(`${canonical}.lock`, 'utf8').trim()).toBe(String(process.pid))
  })

  it('refuses a lock held by a living process and names it', () => {
    const { dataRoot, canonical } = storage()
    const lockPath = `${canonical}.lock`
    staleLock(lockPath, process.pid)

    const claim = claimBrowserDataRoot(dataRoot, false)
    expect(claim.acquired).toBe(false)
    expect(claim.message).toContain(`pid ${process.pid}`)
    // A live owner's lock is never rewritten by a process that lost the race for it.
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
  })

  it('refuses a lock it cannot attribute instead of deleting it', () => {
    const { dataRoot, canonical } = storage()
    const lockPath = `${canonical}.lock`
    writeFileSync(lockPath, 'not-a-pid\n', { encoding: 'utf8', mode: 0o600 })

    const claim = claimBrowserDataRoot(dataRoot, false)
    expect(claim.acquired).toBe(false)
    expect(claim.message).toContain('cannot identify')
    expect(readFileSync(lockPath, 'utf8')).toBe('not-a-pid\n')
  })

  it('leaves a lock written moments ago alone even when its pid is gone', async () => {
    const { dataRoot, canonical } = storage()
    const lockPath = `${canonical}.lock`
    // Freshly written: it could belong to a process that is still starting up.
    writeFileSync(lockPath, `${await deadPid()}\n`, { encoding: 'utf8', mode: 0o600 })

    const claim = claimBrowserDataRoot(dataRoot, false)
    expect(claim.acquired).toBe(false)
    expect(claim.message).toContain('cannot identify')
  })

  it('takes over nothing when one of its locks is still held', async () => {
    const { dataRoot, canonical } = storage()
    stubProfiles(canonical)
    staleLock(`${canonical}.lock`, await deadPid())
    staleLock(`${canonical}/profiles.lock`, process.pid)

    const claim = claimBrowserDataRoot(dataRoot, false)
    expect(claim.acquired).toBe(false)
    expect(readFileSync(`${canonical}/profiles.lock`, 'utf8').trim()).toBe(String(process.pid))
  })

  it('lets the browser service start when only stale locks remain', async () => {
    const { dataRoot, canonical } = storage()
    stubProfiles(canonical)
    staleLock(`${canonical}.lock`, await deadPid())
    staleLock(`${canonical}/profiles.lock`, await deadPid())

    const service = new BrowserSessionService({ statePath: false, dataRoot })
    // This is the failure the user saw: a leftover lock used to force the engine unavailable forever.
    expect(service.canInitializeNativeBrowser()).toBe(true)
    expect(service.runtimeProfile('workspace')).toBeDefined()
    expect(service.getSnapshot().engine.available).toBe(false)
    service.setEngine({ kind: 'chrome', available: true, message: 'Chrome', profileIsolation: 'limited' })
    expect(service.getSnapshot().engine.available).toBe(true)
    service.dispose()
  })

  it('lets exactly one process reclaim the same stale lock', async () => {
    const { dataRoot, canonical } = storage()
    stubProfiles(canonical)
    staleLock(`${canonical}.lock`, await deadPid())
    staleLock(`${canonical}/profiles.lock`, await deadPid())

    // Four processes race the same leftover lock; the winner holds it while the others try.
    const script = join(canonical, 'claim-child.ts')
    writeFileSync(script, [
      `import { claimBrowserDataRoot } from ${JSON.stringify(fileURLToPath(new URL('../src/browser/persistence.ts', import.meta.url)))}`,
      `const claim = claimBrowserDataRoot(${JSON.stringify(dataRoot)}, false)`,
      'console.log(claim.acquired ? "ACQUIRED" : "NO")',
      'await Bun.sleep(2_500)',
    ].join('\n'), 'utf8')

    const children = Array.from({ length: 4 }, () => Bun.spawn(['bun', script], {
      cwd: canonical,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    }))
    const outputs = await Promise.all(children.map(async (child) => {
      const text = await new Response(child.stdout).text()
      await child.exited
      return text
    }))
  expect(outputs.filter((text) => text.includes('ACQUIRED'))).toHaveLength(1)
  }, 30_000)

  it('still reports contention when another process owns the storage', () => {
    const { dataRoot, canonical } = storage()
    staleLock(`${canonical}.lock`, process.pid)

    const service = new BrowserSessionService({ statePath: false, dataRoot })
    expect(service.canInitializeNativeBrowser()).toBe(false)
    expect(service.runtimeProfile('workspace')).toBeUndefined()
    expect(service.getSnapshot().engine).toMatchObject({ kind: 'unavailable', available: false })
    expect(service.getSnapshot().engine.message).toContain(`pid ${process.pid}`)
    service.dispose()
  })
})

/** The profiles directory is part of the canonical identity, so it must exist before a claim is made. */
function stubProfiles(canonical: string): void {
  mkdirSync(join(canonical, 'profiles'), { recursive: true })
}
