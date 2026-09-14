import { WorkspaceClient } from './client.ts'
export { readConnectionSettings, workspaceSocketUrl, WorkspaceClient } from './client.ts'
export type { WorkspaceClientView, WorkspaceClientStatus } from './client.ts'
const client = new WorkspaceClient()
export function workspaceClient(): WorkspaceClient { return client }
