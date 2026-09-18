import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allocateDisplayNumber,
  CLIPBOARD_LANE_ENVIRONMENT,
  clipboardLaneEnvironment,
  clipboardLaneHelper,
  parseDisplayfdNumber,
  parseWorkbenchKeySmokeArgs,
  readArtifactIdentity,
  resolveAppBinaryPath,
  WorkbenchKeySmokeUsageError,
  workbenchKeyLaneEnvironment,
  writeClipboardStubs,
  xvfbArguments,
  xvfbSupportsDisplayfd,
} from '../scripts/linux-workbench-key-harness.ts'

/**
 * Deterministic checks of the driver's decision logic and of the clipboard stubs themselves.
 *
 * The stubs are the lane's clipboard boundary, so they are executed here for real: an invocation
 * shape the app should not make must fail loudly rather than quietly returning the wrong bytes, and
 * an image reader must never receive text.
 */

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const created: string[] = []

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

function writeElf(path: string, fill: number, length: number): Buffer {
  const bytes = Buffer.concat([ELF_MAGIC, Buffer.alloc(length, fill)])
  writeFileSync(path, bytes)
  return bytes
}

function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes) : bytes).digest('hex')
}

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true })
})

describe('workbench key smoke arguments', () => {
  it('defaults to the checkout build on a private display', () => {
    expect(parseWorkbenchKeySmokeArgs([])).toEqual({ installed: false, display: 'private', binary: undefined })
    expect(parseWorkbenchKeySmokeArgs(['--display=private']).display).toBe('private')
  })

  it('accepts --installed and trims HEDDLEWORK_APP_BINARY', () => {
    expect(parseWorkbenchKeySmokeArgs(['--installed']).installed).toBe(true)
    expect(parseWorkbenchKeySmokeArgs([], { HEDDLEWORK_APP_BINARY: '  /tmp/app  ' }).binary).toBe('/tmp/app')
    expect(parseWorkbenchKeySmokeArgs([], { HEDDLEWORK_APP_BINARY: '   ' }).binary).toBeUndefined()
  })

  it('refuses --display=current without the isolated-session opt-in', () => {
    expect(() => parseWorkbenchKeySmokeArgs(['--display=current'])).toThrow(WorkbenchKeySmokeUsageError)
    expect(() => parseWorkbenchKeySmokeArgs(['--display=current'])).toThrow(/HEDDLEWORK_SMOKE_ISOLATED_DISPLAY=1/)
    expect(parseWorkbenchKeySmokeArgs(['--display=current'], { HEDDLEWORK_SMOKE_ISOLATED_DISPLAY: '1' }).display).toBe('current')
  })

  it('refuses unknown arguments instead of guessing', () => {
    expect(() => parseWorkbenchKeySmokeArgs(['--display=:99'])).toThrow(/unknown argument/)
    expect(() => parseWorkbenchKeySmokeArgs(['--keep-temp'])).toThrow(/unknown argument/)
  })
})

describe('workbench key binary resolution', () => {
  const invocation = { installed: false, display: 'private', binary: undefined } as const

  it('lets HEDDLEWORK_APP_BINARY win over --installed and the checkout', () => {
    expect(resolveAppBinaryPath({ ...invocation, installed: true, binary: '/env/app' }, {}, '/repo')).toEqual({ path: '/env/app', source: 'env' })
  })

  it('honors XDG_DATA_HOME for --installed', () => {
    const installed = { ...invocation, installed: true }
    expect(resolveAppBinaryPath(installed, { XDG_DATA_HOME: '/data', HOME: '/home/u' }, '/repo')).toEqual({ path: '/data/heddlework/heddlework', source: 'installed' })
    expect(resolveAppBinaryPath(installed, { HOME: '/home/u' }, '/repo').path).toBe('/home/u/.local/share/heddlework/heddlework')
  })

  it('defaults to the checkout build', () => {
    expect(resolveAppBinaryPath(invocation, {}, '/repo')).toEqual({ path: '/repo/dist/heddlework', source: 'checkout' })
  })
})

