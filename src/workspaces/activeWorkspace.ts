import type { AppWorkspaceId } from './types'

const STORAGE_KEY = 'hanshu.activeWorkspace.v1'
export const DEFAULT_WORKSPACE_ID: AppWorkspaceId = 'script'

export function loadActiveWorkspaceId(
  validIds: readonly AppWorkspaceId[],
): AppWorkspaceId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && validIds.includes(raw)) return raw
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
