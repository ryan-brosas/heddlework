import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { PersistedBrowserState } from './types.ts'

export function readBrowserState(path: string | false): PersistedBrowserState | undefined {
  if (!path) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || !Array.isArray(value.tabs)) return undefined
    const profiles = value.profiles.filter(isRecord) as unknown as PersistedBrowserState['profiles']
    const tabs = value.tabs.filter(isPersistedTab)
    const defaultProfileId = typeof value.defaultProfileId === 'string' ? value.defaultProfileId : 'workspace'
    const activeTabId = typeof value.activeTabId === 'string' ? value.activeTabId : undefined
    return { version: 1, profiles, defaultProfileId, tabs, ...(activeTabId ? { activeTabId } : {}) }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPersistedTab(value: unknown): value is PersistedBrowserState['tabs'][number] {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.profileId === 'string'
    && typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.lastActiveAt === 'number'
    && Number.isFinite(value.lastActiveAt)
}

export function writeBrowserState(path: string | false, state: PersistedBrowserState): void {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch {
    // Live browser state still works when preferences cannot be persisted.
  }
}

export function browserStatePath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(browserConfigRoot(platform, environment, home), 'browser.json')
}

export function browserDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (environment.HEDDLEWORK_BROWSER_DATA_DIR) return environment.HEDDLEWORK_BROWSER_DATA_DIR
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'Browser')
  if (platform === 'win32') return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Heddlework', 'Browser')
  return join(environment.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'heddlework', 'browser')
}

export function browserProfilesRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(browserDataRoot(platform, environment, home), 'profiles')
}

export interface BrowserDataRootClaim {
  acquired: boolean
  dataRoot?: string | undefined
  profilesRoot?: string | undefined
  statePath?: string | false | undefined
  message?: string | undefined
}

interface BrowserDataLockRegistry {
  owned: Set<string>
  cleanupRegistered: boolean
}

const lockGlobal = globalThis as typeof globalThis & {
  __heddleworkBrowserDataLocks?: BrowserDataLockRegistry | undefined
}
const lockRegistry = lockGlobal.__heddleworkBrowserDataLocks ??= {
  owned: new Set<string>(),
  cleanupRegistered: false,
}

/**
 * Why a lock could not be claimed. The distinction is what lets a refusal tell the truth: a lock held by a
 * live process is contention the user can act on, while a lock nobody can be identified behind is not.
 */
type LockClaim = 'acquired' | 'held' | 'unidentified'

/**
 * How long a lock must sit unchanged before a dead holder's lock may be reclaimed.
 *
 * A lock written moments ago can belong to a process that is still starting up, and a lock being rewritten
 * belongs to whoever is writing it. Only a lock that has stopped changing and names a process that is
 * definitely gone is stale.
 */
const STALE_LOCK_SETTLE_MS = 2_000

export function claimBrowserDataRoot(dataRoot: string, statePath: string | false = false): BrowserDataRootClaim {
  let paths: Required<Pick<BrowserDataRootClaim, 'dataRoot' | 'profilesRoot' | 'statePath'>>
  try {
    paths = canonicalBrowserStorage(dataRoot, statePath)
  } catch {
    return unavailableDataRoot('Browser profile storage is unavailable: its directories could not be prepared.')
  }

  const lockPaths = [
    `${paths.dataRoot}.lock`,
    `${paths.profilesRoot}.lock`,
    ...(paths.statePath ? [`${paths.statePath}.lock`] : []),
  ].sort()
  const newlyOwned: string[] = []

  for (const lockPath of new Set(lockPaths)) {
    if (lockRegistry.owned.has(lockPath) && readLockPid(lockPath) === process.pid) continue
    lockRegistry.owned.delete(lockPath)

    let claim: LockClaim
    try {
      mkdirSync(dirname(lockPath), { recursive: true })
      claim = claimLock(lockPath)
    } catch {
      claim = 'unidentified'
    }

    if (claim !== 'acquired') {
      const heldBy = claim === 'held' ? readLockPid(lockPath) : undefined
      rollbackClaims(newlyOwned)
      return unavailableDataRoot(lockRefusalMessage(claim, lockPath, heldBy), paths)
    }
    lockRegistry.owned.add(lockPath)
    newlyOwned.push(lockPath)
  }

  registerLockCleanup()
  return { acquired: true, ...paths }
}

/**
 * Claim one lock, reclaiming it only when its recorded holder is provably gone.
 *
 * A crash used to leave the browser surface permanently unavailable, because an exclusive create cannot
 * tell a live owner from a leftover file. Reclaiming is deliberately narrow: the holder's pid must be dead
 * (not merely unreadable), the lock must have stopped changing, and the takeover must be atomic and
 * verified afterwards. Anything else stays fail-closed, as before.
 */
