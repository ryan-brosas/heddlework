#!/usr/bin/env bun
/**
 * Provenance check for dogfooding the Linux desktop build.
 *
 * Answers one question before any manual acceptance result is trusted: which artifact would a desktop launch
 * run, and which image is a running window using? A launcher resolves to the executable it execs, so a stale
 * `~/.local/bin/heddlework` or a running process from an earlier build is visible instead of implied.
 *
 *   bun scripts/linux-artifact-check.ts [path]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describeArtifact } from './linux-clipboard-live-evidence.ts'
import { readArtifactIdentity } from './linux-workbench-key-harness.ts'

const repoRoot = resolve(import.meta.dir, '..')
const home = process.env.HOME?.trim() || ''
const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')

const requested = process.argv[2]
const candidates = requested === undefined
  ? [join(home, '.local', 'bin', 'heddlework'), join(dataHome, 'heddlework', 'heddlework'), join(repoRoot, 'dist', 'heddlework')]
  : [requested]

function runningPids(): number[] {
  try {
    return execFileSync('pgrep', ['-x', 'heddlework'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid))
  } catch {
    return []
  }
}

function processImage(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${String(pid)}/exe`)
  } catch {
    return undefined
  }
}

const pids = runningPids()
for (const candidate of candidates) {
  const path = resolve(candidate)
  if (!existsSync(path)) {
    console.log(describeArtifact({ path, exists: false, sha256: '', runningPids: [] }))
    continue
  }
  const identity = readArtifactIdentity(path)
  const runningImage = pids.length === 0 ? undefined : pids.map((pid) => processImage(pid)).find((image) => image !== undefined)
  console.log(describeArtifact({
    path: identity.path,
    exists: true,
    sha256: identity.sha256,
    launchedFrom: identity.launchedFrom,
    runningPids: pids,
    runningImage,
  }))
}
