import { describe, expect, it } from 'bun:test'
import { delimiter, join, resolve } from 'node:path'
import { PiRpcTransport, piProcessEnvironment, resolvePiExecutable } from '../src/pi/rpc-transport.ts'
import { heddleworkFabricBridgePath } from '../src/pi/fabric-bridge.ts'
import type { RpcRecord } from '../src/pi/types.ts'

describe('PiRpcTransport', () => {
  it('prefers Localterm’s credential-injecting shim before generic PATH binaries', () => {
    // HEDDLEWORK_PI is an explicit user override that outranks every discovered candidate;
    // scrub it so this machine's exported value cannot leak into the fixture resolution.
    const configuredEnv = process.env.HEDDLEWORK_PI
    delete process.env.HEDDLEWORK_PI
    try {
      const home = '/fixture-home'
      const shim = join(home, '.localterm', 'shims', process.platform === 'win32' ? 'pi.exe' : 'pi')
      const generic = join('/generic-bin', process.platform === 'win32' ? 'pi.exe' : 'pi')
      const existing = new Set([shim, generic])
      expect(resolvePiExecutable({ home, path: ['/generic-bin'].join(delimiter), exists: (path) => existing.has(path) })).toBe(shim)
      expect(resolvePiExecutable({ configured: '/explicit/pi', home, path: '', exists: () => false })).toBe('/explicit/pi')
    } finally {
      if (configuredEnv !== undefined) process.env.HEDDLEWORK_PI = configuredEnv
    }
  })

  it('keeps Bun package bins from shadowing Pi behind the LocalTerm shim', () => {
    const cwd = join('/workspace', 'packages', 'app')
    const shim = join('/fixture-home', '.localterm', 'shims', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const packageBins = [
      join('/workspace', 'node_modules', '.bin'),
      join(cwd, 'node_modules', '.bin'),
    ]
    const userBins = [
      join('/toolchains', 'pnpm', 'node_modules', '.bin'),
      join('/fixture-home', '.bun', 'bin'),
      join('/usr', 'bin'),
    ]
    const inherited = { PATH: [...packageBins, ...userBins].join(delimiter) }

    expect(piProcessEnvironment(shim, inherited, cwd).PATH).toBe(userBins.join(delimiter))
    expect(piProcessEnvironment('/explicit/pi', inherited, cwd)).toBe(inherited)
  })

  it('correlates responses while forwarding interleaved events', async () => {
    const events: RpcRecord[] = []
    const transport = new PiRpcTransport({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: [resolve(import.meta.dir, 'fixtures/fake-pi.ts')],
    })
    const unsubscribe = transport.onEvent((event) => events.push(event))
    try {
      await transport.start()
      await expect(transport.request<{ pong: boolean }>({ type: 'ping' })).resolves.toEqual({ pong: true })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('queue_update')
      expect((events[0]?.steering as string[])[0]).toBe('hello\u2028world')
      const argv = await transport.request<{ argv: string[] }>({ type: 'argv' })
      expect(argv.argv).toContain('--mode')
      expect(argv.argv).toContain('rpc')
      expect(argv.argv).toContain('--extension')
      expect(argv.argv).toContain(heddleworkFabricBridgePath())
      await expect(transport.request({ type: 'navigate_tree', entryId: 'entry-1' })).resolves.toEqual({ cancelled: false, editorText: 'Try another branch' })
      await expect(transport.request({ type: 'fail' })).rejects.toThrow('expected failure')
    } finally {
      unsubscribe()
      await transport.stop()
    }
  })
})
