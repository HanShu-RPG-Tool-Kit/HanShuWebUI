/**
 * Stageplay 工作区提供给平台/插件的文件通道（`WorkspaceFileBridge`）。
 *
 * 这里只认「路径 → 文本」：源文件逻辑名、工程里的 `.lang` 文本、资产路径。
 * 具体的剧本语法、语言键、导出规则不在这里 —— 那些属于插件侧。
 * 主体只需要注册这个 bridge，不 import 任何插件代码。
 */
import type { RefObject } from 'react'
import type { BoundProject } from '../../project'
import type { Workspace } from '../../workspace'
import type { ProjectFileInfo } from '../../plugin-sdk/types'
import type { WorkspaceFileBridge } from '../../project/projectHost'
import { getProjectClient } from '../../project/serviceClient'
import { discardLangDraft } from '../../i18n/langDraft'
import {
  createScript,
  findScript,
  findScriptByName,
  normalizeResourceName,
  sourcePathOf,
  getExtension,
} from '../../workspace'
import { isTextAssetName, parseTextFile } from '../../i18n/textMap'
import { parseLocaleAssetPath, TEXT_ASSET_EXTENSION } from '../../i18n/localeLayout'
import { getAssetBlob } from '../../assets/idb'

export type StageplayFileBridgeDeps = {
  workspaceRef: RefObject<Workspace>
  activeIdRef: RefObject<string | null>
  valueRef: RefObject<string>
  bufferOwnerRef: RefObject<string | null>
  projectRef: RefObject<BoundProject | null>
  commitWorkspace: (next: Workspace) => void
  flushEditorInto: (base: Workspace) => Workspace
  applyAgentFileWrite: (scriptId: string, content: string) => { file: string } | null
  agentSourceContent: (scriptId: string) => string | null
  stageLangWrite: (
    pkgId: string,
    path: string,
    map: Record<string, string>,
  ) => Promise<
    | { ok: true; localOnly: boolean; draft: true; saved: false; version: null }
    | { ok: false; error: string }
  >
  stagedLangText: (path: string) => string | undefined
  removeScriptSilent: (scriptId: string) => void
  /** 语言编辑器缓存刷新：写草稿后让已打开的译文编辑器看到新内容 */
  onAssetTextStaged?: (path: string, text: string) => void
  /** 当前界面选择的语言 */
  getLocale: () => string
  /** 插件锁定的路径；工作区据此把源文件/资产置为只读 */
  setReadOnlyPaths?: (paths: readonly string[]) => void
  /** 插件 Run 状态；工作区据此禁用保存 */
  setRunActive?: (active: boolean) => void
  /** 工作区是否正在保存（插件启动 Run 前读取） */
  isSaveBusy?: () => boolean
}

const SOURCE_EXTENSIONS = new Set([
  '.hs', '.char', '.js', '.quest', '.level', '.nav', '.item', '.entity', '.kit',
  '.shop', '.actor', '.rep', '.tts', '.ttsservice', '.voice',
])

