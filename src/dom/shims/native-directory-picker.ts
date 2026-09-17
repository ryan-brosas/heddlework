// Browser replacement for src/ui/native-directory-picker.ts: no native dialog host, so the
// desktop-only message from the folder-picker shim is the whole answer.
import { pickWorkspaceDirectory, type WorkspaceDirectoryPick } from './open-external.ts'

export async function pickProjectDirectory(): Promise<WorkspaceDirectoryPick> {
  return pickWorkspaceDirectory()
}
