import { slotToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { asRecord, type ToolRun } from '../workbench/state.ts'

export interface FabricAuditPresentation {
  ref: string
  tool?: string
  provider?: string
  success?: boolean
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  durationMs?: number
}

export interface FabricToolPresentation {
  name: string
  description?: string
  code: string
  audits: FabricAuditPresentation[]
  outputLanguage?: string
}

export interface ToolPresentation {
  title?: string | undefined
  kind: 'code' | 'diff' | 'text'
  content: string
  language?: string | undefined
  path?: string | undefined
  fabric?: FabricToolPresentation | undefined
}

export interface ToolPresenter {
  present(tool: ToolRun): ToolPresentation | undefined
}

export const toolPresenterSlot = slotToken<ToolPresenter>('workbench.tool-presenter')

export const coreToolPresentersPlugin: WorkbenchPlugin = {
  id: 'core-tool-presenters',
  activate(ctx) {
    ctx.contribute(toolPresenterSlot, 'fabric_exec', {
      present(tool) {
        const args = asRecord(tool.args)
        const details = asRecord(tool.details)
        const display = runDisplay(args.display)
        const outputFormat = details.outputFormat === 'json' || details.outputFormat === 'yaml' ? details.outputFormat : undefined
        const fabric: FabricToolPresentation = {
          name: display.name || 'Fabric execution',
          ...(display.description ? { description: display.description } : {}),
          code: typeof args.code === 'string' ? args.code : '',
          audits: fabricAudits(details),
          ...(outputFormat ? { outputLanguage: outputFormat } : {}),
        }
        return {
          title: fabric.name,
          kind: 'code',
          content: tool.output ?? '',
          language: outputFormat ?? 'text',
          fabric,
        }
      },
    })
    ctx.contribute(toolPresenterSlot, 'bash', {
      present(tool) {
        const command = stringProperty(tool.args, 'command')
        return {
          title: command || undefined,
          kind: 'code',
          content: tool.output ?? '',
          language: 'bash',
        }
      },
    })
    ctx.contribute(toolPresenterSlot, 'read', {
      present(tool) {
        const path = stringProperty(tool.args, 'path')
        return {
          title: path || undefined,
          kind: 'code',
          content: tool.output ?? '',
          path: path || undefined,
        }
      },
    })
    const editPresenter: ToolPresenter = {
      present(tool) {
        const path = stringProperty(tool.args, 'path')
        const diff = findStringProperty(tool.details, 'diff') ?? findDiff(tool.output)
        return diff
          ? { title: path || undefined, kind: 'diff', content: diff }
          : { title: path || undefined, kind: 'code', content: tool.output ?? '', path: path || undefined }
      },
    }
    ctx.contribute(toolPresenterSlot, 'edit', editPresenter)
    ctx.contribute(toolPresenterSlot, 'write', editPresenter)
  },
}

export function resolveToolPresentation(tool: ToolRun, presenters: ReadonlyMap<string, ToolPresenter>): ToolPresentation {
  const exact = presenters.get(tool.name)?.present(tool)
  if (exact) return exact
  const diff = findStringProperty(tool.details, 'diff') ?? findDiff(tool.output)
  if (diff) return { kind: 'diff', content: diff }
  return { kind: 'code', content: tool.output ?? '', language: tool.name === 'grep' ? 'text' : undefined }
}

function runDisplay(value: unknown): { name: string; description?: string } {
  if (typeof value === 'string') {
    try {
      return runDisplay(JSON.parse(value))
    } catch {
      return { name: value.trim() }
    }
  }
  const display = asRecord(value)
  const name = typeof display.name === 'string' ? display.name.trim() : ''
  const description = typeof display.description === 'string' ? display.description.trim() : ''
  return { name, ...(description ? { description } : {}) }
}

function fabricAudits(details: Record<string, unknown>): FabricAuditPresentation[] {
  const audits = Array.isArray(details.audits)
    ? details.audits
    : Array.isArray(asRecord(details.trace).operations)
      ? asRecord(details.trace).operations as unknown[]
      : []
  return audits.flatMap((value) => {
    const audit = asRecord(value)
    if (typeof audit.ref !== 'string') return []
    const startedAt = typeof audit.startedAt === 'number' ? audit.startedAt : undefined
    const endedAt = typeof audit.endedAt === 'number' ? audit.endedAt : undefined
    const presentation: FabricAuditPresentation = {
      ref: audit.ref,
      ...(typeof audit.tool === 'string' ? { tool: audit.tool } : typeof audit.action === 'string' ? { tool: audit.action } : {}),
      ...(typeof audit.provider === 'string' ? { provider: audit.provider } : {}),
      ...(typeof audit.success === 'boolean' ? { success: audit.success } : {}),
      ...(typeof audit.outcome === 'string' ? { success: audit.outcome === 'succeeded' } : {}),
      ...(Object.keys(asRecord(audit.args)).length > 0 ? { args: asRecord(audit.args) } : {}),
      ...(audit.result !== undefined ? { result: audit.result } : {}),
      ...(typeof audit.error === 'string' ? { error: audit.error } : {}),
      ...(startedAt !== undefined && endedAt !== undefined ? { durationMs: Math.max(0, endedAt - startedAt) } : {}),
    }
    return [presentation]
  })
}

function stringProperty(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : ''
}

function findStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const direct = (value as Record<string, unknown>)[key]
  if (typeof direct === 'string') return direct
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findStringProperty(child, key)
    if (found) return found
  }
  return undefined
}

function findDiff(value: string | undefined): string | undefined {
  if (!value) return undefined
  const marker = value.indexOf('diff --git ')
  return marker >= 0 ? value.slice(marker) : undefined
}
