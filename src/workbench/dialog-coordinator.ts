import type { PiSessionTreeOption } from '../pi/session-tree.ts'
import type { ExtensionUiRequest, RpcRecord } from '../pi/types.ts'
import { errorMessage } from '../pi/types.ts'
import {
  addNotice,
  addStatusLine,
  type ExtensionDialog,
  type ExtensionWidget,
  type WorkbenchState,
} from './state.ts'
import { currentTurnTracePosition } from './timeline.ts'
import {
  buildAskUserDialogActions,
  dialogMatchesAskUserAction,
  questionnaireFromTool,
  questionnaireMatchesDialog,
  type AskUserDialogAction,
  type AskUserSubmissionAnswer,
} from './ask-user.ts'

interface AskUserDialogDriver {
  toolCallId: string
  actions: AskUserDialogAction[]
}

interface DialogCoordinatorHost {
  getState(): WorkbenchState
  patch(patch: Partial<WorkbenchState>): void
  setState(update: (state: WorkbenchState) => WorkbenchState): void
  send(record: RpcRecord): void
}

interface DialogResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

export class WorkbenchDialogCoordinator {
  readonly #host: DialogCoordinatorHost
  #dialogTimer: ReturnType<typeof setTimeout> | undefined
  #askUserDialogDriver: AskUserDialogDriver | undefined
  #nextLocalDialogId = 0
  readonly #localDialogResponses = new Map<string, (response: DialogResponse) => void>()

  constructor(host: DialogCoordinatorHost) {
    this.#host = host
  }

