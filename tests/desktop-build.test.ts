import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reactProductionDefine } from '../scripts/production-define.ts'

const root = resolve(import.meta.dir, '..')

describe('shipped builds resolve production React', () => {
  it('maps NODE_ENV to the production React bundle', () => {
    expect(reactProductionDefine['process.env.NODE_ENV']).toBe('"production"')
  })

  it('desktop and web builds use the shared production define', () => {
    for (const script of ['scripts/build.ts', 'scripts/build-web.ts']) {
      expect(readFileSync(resolve(root, script), 'utf8')).toContain('reactProductionDefine')
    }
  })
})
