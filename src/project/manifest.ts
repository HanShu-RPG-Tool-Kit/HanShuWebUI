/** project.json — 文件夹工程清单 */

export const PROJECT_FILE = 'project.json'
export const PROJECT_FORMAT_VERSION = 1 as const

export type ProjectManifest = {
  version: typeof PROJECT_FORMAT_VERSION
  /** 工程显示名（默认用文件夹名） */
  name: string
  /** 稳定包 id，用于 IndexedDB 资产键 */
  id: string
  /** 上次打开的脚本文件名（可选） */
  activeScript?: string | null
  collapsed?: boolean
  assetsCollapsed?: boolean
}

export function isProjectManifest(value: unknown): value is ProjectManifest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.version === PROJECT_FORMAT_VERSION &&
    typeof v.name === 'string' &&
    typeof v.id === 'string' &&
    v.id.length > 0
  )
}

export function createManifest(input: {
  name: string
  id: string
  activeScript?: string | null
  collapsed?: boolean
  assetsCollapsed?: boolean
}): ProjectManifest {
  return {
    version: PROJECT_FORMAT_VERSION,
    name: input.name.trim() || '未命名工程',
    id: input.id,
    activeScript: input.activeScript ?? null,
    collapsed: Boolean(input.collapsed),
    assetsCollapsed: Boolean(input.assetsCollapsed),
  }
}

export function parseManifestJson(raw: string): ProjectManifest {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('project.json 不是合法 JSON')
  }
  if (!isProjectManifest(data)) {
    throw new Error(
      'project.json 格式不正确（需要 version=1、name、id）',
    )
  }
  return data
}

export function serializeManifest(manifest: ProjectManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
