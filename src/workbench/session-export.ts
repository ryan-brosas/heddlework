import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export function defaultSessionExportPath(
  sessionFile: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const downloads = environment.XDG_DOWNLOAD_DIR?.trim() || join(home, 'Downloads')
  const raw = sessionFile ? basename(sessionFile, '.jsonl') : 'session'
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
  return join(downloads, `heddlework-${slug}.html`)
}

export function ensureSessionExportPath(sessionFile: string | undefined, environment?: NodeJS.ProcessEnv, home?: string): string {
  const path = defaultSessionExportPath(sessionFile, environment, home)
  mkdirSync(dirname(path), { recursive: true })
  return path
}
