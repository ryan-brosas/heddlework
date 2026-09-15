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

const running = runningPids().map((pid) => ({ pid, image: processImage(pid) }))
for (const candidate of candidates) {
  const path = resolve(candidate)
  if (!existsSync(path)) {
    console.log(describeArtifact({ path, exists: false, sha256: '' }))
    continue
  }
  // Two ways this path can fail to identify an artifact, and both must be a finding rather than a misleading
  // hash: an unreadable file throws, and a launcher whose target no longer exists is not an executable - the
  // shared reader reports that as an `unknown` backend, which would otherwise print the launcher's own hash as
  // if it were the application's.
  let identity
  try {
    identity = readArtifactIdentity(path)
  } catch (error) {
    console.log(describeArtifact({ path, exists: true, sha256: '', error: error instanceof Error ? error.message : String(error) }))
    continue
  }
  if (identity.backend === 'unknown') {
    console.log(describeArtifact({ path, exists: true, sha256: '', error: 'not an executable and its launcher target does not exist' }))
    continue
  }
  console.log(describeArtifact({
    path: identity.path,
    exists: true,
    sha256: identity.sha256,
    launchedFrom: identity.launchedFrom,
    running,
  }))
}
