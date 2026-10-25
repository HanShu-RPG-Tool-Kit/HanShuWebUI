import type { AppWorkspaceId } from './types'

export type AppWorkspaceMeta = {
  id: AppWorkspaceId
  label: string
}

/** 应用级工作区列表（「剧本」由 App 单独挂载以保留 ref / 状态） */
export const APP_WORKSPACES: readonly AppWorkspaceMeta[] = [
  { id: 'stageplay', label: '剧本' },
  { id: 'gameplay', label: '游戏性' },
  { id: 'mc-skin', label: '皮肤管理器' },
] as const
