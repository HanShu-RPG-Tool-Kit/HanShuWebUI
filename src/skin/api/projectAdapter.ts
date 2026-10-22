import type { ProjectDirectory } from '../../project/serviceClient'
/**
 * Project service SkinApi — 数据落在当前工程 `.hanshu/skinmanager`
 */

import { getBoundProjectHandle } from '../../project'
import { SkinApiError } from '../contracts/types'
import type { SkinApi } from './SkinApi.ts'
import type {
  BatchPatchRequest,
  CreateFolderRequest,
  PatchEntryRequest,
  PatchFolderRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
} from '../contracts/types'
import { SkinLibrarySession } from '../local/SkinLibrary'
import { SCHEMA_VERSION, SKIN_ROOT } from '../local/paths'

let session: SkinLibrarySession | null = null
let sessionRoot: ProjectDirectory | null = null
/** Serialize init so concurrent list/create never sees a half-ready session. */
let sessionInit: Promise<SkinLibrarySession> | null = null
let initializingSession: SkinLibrarySession | null = null
let sessionGeneration = 0

async function getBoundSession(expectedRoot: ProjectDirectory | null): Promise<SkinLibrarySession> {
  const handle = getBoundProjectHandle()
  if (handle?.client !== expectedRoot?.client) {
    throw new SkinApiError({ code: 'PROJECT_CHANGED', message: '工程连接已变化，原皮肤草稿仍保留，请回到原工程后继续' })
  }
  if (!handle) {
    throw new SkinApiError({
      code: 'PROJECT_REQUIRED',
      message:
        '请先打开工程。',
    })
  }
  if (session && sessionRoot === handle && session.isReady()) {
    return session
  }
  if (sessionInit && sessionRoot === handle) {
    return sessionInit
  }

  session?.dispose()
  initializingSession?.dispose()
  session = null
  sessionRoot = handle
  const generation = ++sessionGeneration
  const created = new SkinLibrarySession(handle)
  initializingSession = created
  sessionInit = created
    .init()
    .then(() => {
      if (generation !== sessionGeneration || sessionRoot !== handle) {
        created.dispose()
        throw new SkinApiError({ code: 'PROJECT_CHANGED', message: '皮肤视图已刷新，请重试；原草稿仍保留' })
      }
      session = created
      sessionInit = null
      initializingSession = null
      return created
    })
    .catch((e) => {
      if (generation === sessionGeneration) {
        sessionInit = null
        initializingSession = null
        session = null
        sessionRoot = null
      }
      throw e
    })
  return sessionInit
}

export function resetProjectSkinSession(): void {
  sessionGeneration++
  session?.dispose()
  initializingSession?.dispose()
  session = null
  sessionRoot = null
  sessionInit = null
  initializingSession = null
}

