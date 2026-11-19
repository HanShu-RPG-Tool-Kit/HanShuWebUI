/**
 * 通用工作区文件桥（平台层）。
 *
 * 游戏性 / 视听这类「文件即内容」的工作区没有剧本那样的模型文档：Agent 只需要
 * 读写工程里的文本文件。这里把 `ProjectClient` 的文件树、本地草稿与保存快照
 * 适配成 `WorkspaceFileBridge`，工作区只需注册它。
 *
 * 约束：AgentHost 的读取是同步接口，因此保存文本在注册时预热到内存缓存；
 * 草稿写入仍然只走 `EditTransactions.stageWrite`，由用户保存时统一提交。
 */
import type { ProjectFileInfo } from '../plugin-sdk/types'
import type { WorkspaceFileBridge } from './projectHost'
import { notifyProjectSaved } from './projectHost'
import { getProjectClient } from './serviceClient'
import { flushProjectEditors } from './editorFlush'
import { subscribeProjectSession } from './projectSession'
import { getExtension } from '../workspace'

export type ProjectFileBridgeDeps = {
  workspaceId: string
  /** 当前工作区是否正在保存/提交（插件启动 Run 前读取） */
  isSaveBusy?: () => boolean
  /** 工作区当前选择的语言标签 */
  getLocale: () => string
  /** 用户当前正在查看的文档路径（工程相对）；没有返回 null */
  getActivePath?: () => string | null
  /** 插件锁定的路径；工作区据此把文件置为只读 */
  setReadOnlyPaths?: (paths: readonly string[]) => void
  /** 插件 Run 状态；工作区据此禁用保存 */
  setRunActive?: (active: boolean) => void
}

const TEXT_EXTENSIONS = new Set([
  '.hs', '.char', '.js', '.quest', '.level', '.nav', '.item', '.entity', '.kit',
  '.shop', '.actor', '.rep', '.tts', '.ttsservice', '.voice', '.lang',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.xml', '.svg',
  '.txt', '.md', '.csv',
])

function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(getExtension(path).toLowerCase())
}

