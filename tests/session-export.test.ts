import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import type { RpcCommand } from '../src/pi/types.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { defaultSessionExportPath } from '../src/workbench/session-export.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

class ExportTransport extends DemoTransport {
  lastExport: RpcCommand | undefined
  override async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'export_html') {
      this.lastExport = command
      return { path: String(command.outputPath) } as T
    }
    return super.request(command)
  }
}

describe('session HTML export', () => {
  it('writes under XDG_DOWNLOAD_DIR when set, otherwise ~/Downloads', () => {
    expect(defaultSessionExportPath('/tmp/pi/abc.jsonl', { XDG_DOWNLOAD_DIR: '/tmp/dl' }, '/home/user')).toBe('/tmp/dl/heddlework-abc.html')
    expect(defaultSessionExportPath('/tmp/pi/weird name.jsonl', {}, '/home/user')).toBe('/home/user/Downloads/heddlework-weird-name.html')
  })

  it('sends export_html with a Downloads outputPath instead of Pi cwd', async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'heddlework-export-'))
    const previous = process.env.XDG_DOWNLOAD_DIR
    process.env.XDG_DOWNLOAD_DIR = downloads
    const transport = new ExportTransport()
    const controller = new WorkbenchController(transport, '/tmp/project', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      const path = await controller.exportSession()
      const outputPath = String(transport.lastExport?.outputPath ?? '')
      expect(transport.lastExport).toMatchObject({ type: 'export_html' })
      expect(outputPath.startsWith(downloads)).toBe(true)
      expect(outputPath.endsWith('.html')).toBe(true)
      expect(path).toBe(outputPath)
      expect(controller.getSnapshot().notices.some((notice) => notice.message.includes('Exported session to'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.XDG_DOWNLOAD_DIR
      else process.env.XDG_DOWNLOAD_DIR = previous
      await controller.dispose()
      await rm(downloads, { recursive: true, force: true })
    }
  })
})