describe('workbench key artifact identity', () => {
  it('hashes an ELF executable and reports the native backend', () => {
    const directory = scratch('hw-key-elf-')
    const binary = join(directory, 'heddlework')
    const bytes = writeElf(binary, 7, 16)
    const identity = readArtifactIdentity(binary)
    expect(identity.path).toBe(binary)
    expect(identity.backend).toBe('native-gpui')
    expect(identity.sha256).toBe(sha256Of(bytes))
    expect(identity.launchedFrom).toBeUndefined()
  })

  it('follows the installer launcher to the executable it execs', () => {
    const directory = scratch('hw-key-launcher-')
    const target = join(directory, 'heddlework-app')
    const targetBytes = writeElf(target, 3, 24)
    const launcher = join(directory, 'heddlework')
    writeFileSync(launcher, `#!/bin/sh\nset -eu\nexec '${target}' "$@"\n`, { mode: 0o700 })
    const identity = readArtifactIdentity(launcher)
    expect(identity.path).toBe(target)
    expect(identity.launchedFrom).toBe(launcher)
    expect(identity.backend).toBe('native-gpui')
    expect(identity.sha256).toBe(sha256Of(targetBytes))
  })

  it('resolves a relative exec target next to the launcher', () => {
    const directory = scratch('hw-key-relative-')
    const target = join(directory, 'app')
    writeElf(target, 1, 8)
    writeFileSync(join(directory, 'run'), '#!/bin/sh\nexec ./app "$@"\n')
    expect(readArtifactIdentity(join(directory, 'run')).path).toBe(target)
  })

  it('reports unknown instead of guessing the backend', () => {
    const directory = scratch('hw-key-unknown-')
    const script = join(directory, 'app.tsx')
    writeFileSync(script, 'console.log(1)\n')
    expect(readArtifactIdentity(script).backend).toBe('unknown')
    const wrapper = join(directory, 'wrapper')
    writeFileSync(wrapper, '#!/bin/sh\nexec env FOO=1 /bin/true\n')
    expect(readArtifactIdentity(wrapper).backend).toBe('unknown')
    const web = join(directory, 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'main.tsx'), 'x\n')
    expect(readArtifactIdentity(join(web, 'main.tsx')).backend).toBe('web-companion')
  })
})

