import { errorMessage } from '../pi/types.ts'
import type { WorkbenchService } from '../workbench/controller.ts'

/**
 * Failure handler for a UI affordance whose promise cannot be awaited.
 *
 * The desktop host treats an unhandled rejection as fatal: `src/main.tsx` routes
 * `uncaughtException` and `unhandledRejection` to `shutdown`, which exits the
 * process. A fire-and-forget affordance must therefore report its failure through
 * the notice stream instead of leaving the promise floating. `TerminalService.dispatch`
 * is the same boundary for the terminal surfaces, and `RemoteWorkbenchController.#dispatch`
 * for the web companion's commands.
 */
export function notifyFailure(
  controller: Pick<WorkbenchService, 'notify'>,
  context: string,
): (error: unknown) => void {
  return (error) => { controller.notify('error', `${context}: ${errorMessage(error)}`) }
}
