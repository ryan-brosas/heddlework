import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Linux desktop launcher reads this one-line path when HEDDLEWORK_WORKSPACE is unset. */
export function lastWorkspacePath(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'workspace')
}

export async function persistLastWorkspace(workspacePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'linux') return
  const file = lastWorkspacePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${resolve(workspacePath)}\n`, { encoding: 'utf8', mode: 0o600 })
}