function claimLock(lockPath: string): LockClaim {
  if (lstatSync(lockPath, { throwIfNoEntry: false })?.isSymbolicLink()) return 'unidentified'
  if (process.platform === 'darwin') return claimMacOSLock(lockPath) ? 'acquired' : 'held'
  if (tryCreateLockFile(lockPath)) return 'acquired'
  const holder = readLockPid(lockPath)
  if (holder === undefined) return 'unidentified'
  if (processIsAlive(holder)) return 'held'
  return takeOverStaleLock(lockPath, holder) ? 'acquired' : 'unidentified'
}

function canonicalBrowserStorage(
  dataRoot: string,
  statePath: string | false,
): Required<Pick<BrowserDataRootClaim, 'dataRoot' | 'profilesRoot' | 'statePath'>> {
  const requestedDataRoot = resolve(dataRoot)
  mkdirSync(requestedDataRoot, { recursive: true })
  const canonicalDataRoot = realpathSync(requestedDataRoot)
  const requestedProfilesRoot = join(canonicalDataRoot, 'profiles')
  mkdirSync(requestedProfilesRoot, { recursive: true })
  const profilesRoot = realpathSync(requestedProfilesRoot)

  if (!statePath) return { dataRoot: canonicalDataRoot, profilesRoot, statePath: false }

  const requestedStatePath = resolve(statePath)
  mkdirSync(dirname(requestedStatePath), { recursive: true })
  const canonicalParent = realpathSync(dirname(requestedStatePath))
  const canonicalCandidate = join(canonicalParent, basename(requestedStatePath))
  const stateEntry = lstatSync(canonicalCandidate, { throwIfNoEntry: false })
  const canonicalStatePath = stateEntry?.isSymbolicLink()
    ? realpathSync(canonicalCandidate)
    : canonicalCandidate
  return { dataRoot: canonicalDataRoot, profilesRoot, statePath: canonicalStatePath }
}

function rollbackClaims(lockPaths: string[]): void {
  for (const lockPath of lockPaths) {
    removeOwnedLock(lockPath)
    lockRegistry.owned.delete(lockPath)
  }
}

function claimMacOSLock(lockPath: string): boolean {
  const result = Bun.spawnSync(['/usr/bin/shlock', '-f', lockPath, '-p', String(process.pid)], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return result.exitCode === 0
}

function tryCreateLockFile(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/**
 * Whether a pid names a process that currently exists.
 *
 * Only `ESRCH` proves absence. `EPERM` means the process exists and belongs to someone else, which is
 * still a live owner, so anything other than `ESRCH` is treated as alive.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Reclaim a lock whose holder is gone, without ever unlinking a file that might belong to someone.
 *
 * The replacement is a rename of our own pid file over the leftover one, immediately re-read: only the
 * process whose pid survived is the owner, so the loser of a simultaneous takeover sees the winner and
 * reports contention rather than proceeding. The `wx` create that follows normal operation still refuses
 * an existing lock, so a live owner is never displaced by this path.
 */
function takeOverStaleLock(lockPath: string, holder: number): boolean {
  const entry = lstatSync(lockPath, { throwIfNoEntry: false })
  if (!entry || entry.isSymbolicLink()) return false
  if (Date.now() - entry.mtimeMs < STALE_LOCK_SETTLE_MS) return false
  if (readLockPid(lockPath) !== holder) return false
  const temporary = `${lockPath}.takeover-${process.pid}`
  try {
    writeFileSync(temporary, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, lockPath)
  } catch {
    rmSync(temporary, { force: true })
    return false
  }
  return readLockPid(lockPath) === process.pid
}

function lockRefusalMessage(claim: Exclude<LockClaim, 'acquired'>, lockPath: string, holder: number | undefined): string {
  if (claim === 'held') {
    return holder === undefined
      ? 'Browser profiles are locked by another Heddlework process. Close it before opening this browser.'
      : `Browser profiles are locked by another Heddlework process (pid ${holder}). Close it before opening this browser.`
  }
  return `Browser profile storage is locked by something Heddlework cannot identify. Remove ${lockPath} if no Heddlework process is running.`
}

function registerLockCleanup(): void {
  if (lockRegistry.cleanupRegistered) return
  lockRegistry.cleanupRegistered = true
  process.once('exit', () => {
    for (const lockPath of lockRegistry.owned) removeOwnedLock(lockPath)
    lockRegistry.owned.clear()
  })
}

function removeOwnedLock(lockPath: string): void {
  if (readLockPid(lockPath) !== process.pid) return
  try {
    rmSync(lockPath, { force: true })
  } catch {
    // A failed cleanup remains fail-closed on platforms without stale-lock recovery.
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function unavailableDataRoot(message: string, paths: Partial<BrowserDataRootClaim> = {}): BrowserDataRootClaim {
  return { ...paths, acquired: false, message }
}

function browserConfigRoot(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework')
}
