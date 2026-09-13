import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_TERMINAL_APPEARANCE } from './appearance-defaults.ts'
import type { TerminalAppearance } from './types.ts'

export { DEFAULT_TERMINAL_APPEARANCE }

export function resolveTerminalAppearance(
  value: Partial<TerminalAppearance> | undefined,
  fallback: TerminalAppearance = DEFAULT_TERMINAL_APPEARANCE,
): TerminalAppearance {
  return {
    fontFamily: cleanFamily(value?.fontFamily, fallback.fontFamily),
    nerdFontFamily: cleanFamily(value?.nerdFontFamily, fallback.nerdFontFamily),
    ligaturesEnabled: value?.ligaturesEnabled ?? fallback.ligaturesEnabled,
    nerdFontEnabled: value?.nerdFontEnabled ?? fallback.nerdFontEnabled,
    muteEmojiColors: value?.muteEmojiColors ?? fallback.muteEmojiColors,
  }
}

export function readTerminalAppearance(path: string | false): TerminalAppearance | undefined {
  if (!path) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TerminalAppearance>
    if (!parsed || typeof parsed !== 'object') return undefined
    return resolveTerminalAppearance({
      ...(typeof parsed.fontFamily === 'string' ? { fontFamily: parsed.fontFamily } : {}),
      ...(typeof parsed.nerdFontFamily === 'string' ? { nerdFontFamily: parsed.nerdFontFamily } : {}),
      ...(typeof parsed.ligaturesEnabled === 'boolean' ? { ligaturesEnabled: parsed.ligaturesEnabled } : {}),
      ...(typeof parsed.nerdFontEnabled === 'boolean' ? { nerdFontEnabled: parsed.nerdFontEnabled } : {}),
      ...(typeof parsed.muteEmojiColors === 'boolean' ? { muteEmojiColors: parsed.muteEmojiColors } : {}),
    })
  } catch {
    return undefined
  }
}

export function writeTerminalAppearance(path: string | false, appearance: TerminalAppearance): void {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(appearance, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, path)
  } catch {
    // Runtime changes still apply when the preference cannot be persisted.
  }
}

export function terminalAppearancePreferencePath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'terminal.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'terminal.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'terminal.json')
}

function cleanFamily(value: string | undefined, fallback: string): string {
  const family = value?.trim().replace(/\s+/gu, ' ')
  return family ? family.slice(0, 160) : fallback
}
