import { describe, expect, it } from 'bun:test'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

function waitForSettled(controller: WorkbenchController): Promise<void> {
  if (isFullySettled(controller)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (!isFullySettled(controller)) return
      unsubscribe()
      resolve()
    })
  })
}

function isFullySettled(controller: WorkbenchController): boolean {
  const state = controller.getSnapshot()
  return !state.session.isStreaming && state.liveAssistant === undefined && state.liveTools.length === 0
}

class ScriptedTransport {
  readonly #eventListeners = new Set<(event: RpcRecord) => void>()
  readonly #statusListeners = new Set<(status: TransportStatus) => void>()

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    throw new Error(`Unexpected command: ${command.type}`)
  }
  send(_record: RpcRecord): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }
  emit(event: RpcRecord): void {
    for (const listener of this.#eventListeners) listener(event)
  }
}

describe('WorkbenchController', () => {
  it('applies each streaming delta once when a pooled transport is attached again', async () => {
    const transport = new ScriptedTransport()
    const controller = new WorkbenchController(transport as unknown as AgentTransport, '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      // A session switch away and back re-attaches the pooled transport.
      controller.attachTransport(transport as unknown as AgentTransport)

      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Good' } })
      transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '.. Now' } })

      const blocks = controller.getSnapshot().liveAssistant?.blocks ?? []
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.kind).toBe('thinking')
      expect(blocks[0]?.text).toBe('Good.. Now')
    } finally {
      await controller.dispose()
    }
  })
  it('boots, streams a task, and rehydrates the authoritative transcript', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      expect(controller.getSnapshot().connection).toBe('connected')
      expect(controller.getSnapshot().models).toHaveLength(2)

      controller.setEditorText('Inspect the repository')
      await controller.submit(controller.getSnapshot().editorText)
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      await waitForSettled(controller)

      const state = controller.getSnapshot()
      expect(state.session.isStreaming).toBe(false)
      expect(state.messages.some((message) => message.role === 'toolResult')).toBe(true)
      expect(state.messages.at(-1)?.role).toBe('assistant')
      expect(state.liveTools).toEqual([])
      expect(state.forkMessages).toHaveLength(1)

      await controller.submit('/tree')
      expect(controller.getSnapshot().dialog).toMatchObject({ method: 'tree' })
      expect(controller.getSnapshot().dialog?.title).toStartWith('Navigate session tree')
      const rootOption = controller.getSnapshot().dialog?.treeOptions?.find((option) => option.detail.includes('Inspect the repository'))
      expect(rootOption).toBeDefined()
      controller.respondToDialog({ value: rootOption!.entryId })
      expect(controller.getSnapshot().dialog?.title).toStartWith('Leave the active branch')
      expect(controller.getSnapshot().dialog?.options).toHaveLength(3)
      controller.respondToDialog({ cancelled: true })

      const sessionId = state.session.sessionId
      await controller.navigateTree(state.forkMessages[0]!.entryId)
      expect(controller.getSnapshot().editorText).toBe('Inspect the repository')
      expect(controller.getSnapshot().messages).toHaveLength(0)
      expect(controller.getSnapshot().forkMessages).toHaveLength(1)
      expect(controller.getSnapshot().session.sessionId).toBe(sessionId)
    } finally {
      await controller.dispose()
    }
  }, 4_000)

  it('appends a compaction summary after /compact', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      await controller.compact()
      expect(controller.getSnapshot().messages).toEqual([
        expect.objectContaining({ role: 'compaction', content: 'Demo context compacted', tokensBefore: 128_000 }),
      ])
    } finally {
      await controller.dispose()
    }
  })
})
