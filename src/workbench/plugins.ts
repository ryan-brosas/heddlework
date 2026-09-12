import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { DemoTransport } from '../pi/demo-transport.ts'
import { PiRpcTransport, type PiRpcTransportOptions } from '../pi/rpc-transport.ts'
import { PiSessionCatalog, type SessionCatalogOptions } from '../pi/session-catalog.ts'
import type { AgentTransport } from '../pi/transport.ts'
import { loadWorkspaceDiff } from '../workspace/git-diff.ts'
import { WorkbenchController } from './controller.ts'
import './events.ts'
import type { SessionCatalogService, WorkspaceDiffService } from './services.ts'
import type { QueueStoreService } from './queue-store.ts'
import type { ThreadMetadataStoreService } from './thread-metadata-store.ts'

export const agentTransportToken = serviceToken<AgentTransport>('agent-transport')
export const sessionCatalogToken = serviceToken<SessionCatalogService>('session-catalog')
export const workspaceDiffToken = serviceToken<WorkspaceDiffService>('workspace-diff')
export const workbenchControllerToken = serviceToken<WorkbenchController>('workbench-controller')

export function createAgentTransportPlugin(options: PiRpcTransportOptions & { demo: boolean }): WorkbenchPlugin {
  return {
    id: options.demo ? 'demo-agent-transport' : 'pi-rpc-agent-transport',
    activate(ctx) {
      const transport: AgentTransport = options.demo ? new DemoTransport() : new PiRpcTransport(options)
      ctx.provide(agentTransportToken, transport)
      ctx.effect(() => async () => transport.stop())
      ctx.effect(() => transport.onEvent((event) => ctx.emit('agent/event', event)))
      ctx.effect(() => transport.onStatus((status) => ctx.emit('agent/status', status)))
    },
  }
}

export function createSessionCatalogPlugin(options: SessionCatalogOptions = {}): WorkbenchPlugin {
  return {
    id: 'pi-session-catalog',
    activate(ctx) {
      ctx.provide(sessionCatalogToken, new PiSessionCatalog(options))
    },
  }
}

export const localWorkspaceDiffPlugin: WorkbenchPlugin = {
  id: 'local-workspace-diff',
  activate(ctx) {
    ctx.provide(workspaceDiffToken, { load: loadWorkspaceDiff })
  },
}

export function createWorkbenchControllerPlugin(
  workspacePath: string,
  options: { queueStore?: QueueStoreService | undefined; threadMetadataStore?: ThreadMetadataStoreService | undefined; transportOptions?: PiRpcTransportOptions & { demo: boolean } } = {},
): WorkbenchPlugin {
  return {
    id: 'workbench-controller',
    requires: [agentTransportToken, sessionCatalogToken, workspaceDiffToken],
    activate(ctx) {
      const transportOptions = options.transportOptions
      const controller = new WorkbenchController(ctx.get(agentTransportToken), workspacePath, {
        sessionCatalog: ctx.get(sessionCatalogToken),
        workspaceDiff: ctx.get(workspaceDiffToken),
        transportEvents: 'external',
        transportOwnership: 'provider',
        createSessionTransport: (sessionPath) => {
          if (transportOptions?.demo) return new DemoTransport()
          const { demo: _demo, piArgs, ...rpcOptions } = transportOptions ?? { cwd: workspacePath }
          const sessionArgs = sessionPath ? ['--session', sessionPath] : []
          return new PiRpcTransport({ ...rpcOptions, cwd: rpcOptions.cwd ?? workspacePath, piArgs: [...(piArgs ?? []), ...sessionArgs] })
        },
        ...(options.queueStore ? { queueStore: options.queueStore } : {}),
        ...(options.threadMetadataStore ? { threadMetadataStore: options.threadMetadataStore } : {}),
      })
      controller.attachTransport(ctx.get(agentTransportToken))
      ctx.provide(workbenchControllerToken, controller)
      ctx.effect(() => async () => controller.dispose())
    },
  }
}
