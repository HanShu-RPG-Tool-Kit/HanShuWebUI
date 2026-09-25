import type { AppWorkspaceId } from './types'

export type AppWorkspaceMeta = {
  id: AppWorkspaceId
  label: string
}

/** 应用级工作区列表（「剧本」由 App 单独挂载以保留 ref / 状态） */
export const APP_WORKSPACES: readonly AppWorkspaceMeta[] = [
  { id: 'script', label: '剧本' },
  { id: 'mc-skin', label: 'MC皮肤' },
] as const
