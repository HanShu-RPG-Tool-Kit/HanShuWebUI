export type RecentLocalProject = { path: string; projectId: string; projectName: string; lastOpened: number }

const key = 'hanshu.recentLocalProjects.v1'

function samePath(a: string, b: string) {
  const left = a.replace(/\\/g, '/').replace(/\/+$/, '')
  const right = b.replace(/\\/g, '/').replace(/\/+$/, '')
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    || left.toLowerCase() === right.toLowerCase()
}

export function recentLocalProjects(): RecentLocalProject[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(values)) return []
    return values
      .filter((value): value is RecentLocalProject => !!value
        && typeof value.path === 'string' && value.path.trim().length > 0
        && typeof value.projectId === 'string'
        && typeof value.projectName === 'string'
        && Number.isFinite(value.lastOpened))
      .slice(0, 12)
      .map(value => ({
        path: value.path,
        projectId: value.projectId,
        projectName: value.projectName,
        lastOpened: value.lastOpened,
      }))
  } catch {
    return []
  }
}

export function rememberLocalProject(value: Omit<RecentLocalProject, 'lastOpened'>) {
  const entry: RecentLocalProject = {
    path: value.path,
    projectId: value.projectId,
    projectName: value.projectName || value.path.split(/[\\/]/).filter(Boolean).at(-1) || '本机工程',
    lastOpened: Date.now(),
  }
  try {
    localStorage.setItem(key, JSON.stringify([
      entry,
      ...recentLocalProjects().filter(item => !samePath(item.path, entry.path) && item.projectId !== entry.projectId),
    ].slice(0, 12)))
  } catch { /* Optional UI preference. */ }
}

export function removeRecentLocal(path: string) {
  try {
    localStorage.setItem(key, JSON.stringify(recentLocalProjects().filter(item => !samePath(item.path, path))))
  } catch { /* Optional UI preference. */ }
}
