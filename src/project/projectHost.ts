/**
 * 工程级文件宿主（平台层）。
 *
 * 插件通过 `ProjectHost` 读写「当前工程」里的文本：读当前内容（含未保存编辑器、
 * 本地草稿）、读上次保存内容、写草稿、订阅变化。工作区只负责注册一个
 * `WorkspaceFileBridge`，不需要 import 任何插件代码；打开哪个工程、哪个窗口，
 * 由平台的工程会话决定。
 *
 * 设计约束（见 src/help/docs/agent-runtime.md 与设计文档「插件解耦」）：
 * - 平台只认 `plugin-sdk` 里的中立类型，**不得** import src/plugins。
 * - 插件的所有写入都只是本地草稿；用户保存时由工作区统一提交。
 */
import type { ProjectFileInfo, ProjectHost } from '../plugin-sdk/types'
import { getProjectSession, subscribeProjectSession } from './projectSession'

/** 一个工作区提供的文件读写通道（由工作区注册） */
export type WorkspaceFileBridge = {
  readonly workspaceId: string
  /** 工程里现有的文件（含未保存草稿新建的文件） */
  listFiles(): ProjectFileInfo[]
  /** 最新文本：编辑器缓冲 → 本地草稿 → 上次保存内容 */
  readCurrentText(path: string): string | null
  /** 上次保存的文本（变更对比与回滚的基线） */
  readSavedText(path: string): Promise<string | null>
  /** 该路径是否有插件写入、尚未保存的本地草稿 */
  hasDraft(path: string): boolean
  listDraftPaths(): string[]
  /** 写文本草稿（源文件等模型文档；同步更新工作区与编辑器） */
  writeDraft(path: string, text: string): void
  /** 撤掉插件写的草稿（回滚「本次新建」的文件） */
  discardDraft(path: string): void
  /** 写资产文本草稿（`.lang` 等 staged 草稿；异步落 mirror） */
  stageAssetText(path: string, text: string): Promise<void>
  /** 资产文本的 staged 草稿原文；没有返回 undefined */
  stagedAssetText(path: string): string | undefined
  /** 撤掉资产文本的 staged 草稿（回滚「本次新建」的语言文件） */
  discardAssetText?(path: string): void
  /** 该路径是否有「人类未保存」的编辑（编辑器缓冲；撤销预演用） */
  isHumanDirty?(path: string): boolean
  /** 插件当前锁住的路径（工作区据此把对应编辑器/资产置为只读） */
  setReadOnlyPaths?(paths: readonly string[]): void
  /** 插件是否有 Run 在运行（工作区据此禁用保存） */
  setRunActive?(active: boolean): void
  /** 工作区是否正在保存/提交（插件据此拒绝启动 Run） */
  isSaveBusy?(): boolean
  /** 用户当前正在查看的文档路径 */
  getActivePath(): string | null
  /** 工作区当前选择的语言标签（翻译/语言文件工具用） */
  getLocale(): string
  /** 把各编辑器缓冲 flush 进共享工程会话 */
  flushEditors(): void
  subscribe(listener: () => void): () => void
  onSaved(listener: (paths: string[]) => void): () => void
  /** 用户保存工程后调用：清掉已提交的插件草稿并通知订阅者 */
  notifySaved(paths?: string[]): void
}

let bridge: WorkspaceFileBridge | null = null
let bridgeScope: string | null = null
const listeners = new Set<() => void>()
let host: ProjectHost | null = null

function emit() {
  for (const listener of listeners) listener()
}

/**
 * 注册/替换当前工程的文件通道。返回注销函数（只有仍是同一个 bridge 时才真正清空，
 * 避免切工作区时旧的清理函数把新 bridge 摘掉）。
 */
export function registerWorkspaceFileBridge(
  next: WorkspaceFileBridge,
  scope: string,
): () => void {
  bridge = next
  bridgeScope = scope
  host = null
  emit()
  return () => {
    if (bridge !== next) return
    bridge = null
    bridgeScope = null
    host = null
    emit()
  }
}

export function getWorkspaceFileBridge(): WorkspaceFileBridge | null {
  return bridge
}

/** 当前工程的作用域标识（agent 数据库 / 会话按它隔离） */
export function projectScopeOf(): string {
  const session = getProjectSession()
  return (
    session.binding?.manifest.id ??
    session.workspace.packages[0]?.id ??
    'local'
  )
}

/** 通知插件：工程文件或草稿发生了变化（工作区在内容变化后调用） */
export function notifyProjectFiles(): void {
  emit()
}

export function getProjectHost(): ProjectHost | null {
  if (!bridge) return null
  if (host) return host
  const current = bridge
  const scope = bridgeScope ?? projectScopeOf()
  host = {
    scope,
    listFiles: () => current.listFiles(),
    readCurrentText: (path) => current.readCurrentText(path),
    readSavedText: (path) => current.readSavedText(path),
    hasDraft: (path) => current.hasDraft(path),
    listDraftPaths: () => current.listDraftPaths(),
    writeDraft: (path, text) => current.writeDraft(path, text),
    discardDraft: (path) => current.discardDraft(path),
    stageAssetText: (path, text) => current.stageAssetText(path, text),
    stagedAssetText: (path) => current.stagedAssetText(path),
    discardAssetText: (path) => current.discardAssetText?.(path),
    isHumanDirty: (path) => current.isHumanDirty?.(path) ?? false,
    setReadOnlyPaths: (paths) => current.setReadOnlyPaths?.(paths),
    setRunActive: (active) => current.setRunActive?.(active),
    isSaveBusy: () => current.isSaveBusy?.() ?? false,
    getActivePath: () => current.getActivePath(),
    getLocale: () => current.getLocale(),
    flushEditors: () => current.flushEditors(),
    subscribe: (listener) => {
      const offBridge = current.subscribe(listener)
      const offFiles = (() => {
        const wrapped = () => listener()
        listeners.add(wrapped)
        return () => listeners.delete(wrapped)
      })()
      return () => {
        offBridge()
        offFiles()
      }
    },
    onSaved: (listener) => current.onSaved(listener),
  }
  return host
}

/** 工程会话变化（打开/关闭工程、切换工作区）后刷新宿主 */
subscribeProjectSession(() => {
  host = null
  emit()
})