export function createProjectSkinApi(): SkinApi {
  const root = getBoundProjectHandle()
  const getSession = () => getBoundSession(root)
  return {
    capabilities: async () => {
      try {
        const s = await getSession()
        return s.capabilities()
      } catch (e) {
        if (e instanceof SkinApiError && e.code === 'PROJECT_REQUIRED') {
          return {
            toolVersion: 'hanshu-project-client',
            apiVersion: '1',
            librarySchemaVersion: SCHEMA_VERSION,
            formatVersion: 1,
            importKinds: [
              'png-file',
              'png-url',
              'player-name',
              'skin-code',
              'skin-file',
            ],
            liveApply: false,
            features: { batchActive: true, httpApi: false },
          }
        }
        throw e
      }
    },

    listEntries: async (query) => (await getSession()).listEntries(query),
    getEntry: async (entryId) => (await getSession()).getEntry(entryId),
    listTags: async () => (await getSession()).listTags(),
    renameTag: async (from, to) => (await getSession()).renameTag(from, to),
    deleteTag: async (name) => (await getSession()).deleteTag(name),
    listFolders: async () => (await getSession()).listFolders(),
    createFolder: async (body: CreateFolderRequest) =>
      (await getSession()).createFolder(body),
    patchFolder: async (folderId: string, body: PatchFolderRequest) =>
      (await getSession()).patchFolder(folderId, body),
    deleteFolder: async (folderId, expected) =>
      (await getSession()).deleteFolder(folderId, expected),
    deleteEntriesInFolder: async (folderId, scope) =>
      (await getSession()).deleteEntriesInFolder(folderId, scope),

    saveEntry: async (body: SaveEntryRequest) =>
      (await getSession()).saveEntry(body),
    patchEntry: async (entryId: string, body: PatchEntryRequest) =>
      (await getSession()).patchEntry(entryId, body),
    batchPatchEntries: async (body: BatchPatchRequest) =>
      (await getSession()).batchPatchEntries(body),
    deleteEntry: async (entryId, revision) => (await getSession()).deleteEntry(entryId, revision),

    startImport: async (kind, text, model?: SkinModel) => {
      const s = await getSession()
      if (kind === 'skin-code') return s.startImportSkinCode(text)
      if (kind === 'png-url') return s.startImportFromUrl(text, model)
      if (kind === 'player-name') return s.startImportFromPlayerName(text)
      if (kind === 'skin-file') {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: '请使用文件选择导入 .skin / PNG / 皮肤码',
        })
      }
      throw new SkinApiError({
        code: 'BAD_REQUEST',
        message: `未知导入类型: ${kind}`,
      })
    },

    importFile: async () => {
      throw new SkinApiError({
        code: 'UNSUPPORTED',
        message: '请使用文件选择（浏览器无法读原生路径）',
      })
    },

    importFileBlob: async (file: File, model?: SkinModel) => {
      const s = await getSession()
      const buf = new Uint8Array(await file.arrayBuffer())
      const name = file.name.toLowerCase()
      if (name.endsWith('.txt') || name.endsWith('.skincode')) {
        const text = new TextDecoder().decode(buf)
        if (text.trim().startsWith('hanshu-skin:')) {
          return s.startImportSkinCode(text)
        }
      }
      if (
        name.endsWith('.skin.json') ||
        name.endsWith('.json') ||
        name.endsWith('.skin')
      ) {
        return s.startImportSkinFile(buf, file.name, model)
      }
      return s.startImportFromPng(buf, file.name, model)
    },

    getImport: async (jobId) => (await getSession()).getImport(jobId),
    listImports: async () => (await getSession()).listImports(),
    cancelImport: async (jobId) => (await getSession()).cancelImport(jobId),

    getPreviewUrl: async (skinId) => (await getSession()).getPreviewUrl(skinId),
    getSkinCode: async (skinId) => (await getSession()).getSkinCode(skinId),
    exportSkin: async (skinId, format) =>
      (await getSession()).exportSkin(skinId, format),
    exportEntry: async (entryId, format) =>
      (await getSession()).exportEntry(entryId, format),
    exportUsableManifest: async () =>
      (await getSession()).exportUsableManifest(),

    gcOrphans: async (onProgress) =>
      (await getSession()).gcOrphans(onProgress),

    saveExportFile: async (skinId, format) => {
      const s = await getSession()
      if (format === 'png') {
        const { pngBase64 } = await s.exportSkin(skinId, 'png')
        if (!pngBase64) return
        const bin = atob(pngBase64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/png' })
        triggerDownload(blob, `${skinId.slice(0, 8)}.png`)
        return
      }
      const { skinBase64 } = await s.exportSkin(skinId, 'skin')
      if (!skinBase64) return
      const bin = atob(skinBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      triggerDownload(
        new Blob([bytes], { type: 'application/octet-stream' }),
        `${skinId.slice(0, 8)}.skin`,
      )
    },

    subscribe: async (listener: (event: SkinEvent) => void) => {
      const s = await getSession()
      return s.subscribe(listener)
    },
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export const PROJECT_SKIN_ROOT_LABEL = SKIN_ROOT
