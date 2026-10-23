/**
 * 刷新（F5）后恢复工程连接的意图记录。
 * 只存路径 / 地址 / 用户名等非机密信息；绝不存会话令牌或密码。
 */

export type LocalProjectResume = {
  kind: 'local'
  path: string
  projectId: string
  projectName: string
  at: number
}

export type RemoteProjectResume = {
  kind: 'remote'
  url: string
  username: string
  projectId: string
  projectName: string
  at: number
}

export type ProjectResume = LocalProjectResume | RemoteProjectResume

const KEY = 'hanshu.projectResume.v1'

function samePath(a: string, b: string) {
  const left = a.replace(/\\/g, '/').replace(/\/+$/, '')
  const right = b.replace(/\\/g, '/').replace(/\/+$/, '')
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    || left.toLowerCase() === right.toLowerCase()
}

export function loadProjectResume(): ProjectResume | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (value.kind === 'local') {
      if (typeof value.path !== 'string' || !value.path.trim()) return null
      if (typeof value.projectId !== 'string') return null
      if (typeof value.projectName !== 'string') return null
      if (!Number.isFinite(value.at)) return null
      return {
        kind: 'local',
        path: value.path,
        projectId: value.projectId,
        projectName: value.projectName,
        at: value.at as number,
      }
    }
    if (value.kind === 'remote') {
      if (typeof value.url !== 'string' || !value.url.trim()) return null
      if (typeof value.username !== 'string') return null
      if (typeof value.projectId !== 'string') return null
      if (typeof value.projectName !== 'string') return null
      if (!Number.isFinite(value.at)) return null
      return {
        kind: 'remote',
        url: value.url,
        username: value.username,
        projectId: value.projectId,
        projectName: value.projectName,
        at: value.at as number,
      }
    }
    return null
  } catch {
    return null
  }
}

export function rememberLocalProjectResume(value: Omit<LocalProjectResume, 'kind' | 'at'>) {
  const entry: LocalProjectResume = {
    kind: 'local',
    path: value.path,
    projectId: value.projectId,
    projectName: value.projectName,
    at: Date.now(),
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(entry))
  } catch { /* 隐私模式等不可写时跳过自动重连 */ }
}

export function rememberRemoteProjectResume(value: Omit<RemoteProjectResume, 'kind' | 'at'>) {
  const entry: RemoteProjectResume = {
    kind: 'remote',
    url: value.url,
    username: value.username,
    projectId: value.projectId,
    projectName: value.projectName,
    at: Date.now(),
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(entry))
  } catch { /* 隐私模式等不可写时跳过自动重连 */ }
}

/** 用户主动关闭工程时清除，避免下次打开页面又自动连上 */
export function clearProjectResume() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}

export function projectResumeMatchesLocal(resume: ProjectResume | null, path: string): boolean {
  return !!resume && resume.kind === 'local' && samePath(resume.path, path)
}
