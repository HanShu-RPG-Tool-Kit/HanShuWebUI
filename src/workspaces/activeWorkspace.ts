import type { AppWorkspaceId } from './types'

const STORAGE_KEY = 'hanshu.activeWorkspace.v1'
export const DEFAULT_WORKSPACE_ID: AppWorkspaceId = 'stageplay'

export function loadActiveWorkspaceId(
  validIds: readonly AppWorkspaceId[],
): AppWorkspaceId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    // Keep the selected application when upgrading local workspace preferences.
    const id = raw === 'script' ? 'stageplay' : raw === 'quest' || raw === 'progress-flow' ? 'gameplay' : raw
    if (id && validIds.includes(id)) return id
  } catch {
    // ignore
  }
  return validIds.includes(DEFAULT_WORKSPACE_ID)
    ? DEFAULT_WORKSPACE_ID
    : (validIds[0] ?? DEFAULT_WORKSPACE_ID)
}

export function saveActiveWorkspaceId(id: AppWorkspaceId) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // ignore
  }
}