describe('workbench key display allocation', () => {
  it('detects -displayfd support in the Xvfb usage text', () => {
    expect(xvfbSupportsDisplayfd('usage: Xvfb [:display] ... -displayfd fd ...')).toBe(true)
    expect(xvfbSupportsDisplayfd('usage: Xvfb [:display] -screen scrn WxHxD')).toBe(false)
  })

  it('parses the number Xvfb writes to the displayfd pipe', () => {
    expect(parseDisplayfdNumber('12\n')).toBe(12)
    expect(parseDisplayfdNumber(':97')).toBe(97)
    expect(parseDisplayfdNumber('')).toBeUndefined()
    expect(parseDisplayfdNumber('Xvfb failed')).toBeUndefined()
  })

  it('allocates the first free display and refuses when the range is full', () => {
    expect(allocateDisplayNumber({ isBusy: (value: number) => value > 96 })).toBe(96)
    expect(() => allocateDisplayNumber({ isBusy: () => true })).toThrow(/no free X display/)
    expect(allocateDisplayNumber({ isBusy: () => false, first: 40, last: 30 })).toBe(40)
  })

  it('builds Xvfb arguments for both allocation modes', () => {
    expect(xvfbArguments({ displayfd: 3 })).toEqual(['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '+extension', 'GLX'])
    expect(xvfbArguments({ display: ':97' })).toEqual([':97', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '+extension', 'GLX'])
  })
})

describe('workbench key clipboard stubs', () => {
  interface StubRun {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
  }

  function stubs(): {
    paths: ReturnType<typeof writeClipboardStubs>['paths']
    run: (script: string, args: readonly string[], input?: string) => StubRun
  } {
    const directory = scratch('hw-key-stubs-')
    const { paths } = writeClipboardStubs(directory)
    const environment = { ...process.env, ...clipboardLaneEnvironment(paths) }
    return {
      paths,
      run: (script: string, args: readonly string[], input = '') => {
        const result = spawnSync('sh', [join(directory, script), ...args], { env: environment, input, encoding: 'utf8' })
        return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
      },
    }
  }

  it('records the exact bytes of a copy and counts the write', () => {
    const { paths, run } = stubs()
    expect(run('wl-copy', [], 'hello world').code).toBe(0)
    const helper = clipboardLaneHelper(paths)
    expect(helper.copiedText()).toBe('hello world')
    expect(helper.copyWrites()).toBe(1)
    expect(helper.violations()).toEqual([])
  })

  it('accepts the text MIME shapes and trims only when asked', () => {
    const { paths, run } = stubs()
    expect(run('wl-copy', ['--type', 'text/plain'], 'a').code).toBe(0)
    expect(run('wl-copy', ['--type=text/plain'], 'b').code).toBe(0)
    expect(run('wl-copy', ['--type', 'text/plain;charset=utf-8'], 'c').code).toBe(0)
    expect(run('wl-copy', ['--trim-newline'], 'line\n').code).toBe(0)
    const helper = clipboardLaneHelper(paths)
    expect(helper.copiedText()).toBe('line')
    expect(helper.copyWrites()).toBe(4)
    expect(helper.violations()).toEqual([])
  })

  it('rejects an image MIME on the copy side', () => {
    const { paths, run } = stubs()
    expect(run('wl-copy', ['--type', 'image/png'], 'nope').code).toBe(2)
    const helper = clipboardLaneHelper(paths)
    expect(helper.copyWrites()).toBe(0)
    expect(helper.copiedText()).toBe('')
    expect(helper.violations().join('\n')).toContain('unsupported mime type: image/png')
  })

  it('never hands the staged text to an image reader', () => {
    const { paths, run } = stubs()
    const helper = clipboardLaneHelper(paths)
    helper.stagePaste('secret-text')
    const image = run('wl-paste', ['--no-newline', '--type', 'image/png'])
    expect(image.code).toBe(1)
    expect(image.stdout).toBe('')
    expect(image.stdout).not.toContain('secret-text')
    expect(helper.helperInvocations().join('\n')).toContain('image image/png')
  })

  it('models the real trailing newline and honors --no-newline', () => {
    const { paths, run } = stubs()
    const helper = clipboardLaneHelper(paths)
    helper.stagePaste('abc')
    expect(run('wl-paste', []).stdout).toBe('abc\n')
    expect(run('wl-paste', ['--no-newline', '--type', 'text']).stdout).toBe('abc')
    expect(run('wl-paste', ['--no-newline', '--type', 'text/plain']).stdout).toBe('abc')
    helper.stagePaste('abc\n')
    expect(run('wl-paste', []).stdout).toBe('abc\n')
    helper.stagePaste('')
    expect(run('wl-paste', []).stdout).toBe('')
  })

  it('fails a text read against an image-only clipboard', () => {
    const { paths, run } = stubs()
    const helper = clipboardLaneHelper(paths)
    helper.stagePaste('stale')
    helper.stageImage()
    const result = run('wl-paste', ['--no-newline'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(helper.helperInvocations().join('\n')).toContain('image-only clipboard')
  })

  it('rejects unknown flags and MIME types', () => {
    const { paths, run } = stubs()
    expect(run('wl-paste', ['--bogus'], '').code).toBe(2)
    expect(run('wl-paste', ['--type', 'application/json'], '').code).toBe(2)
    expect(run('wl-paste', ['--type'], '').code).toBe(2)
    expect(run('wl-copy', ['--bogus'], 'x').code).toBe(2)
    expect(clipboardLaneHelper(paths).violations().length).toBe(4)
  })

  it('isolates the xclip fallback from the host clipboard', () => {
    const { paths, run } = stubs()
    const helper = clipboardLaneHelper(paths)
    const read = run('xclip', ['-selection', 'clipboard', '-o'], '')
    expect(read.code).toBe(1)
    expect(read.stdout).toBe('')
    expect(helper.helperInvocations().join('\n')).toContain('blocked read')
    expect(helper.violations()).toEqual([])
    const write = run('xclip', ['-selection', 'clipboard'], 'write-through-xclip')
    expect(write.code).toBe(1)
    expect(helper.violations().join('\n')).toContain('xclip-write')
    expect(helper.copyWrites()).toBe(0)
    expect(helper.copiedText()).toBe('')
  })
})

describe('workbench key lane environment', () => {
  const base = { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' }

  it('gives a private run its own display, homes and clipboard stubs', () => {
    const directory = scratch('hw-key-env-')
    const workspace = join(directory, 'workspace')
    const stubDirectory = join(directory, 'bin')
    const stubs = writeClipboardStubs(stubDirectory)
    const environment = workbenchKeyLaneEnvironment({ base, workspace, stubDirectory, display: ':97', displayMode: 'private', paths: stubs.paths })
    expect(environment.PATH).toBe(`${stubDirectory}:${base.PATH}`)
    expect(environment.DISPLAY).toBe(':97')
    expect(environment.HOME).toBe(workspace)
    expect(environment.XDG_CONFIG_HOME).toBe(join(workspace, 'config'))
    expect(environment.HEDDLEWORK_DEMO).toBe('1')
    expect(environment.WAYLAND_DISPLAY).toBeUndefined()
    expect(environment.XDG_SESSION_TYPE).toBe('x11')
    expect(environment.XDG_RUNTIME_DIR).toBe(join(workspace, 'runtime'))
    expect(environment[CLIPBOARD_LANE_ENVIRONMENT.copyText]).toBe(stubs.paths.copyText)
  })

  it('keeps the compositor session reachable for --display=current', () => {
    const directory = scratch('hw-key-env-current-')
    const workspace = join(directory, 'workspace')
    const stubDirectory = join(directory, 'bin')
    const paths = writeClipboardStubs(stubDirectory).paths
    const environment = workbenchKeyLaneEnvironment({ base, workspace, stubDirectory, display: '', displayMode: 'current', paths })
    expect(environment.WAYLAND_DISPLAY).toBe('wayland-1')
    expect(environment.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(environment.HOME).toBe(workspace)
    expect(environment.DISPLAY).toBeUndefined()
  })
})