  handleExtensionUi(request: ExtensionUiRequest, sessionTransitioning: boolean): void {
    if (sessionTransitioning) {
      // Hide incoming UI for the session we are leaving; do not cancel Pi.
      // Cancelling the dialog aborts the background turn.
      return
    }
    if (request.method === 'notify') {
      const kind = request.notifyType ?? 'info'
      const message = request.message ?? 'Pi notification'
      if (kind === 'info') {
        // Pi routes `info` notifies to `showStatus`, a status line in the session chat, and keeps
        // `warning`/`error` for the notification stack.
        this.#host.setState((state) => addStatusLine(state, message))
        return
      }
      this.#host.setState((state) => addNotice(state, kind, message, currentTurnTracePosition(state.messages, state.liveAssistant, state.liveTools, state.forkMessages)))
      return
    }
    if (request.method === 'setStatus') {
      const state = this.#host.getState()
      const key = request.statusKey ?? request.id
      const statusItems = { ...state.statusItems }
      if (request.statusText) statusItems[key] = request.statusText
      else delete statusItems[key]
      this.#host.patch({ statusItems })
      return
    }
    if (request.method === 'setWidget') {
      const state = this.#host.getState()
      const key = request.widgetKey ?? request.id
      const widgets = { ...state.widgets }
      if (request.widgetLines) {
        const widget: ExtensionWidget = {
          key,
          lines: request.widgetLines,
          placement: request.widgetPlacement ?? 'aboveEditor',
        }
        widgets[key] = widget
      } else {
        delete widgets[key]
      }
      this.#host.patch({ widgets })
      return
    }
    if (request.method === 'setTitle') {
      this.#host.patch({ windowTitle: request.title ?? 'Heddlework' })
      return
    }
    if (request.method === 'set_editor_text') {
      this.#host.patch({ editorText: request.text ?? '' })
      return
    }

    const createdAt = Date.now()
    const dialog: ExtensionDialog = {
      id: request.id,
      method: request.method,
      title: request.title ?? 'Pi needs your input',
      createdAt,
      ...(request.message === undefined ? {} : { message: request.message }),
      ...(request.options === undefined ? {} : { options: request.options }),
      ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
      ...(request.timeout === undefined ? {} : { timeout: request.timeout, deadlineAt: createdAt + request.timeout }),
    }
    const state = this.#host.getState()
    if (isSessionOnlyDialog(dialog) && !hasActiveConversation(state)) {
      this.#sendDialogResponse(dialog.id, { cancelled: true })
      return
    }
    if (this.#tryDriveAskUserDialog(dialog, false)) return
    this.#enqueueDialog(dialog)
  }

  showLocalSelect(title: string, options: string[], onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-select-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'select', title, options, createdAt: Date.now() })
  }

  showLocalTree(title: string, treeOptions: PiSessionTreeOption[], onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-tree-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'tree', title, treeOptions, createdAt: Date.now() })
  }

  showLocalInput(title: string, placeholder: string, onResponse: (response: DialogResponse) => void): void {
    const id = `workbench-input-${++this.#nextLocalDialogId}`
    this.#localDialogResponses.set(id, onResponse)
    this.#enqueueDialog({ id, method: 'input', title, placeholder, createdAt: Date.now() })
  }

  respond(response: DialogResponse): void {
    const dialog = this.#host.getState().dialog
    if (!dialog) return
    this.#removeDialog(dialog.id)
    this.#sendDialogResponse(dialog.id, response)
  }

  submitQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[]): void {
    const state = this.#host.getState()
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    const dialog = state.dialog
    if (!questionnaire || !dialog || !questionnaireMatchesDialog(questionnaire, dialog)) {
      this.#host.setState((current) => addNotice(current, 'warning', 'The questionnaire is no longer awaiting this response'))
      return
    }
    try {
      this.#askUserDialogDriver = {
        toolCallId,
        actions: buildAskUserDialogActions(questionnaire, answers),
      }
      this.#host.patch({ questionnaireSubmitting: toolCallId, questionnaireCollapsed: undefined })
      if (!this.#tryDriveAskUserDialog(dialog, true)) {
        this.#askUserDialogDriver = undefined
        this.#host.patch({ questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
        this.#host.setState((current) => addNotice(current, 'error', 'The questionnaire dialog sequence did not match the active tool'))
      }
    } catch (error) {
      this.#host.setState((current) => addNotice(current, 'warning', errorMessage(error)))
    }
  }

  cancelQuestionnaire(toolCallId: string): void {
    const state = this.#host.getState()
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    if (!questionnaire || !questionnaireMatchesDialog(questionnaire, state.dialog)) return
    this.#askUserDialogDriver = undefined
    this.#host.patch({ questionnaireSubmitting: toolCallId, questionnaireCollapsed: undefined })
    this.respond({ cancelled: true })
  }

  setQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void {
    const state = this.#host.getState()
    const tool = state.liveTools.find((candidate) => candidate.id === toolCallId)
    const questionnaire = tool ? questionnaireFromTool(tool) : undefined
    if (!questionnaire || !questionnaireMatchesDialog(questionnaire, state.dialog)) return
    this.#host.patch({ questionnaireCollapsed: collapsed ? toolCallId : undefined })
  }

  handleToolExecutionEnd(toolCallId: string): void {
    if (this.#askUserDialogDriver?.toolCallId === toolCallId) this.#askUserDialogDriver = undefined
    const state = this.#host.getState()
    if (state.questionnaireSubmitting === toolCallId || state.questionnaireCollapsed === toolCallId) {
      this.#host.patch({ questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
    }
  }

  /** Drop visible dialogs without telling Pi. Background harnesses keep waiting. */
  hideVisible(): void {
    this.#askUserDialogDriver = undefined
    this.#host.patch({ dialog: undefined, dialogQueue: [], questionnaireSubmitting: undefined, questionnaireCollapsed: undefined })
    this.#clearDialogTimer()
  }

  cancelAll(): void {
    const state = this.#host.getState()
    const pending = [state.dialog, ...state.dialogQueue]
      .filter((dialog): dialog is ExtensionDialog => dialog !== undefined)
    this.hideVisible()
    for (const dialog of pending) this.#sendDialogResponse(dialog.id, { cancelled: true })
  }

  dispose(): void {
    this.cancelAll()
  }

  #enqueueDialog(dialog: ExtensionDialog): void {
    const state = this.#host.getState()
    if (!state.dialog) this.#host.patch({ dialog })
    else this.#host.patch({ dialogQueue: [...state.dialogQueue, dialog] })
    this.#scheduleDialogTimer()
  }

  #tryDriveAskUserDialog(dialog: ExtensionDialog, stored: boolean): boolean {
    const driver = this.#askUserDialogDriver
    const action = driver?.actions[0]
    if (!driver || !action || !dialogMatchesAskUserAction(dialog, action)) return false
    let response: { value: string }
    if (action.method === 'select') {
      const value = dialog.options?.[action.optionIndex ?? -1]
      if (value === undefined) return false
      response = { value }
    } else {
      response = { value: action.value ?? '' }
    }
    driver.actions.shift()
    if (driver.actions.length === 0) this.#askUserDialogDriver = undefined
    if (stored) this.#removeDialog(dialog.id)
    this.#sendDialogResponse(dialog.id, response)
    return true
  }

  #sendDialogResponse(id: string, response: DialogResponse): void {
    const localResponse = this.#localDialogResponses.get(id)
    if (localResponse) {
      this.#localDialogResponses.delete(id)
      try {
        localResponse(response)
      } catch (error) {
        this.#host.setState((state) => addNotice(state, 'error', errorMessage(error)))
      }
      return
    }
    try {
      this.#host.send({ type: 'extension_ui_response', id, ...response })
    } catch (error) {
      this.#host.setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  #removeDialog(id: string): void {
    const state = this.#host.getState()
    const pending = [state.dialog, ...state.dialogQueue]
      .filter((dialog): dialog is ExtensionDialog => dialog !== undefined && dialog.id !== id)
    this.#host.patch({ dialog: pending[0], dialogQueue: pending.slice(1) })
    this.#scheduleDialogTimer()
  }

  #scheduleDialogTimer(): void {
    this.#clearDialogTimer()
    const state = this.#host.getState()
    const deadlines = [state.dialog, ...state.dialogQueue]
      .flatMap((dialog) => dialog?.deadlineAt === undefined ? [] : [dialog.deadlineAt])
    const nextDeadline = deadlines.length > 0 ? Math.min(...deadlines) : undefined
    if (nextDeadline === undefined) return
    this.#dialogTimer = setTimeout(() => {
      this.#dialogTimer = undefined
      const now = Date.now()
      const current = this.#host.getState()
      const pending = [current.dialog, ...current.dialogQueue]
        .filter((dialog): dialog is ExtensionDialog => dialog !== undefined)
        .filter((dialog) => dialog.deadlineAt === undefined || now < dialog.deadlineAt + 50)
      this.#host.patch({ dialog: pending[0], dialogQueue: pending.slice(1) })
      this.#scheduleDialogTimer()
    }, Math.max(0, nextDeadline + 50 - Date.now()))
  }

  #clearDialogTimer(): void {
    if (this.#dialogTimer) clearTimeout(this.#dialogTimer)
    this.#dialogTimer = undefined
  }
}

function isInteractiveRequest(request: ExtensionUiRequest): boolean {
  return request.method === 'select' || request.method === 'confirm' || request.method === 'input' || request.method === 'editor'
}

function hasActiveConversation(state: WorkbenchState): boolean {
  return state.session.isStreaming
    || state.liveAssistant !== undefined
    || state.liveTools.length > 0
    || state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
}

function isSessionOnlyDialog(dialog: ExtensionDialog): boolean {
  return dialog.title.includes('Extend billable human time?')
}