export function createProjectFileBridge(deps: ProjectFileBridgeDeps): WorkspaceFileBridge {
  const workspaceId = deps.workspaceId
  const draftPaths = new Set<string>()
  const assetDrafts = new Map<string, string>()
  const savedCache = new Map<string, string | null>()
  const listeners = new Set<() => void>()
  const savedListeners = new Set<(paths: string[]) => void>()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const absoluteOf = (path: string): string => {
    const client = getProjectClient()
    if (!client) return path
    try {
      return client.root().resolve(path)
    } catch {
      return path
    }
  }

  const listTextPaths = (): string[] => {
    const client = getProjectClient()
    const paths = new Set<string>()
    if (client) {
      for (const entry of client.tree.entries) {
        if (entry.kind !== 'file') continue
        if (entry.path.startsWith('.hanshu/')) continue
        if (isTextPath(entry.path)) paths.add(entry.path)
      }
    }
    for (const path of draftPaths) paths.add(path)
    return [...paths]
  }

  const preload = async () => {
    const paths = listTextPaths()
    let index = 0
    const worker = async () => {
      while (index < paths.length) {
        const path = paths[index++]
        if (savedCache.has(path)) continue
        const client = getProjectClient()
        if (!client) return
        try {
          const text = await client.text(absoluteOf(path))
          savedCache.set(path, text)
        } catch {
          // 读失败不阻塞注册；readSavedText 时会再试
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  }

  const bridge: WorkspaceFileBridge = {
    workspaceId,
    listFiles(): ProjectFileInfo[] {
      return listTextPaths().map((path) => ({
        path,
        kind: path.includes('/lang_') || path.startsWith('assets/') ? 'asset' : 'source',
      }))
    },
    readCurrentText(path: string): string | null {
      const client = getProjectClient()
      if (!client) return null
      const absolute = absoluteOf(path)
      try {
        const staged = client.transactions.stagedText(absolute)
        if (typeof staged === 'string') return staged
      } catch {
        // 未绑定工程
      }
      const cached = savedCache.get(path)
      if (cached !== undefined) return cached
      return client.texts.get(absolute) ?? null
    },
    async readSavedText(path: string): Promise<string | null> {
      if (savedCache.has(path)) return savedCache.get(path) ?? null
      const client = getProjectClient()
      if (!client) return null
      try {
        const text = await client.text(absoluteOf(path))
        savedCache.set(path, text)
        return text
      } catch {
        return null
      }
    },
    hasDraft(path: string): boolean {
      return draftPaths.has(path) || assetDrafts.has(path)
    },
    listDraftPaths(): string[] {
      return [...draftPaths]
    },
    writeDraft(path: string, text: string): void {
      const client = getProjectClient()
      if (!client) throw new Error('尚未打开工程')
      const absolute = absoluteOf(path)
      client.transactions.stageWrite({ op: 'write', path: absolute, data: text })
      draftPaths.add(path)
      savedCache.delete(path)
      emit()
    },
    discardDraft(path: string): void {
      const client = getProjectClient()
      if (client) {
        try {
          client.transactions.discardDraftPaths([absoluteOf(path)])
        } catch {
          // 未绑定工程
        }
      }
      draftPaths.delete(path)
      assetDrafts.delete(path)
      savedCache.delete(path)
      emit()
    },
    async stageAssetText(path: string, text: string): Promise<void> {
      const client = getProjectClient()
      if (!client) throw new Error('尚未打开工程')
      const absolute = absoluteOf(path)
      client.transactions.stageWrite({ op: 'write', path: absolute, data: text })
      assetDrafts.set(path, text)
      savedCache.delete(path)
      emit()
    },
    stagedAssetText(path: string): string | undefined {
      const staged = assetDrafts.get(path)
      if (staged !== undefined) return staged
      const client = getProjectClient()
      if (!client) return undefined
      try {
        return client.transactions.stagedText(absoluteOf(path))
      } catch {
        return undefined
      }
    },
    discardAssetText(path: string): void {
      const client = getProjectClient()
      if (client) {
        try {
          client.transactions.discardDraftPaths([absoluteOf(path)])
        } catch {
          // 未绑定工程
        }
      }
      assetDrafts.delete(path)
      savedCache.delete(path)
      emit()
    },
    isHumanDirty(path: string): boolean {
      const client = getProjectClient()
      if (!client) return false
      try {
        return client.transactions.editorDirtyPaths().includes(absoluteOf(path))
      } catch {
        return false
      }
    },
    setReadOnlyPaths: deps.setReadOnlyPaths,
    setRunActive: deps.setRunActive,
    isSaveBusy: deps.isSaveBusy,
    getActivePath: () => deps.getActivePath?.() ?? null,
    getLocale: () => deps.getLocale(),
    flushEditors: () => flushProjectEditors(),
    subscribe(listener: () => void): () => void {
      const client = getProjectClient()
      if (!client) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const offTransactions = client.transactions.subscribe(listener)
      listeners.add(listener)
      return () => {
        offTransactions()
        listeners.delete(listener)
      }
    },
    onSaved(listener: (paths: string[]) => void): () => void {
      savedListeners.add(listener)
      return () => savedListeners.delete(listener)
    },
    notifySaved(paths?: string[]): void {
      const cleared = paths ?? [...draftPaths]
      for (const path of cleared) {
        draftPaths.delete(path)
        assetDrafts.delete(path)
        savedCache.delete(path)
      }
      for (const listener of savedListeners) listener(cleared)
      notifyProjectSaved(cleared)
      emit()
    },
  }

  void preload()
  subscribeProjectSession(() => {
    savedCache.clear()
    void preload()
  })

  return bridge
}
