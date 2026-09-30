import type { AppWorkspaceId } from './types'

export type AppWorkspaceMeta = {
  id: AppWorkspaceId
  label: string
}

/** 应用级工作区列表（「剧本」由 App 单独挂载以保留 ref / 状态） */
export const APP_WORKSPACES: readonly AppWorkspaceMeta[] = [
  { id: 'script', label: '剧本' },
  { id: 'progress-flow', label: '进度流程' },
  { id: 'tts-service', label: '配音服务' },
  { id: 'tts-plan', label: '配音方案' },
  { id: 'mc-skin', label: '皮肤管理器' },
  { id: 'mc-stream', label: '串流' },
] as const