export function createStageplayFileBridge(deps: StageplayFileBridgeDeps): WorkspaceFileBridge {
  const {
    workspaceRef,
    activeIdRef,
    valueRef,
    bufferOwnerRef,
    projectRef,
    commitWorkspace,
    flushEditorInto,
    applyAgentFileWrite,
    agentSourceContent,
    stageLangWrite,
    stagedLangText,
    removeScriptSilent,
    onAssetTextStaged,
    getLocale,
    setReadOnlyPaths,
    setRunActive,
    isSaveBusy,
  } = deps

  const draftPaths = new Set<string>()
  const listeners = new Set<() => void>()
  const savedListeners = new Set<(paths: string[]) => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const pkgIdOf = () => workspaceRef.current.packages[0]?.id ?? null

  const findScriptQuiet = (name: string) => {
    const workspace = workspaceRef.current
    try {
      return findScriptByName(workspace, name)?.script ?? null
    } catch {
      return (
        workspace.packages
          .flatMap((pkg) => pkg.scripts)
          .find((script) => script.name === name) ?? null
      )
    }
  }

  const sourcePath = (name: string): string | null => {
    const script = findScriptQuiet(name)
    return script ? sourcePathOf(script) : null
  }

  return {
    workspaceId: 'stageplay',
    listFiles: (): ProjectFileInfo[] => {
      const out = new Map<string, ProjectFileInfo>()
      for (const pkg of workspaceRef.current.packages) {
        for (const script of pkg.scripts) out.set(script.name, { path: script.name, kind: 'source' })
        for (const asset of pkg.assets) out.set(asset.path, { path: asset.path, kind: 'asset' })
      }
      for (const entry of projectRef.current?.handle.client?.tree.entries ?? []) {
        if (entry.kind !== 'file' || out.has(entry.path)) continue
        const ext = getExtension(entry.path)
        if (ext === `.${TEXT_ASSET_EXTENSION}` || isTextAssetName(entry.path)) {
          out.set(entry.path, { path: entry.path, kind: 'asset' })
        } else if (SOURCE_EXTENSIONS.has(ext)) {
          out.set(entry.path, { path: entry.path, kind: 'source' })
        }
      }
      return [...out.values()]
    },
    readCurrentText: (path) => {
      const script = findScriptQuiet(path)
      if (script) return agentSourceContent(script.id) ?? script.content
      const staged = stagedLangText(path)
      if (staged !== undefined) return staged
      const project = projectRef.current
      const client = project?.handle.client
      if (!client) return null
      const resolved = project!.handle.resolve(path)
      return client.texts.get(resolved) ?? client.texts.get(path) ?? null
    },
    readSavedText: async (path) => {
      const project = projectRef.current
      const client = project?.handle.client ?? null
      const scriptPath = sourcePath(path)
      if (client) {
        try {
          const resolved = project!.handle.resolve(scriptPath ?? path)
          if (client.entry(resolved)) {
            const { file } = await client.readSnapshot(resolved, false)
            return await file.text()
          }
        } catch {
          /* fall through to asset mirror */
        }
      }
      const pkgId = pkgIdOf()
      if (!pkgId) return null
      const blob = await getAssetBlob(pkgId, path)
      return blob ? blob.text() : null
    },
    hasDraft: (path) => draftPaths.has(path) || stagedLangText(path) !== undefined,
    listDraftPaths: () => [...draftPaths],
    writeDraft: (path, text) => {
      const existing = findScriptQuiet(path)
      if (existing) {
        applyAgentFileWrite(existing.id, text)
        draftPaths.add(path)
        notify()
        return
      }
      if (parseLocaleAssetPath(path)?.kind === 'text') {
        throw new Error('language files must be written through the asset text channel')
      }
      const name = normalizeResourceName(path)
      if (!name) throw new Error(`invalid file name: ${path}`)
      const base = flushEditorInto(workspaceRef.current)
      const pkgId = pkgIdOf()
      if (!pkgId) throw new Error('no project package available')
      const script = createScript(name, text)
      commitWorkspace({
        packages: base.packages.map((pkg) =>
          pkg.id === pkgId ? { ...pkg, scripts: [...pkg.scripts, script] } : pkg,
        ),
        activeScriptId: base.activeScriptId,
        activeAssetId: base.activeAssetId,
      })
      draftPaths.add(path)
      notify()
    },
    discardDraft: (path) => {
      draftPaths.delete(path)
      const script = findScriptQuiet(path)
      if (script) removeScriptSilent(script.id)
      notify()
    },
    stageAssetText: async (path, text) => {
      const pkgId = pkgIdOf()
      if (!pkgId) throw new Error('no project package available')
      const result = await stageLangWrite(pkgId, path, parseTextFile(text))
      if (!result.ok) throw new Error(result.error)
      draftPaths.add(path)
      onAssetTextStaged?.(path, text)
      notify()
    },
    stagedAssetText: (path) => stagedLangText(path),
    discardAssetText: (path) => {
      const client = getProjectClient()
      if (client) discardLangDraft(client.transactions, [path])
      draftPaths.delete(path)
      notify()
    },
    isHumanDirty: (path) => {
      const script = findScriptQuiet(path)
      if (script) {
        // 编辑器缓冲还没并回工作区时，用户手上的正文就是「人类未保存改动」
        if (bufferOwnerRef.current === script.id && valueRef.current !== script.content) return true
      }
      if (isTextAssetName(path) || path.toLowerCase().endsWith('.lang')) {
        return stagedLangText(path) !== undefined
      }
      return false
    },
    getActivePath: () => {
      const hit = findScript(workspaceRef.current, activeIdRef.current)
      return hit?.script.name ?? null
    },
    getLocale: () => getLocale(),
    setReadOnlyPaths: setReadOnlyPaths
      ? (paths) => setReadOnlyPaths(paths)
      : undefined,
    setRunActive: setRunActive
      ? (active) => setRunActive(active)
      : undefined,
    isSaveBusy: isSaveBusy ? () => isSaveBusy() : undefined,
    flushEditors: () => {
      commitWorkspace(flushEditorInto(workspaceRef.current))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onSaved: (listener) => {
      savedListeners.add(listener)
      return () => {
        savedListeners.delete(listener)
      }
    },
    notifySaved: (paths = []) => {
      for (const path of paths) draftPaths.delete(path)
      for (const listener of savedListeners) listener(paths)
      notify()
    },
  }
}
